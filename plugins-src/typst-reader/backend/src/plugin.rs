use crate::fonts::FontInstaller;
use crate::render::{self, RenderRequest};
use notemd_plugin_sdk as sdk;
use sdk::plugin_protocol as proto;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};

const MAX_READERS: usize = 16;

#[derive(Clone, Serialize)]
struct Progress {
    render_id: String,
    #[serde(flatten)]
    result: render::RenderResult,
    stage: &'static str,
    completed_chunks: usize,
    total_chunks: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct JobState {
    progress: Progress,
    temp_dir: Option<PathBuf>,
    // Keep successfully written pages alive after a later batch fails.
    retained_session: Option<Arc<render::RenderSession>>,
}

struct Reader {
    cancelled: AtomicBool,
    state: Mutex<JobState>,
}

impl Reader {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        let mut state = self.state.lock().unwrap();
        state.progress.stage = "cancelled";
        state.progress.result.busy = false;
        state.retained_session = None;
    }
}

struct Work {
    request: Option<RenderRequest>,
    session: Option<render::RenderSession>,
    readers: Vec<Arc<Reader>>,
}

impl Work {
    fn retain_readers(&mut self) -> bool {
        self.readers
            .retain(|r| !r.cancelled.load(Ordering::Relaxed));
        !self.readers.is_empty()
    }

    fn publish(&self, result: render::RenderResult, stage: &'static str) {
        for reader in &self.readers {
            let mut state = reader.state.lock().unwrap();
            if reader.cancelled.load(Ordering::Relaxed) {
                continue;
            }
            state.progress.result = result.clone();
            state.progress.stage = stage;
            if let Some(session) = &self.session {
                state.progress.completed_chunks = session.completed_chunks();
                state.progress.total_chunks = session.chunk_count();
                state.temp_dir = Some(session.temp_dir().to_path_buf());
            }
        }
    }

    fn fail(&mut self, error: String) {
        let retained = self.session.take().map(Arc::new);
        for reader in &self.readers {
            let mut state = reader.state.lock().unwrap();
            if reader.cancelled.load(Ordering::Relaxed) {
                continue;
            }
            state.progress.stage = "error";
            state.progress.error = Some(error.clone());
            state.progress.result.busy = false;
            state.retained_session = retained.clone();
        }
    }
}

// A single compiler owns the expensive work. All RPCs read small snapshots;
// opening/closing another view never waits for font discovery or compilation.
fn run_worker(cache_dir: PathBuf, receiver: Receiver<Work>, delay: std::time::Duration) {
    let mut queue = VecDeque::<Work>::new();
    loop {
        queue.retain_mut(Work::retain_readers);
        if queue.is_empty() {
            match receiver.recv() {
                Ok(work) => queue.push_back(work),
                Err(_) => return,
            }
        }
        queue.extend(
            receiver
                .try_iter()
                .take(MAX_READERS.saturating_sub(queue.len())),
        );
        let mut work = queue.pop_front().unwrap();
        if !work.retain_readers() {
            continue;
        }
        let step = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if let Some(request) = work.request.take() {
                work.publish(render::in_progress("", 0), "preparing");
                if !delay.is_zero() {
                    std::thread::sleep(delay);
                }
                let (result, session) = render::prepare(&cache_dir, &request)?;
                work.session = session;
                if result.complete {
                    work.publish(result, "complete");
                    return Ok(false);
                }
                // Readers have separate cancellation handles, but share the
                // actual compilation after image/content hashes agree.
                if let Some(existing) = queue.iter_mut().find(|item| {
                    item.session
                        .as_ref()
                        .is_some_and(|s| s.key() == result.cache_key)
                }) {
                    existing.retain_readers();
                    existing.readers.append(&mut work.readers);
                    // Cancellation belongs to a reader, never to a shared
                    // document. Rebuild progress from the compilation itself
                    // instead of copying a possibly cancelled subscription.
                    let session = existing.session.as_ref().unwrap();
                    existing.publish(
                        render::in_progress(session.key(), session.rendered_pages()),
                        "rendering",
                    );
                    return Ok(false);
                }
                work.publish(render::in_progress(&result.cache_key, 0), "rendering");
                return Ok(true);
            }
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }
            if !work.retain_readers() {
                return Ok(false);
            }
            let mut result = render::render_next(work.session.as_mut().unwrap())?;
            let complete = result.complete;
            result.busy = !complete;
            work.publish(result, if complete { "complete" } else { "rendering" });
            Ok::<bool, String>(!complete)
        }));
        match step {
            Ok(Ok(true)) => queue.push_back(work),
            Ok(Ok(false)) => {}
            Ok(Err(error)) => work.fail(error),
            Err(_) => work.fail("The typesetting worker could not finish this document.".into()),
        }
    }
}

pub struct TypstReaderPlugin {
    data_dir: PathBuf,
    font_installer: FontInstaller,
    readers: HashMap<String, Arc<Reader>>,
    worker: Option<SyncSender<Work>>,
    worker_thread: Option<std::thread::JoinHandle<()>>,
    next_id: u64,
    #[cfg(test)]
    render_delay: std::time::Duration,
}

impl TypstReaderPlugin {
    pub fn new() -> Self {
        Self {
            data_dir: std::env::temp_dir().join("notemd-typst-reader-uninitialized"),
            font_installer: FontInstaller::new(),
            readers: HashMap::new(),
            worker: None,
            worker_thread: None,
            next_id: 0,
            #[cfg(test)]
            render_delay: std::time::Duration::ZERO,
        }
    }

    fn start_worker(&mut self) -> Result<&SyncSender<Work>, String> {
        if self.worker.is_none() {
            let (sender, receiver) = mpsc::sync_channel(MAX_READERS);
            let cache = self.data_dir.join("cache");
            let delay = std::time::Duration::ZERO;
            #[cfg(test)]
            let delay = self.render_delay.max(delay);
            let thread = std::thread::Builder::new()
                .name("notemd-typst-render".into())
                .spawn(move || run_worker(cache, receiver, delay))
                .map_err(|error| format!("start render worker: {error}"))?;
            self.worker = Some(sender);
            self.worker_thread = Some(thread);
        }
        Ok(self.worker.as_ref().unwrap())
    }

    fn handle_ui_request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        match method.strip_prefix("plugin.").unwrap_or(method) {
            "fonts-status" => serde_json::to_value(self.font_installer.status())
                .map_err(|error| error.to_string()),
            "fonts-download" => {
                let style = params
                    .get("style")
                    .and_then(Value::as_str)
                    .ok_or("fonts-download needs style")?;
                serde_json::to_value(self.font_installer.start(style)?)
                    .map_err(|error| error.to_string())
            }
            "render" => {
                let request: RenderRequest = serde_json::from_value(params)
                    .map_err(|error| format!("invalid render request: {error}"))?;
                self.readers
                    .retain(|_, reader| !reader.cancelled.load(Ordering::Relaxed));
                if self.readers.len() >= MAX_READERS {
                    return Err(
                        "Too many reading views are open. Close a reading view and retry.".into(),
                    );
                }
                self.next_id += 1;
                let id = format!("{}-{}", std::process::id(), self.next_id);
                let progress = Progress {
                    render_id: id.clone(),
                    result: render::in_progress("", 0),
                    stage: "queued",
                    completed_chunks: 0,
                    total_chunks: 0,
                    error: None,
                };
                let reader = Arc::new(Reader {
                    cancelled: AtomicBool::new(false),
                    state: Mutex::new(JobState {
                        progress: progress.clone(),
                        temp_dir: None,
                        retained_session: None,
                    }),
                });
                self.start_worker()?
                    .try_send(Work {
                        request: Some(request),
                        session: None,
                        readers: vec![reader.clone()],
                    })
                    .map_err(|_| "The typesetting queue is busy. Please retry.".to_string())?;
                self.readers.insert(id, reader);
                serde_json::to_value(progress).map_err(|error| error.to_string())
            }
            "render-next" => {
                let id = params
                    .get("render_id")
                    .and_then(Value::as_str)
                    .ok_or("render-next needs render_id")?;
                let reader = self
                    .readers
                    .get(id)
                    .ok_or("render session is unavailable")?;
                serde_json::to_value(&reader.state.lock().unwrap().progress)
                    .map_err(|error| error.to_string())
            }
            "cancel" => {
                let id = params
                    .get("render_id")
                    .and_then(Value::as_str)
                    .ok_or("cancel needs render_id")?;
                if let Some(reader) = self.readers.remove(id) {
                    reader.cancel();
                }
                Ok(json!({ "ok": true }))
            }
            "page" => {
                let key = params
                    .get("cache_key")
                    .and_then(Value::as_str)
                    .ok_or("page needs cache_key")?;
                let page_index = params
                    .get("page")
                    .and_then(Value::as_u64)
                    .and_then(|page| usize::try_from(page).ok())
                    .ok_or("page needs a non-negative page")?;
                let cache_dir = self.data_dir.join("cache");
                let partial = self.readers.values().find_map(|reader| {
                    let state = reader.state.lock().unwrap();
                    (state.progress.result.cache_key == key
                        && page_index < state.progress.result.page_count
                        && !state.progress.result.complete)
                        .then(|| {
                            state
                                .temp_dir
                                .clone()
                                .map(|path| (path, state.progress.result.page_count))
                        })
                        .flatten()
                });
                let svg = if let Some((path, count)) = partial {
                    render::in_progress_page(&cache_dir, key, &path, count, page_index)?
                } else {
                    render::page(&cache_dir, key, page_index)?
                };
                Ok(json!({ "svg": svg }))
            }
            other => Err(format!("unknown ui method '{other}'")),
        }
    }
}

impl Drop for TypstReaderPlugin {
    fn drop(&mut self) {
        for reader in self.readers.values() {
            reader.cancel();
        }
        // Closing the channel wakes an idle worker; a busy worker observes
        // cancellation between batches and releases temporary files itself.
        self.worker.take();
        if let Some(thread) = self.worker_thread.take() {
            let _ = thread.join();
        }
    }
}

impl sdk::NotemdPlugin for TypstReaderPlugin {
    fn initialize(&mut self, _host: &sdk::Host, params: &proto::InitializeParams) {
        self.data_dir = PathBuf::from(&params.data_dir);
    }

    fn activate(
        &mut self,
        _host: &sdk::Host,
        _params: &proto::ActivateParams,
    ) -> Result<(), String> {
        Ok(())
    }

    fn deactivate(&mut self, _host: &sdk::Host) {
        for reader in self.readers.values() {
            reader.cancel();
        }
    }

    fn execute_command(
        &mut self,
        _host: &sdk::Host,
        params: &proto::ExecuteCommandParams,
    ) -> Result<Value, String> {
        Err(format!("unknown command '{}'", params.command))
    }

    fn on_ui_request(
        &mut self,
        _host: &sdk::Host,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.handle_ui_request(method, params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, Instant};

    fn try_open(
        plugin: &mut TypstReaderPlugin,
        root: &std::path::Path,
        content: &str,
    ) -> Result<Value, String> {
        let source = root.join("book.typeset.md");
        fs::write(&source, content).unwrap();
        plugin.handle_ui_request(
            "render",
            json!({ "uri": source, "content": content, "vault_root": root }),
        )
    }

    fn open(plugin: &mut TypstReaderPlugin, root: &std::path::Path, content: &str) -> Value {
        try_open(plugin, root, content).unwrap()
    }

    fn wait(
        plugin: &mut TypstReaderPlugin,
        id: &Value,
        condition: impl Fn(&Value) -> bool,
    ) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let progress = plugin
                .handle_ui_request("render-next", json!({ "render_id": id }))
                .unwrap();
            assert_ne!(progress["stage"], "error", "{progress}");
            if condition(&progress) {
                return progress;
            }
            assert!(
                Instant::now() < deadline,
                "render worker did not finish: {progress}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn font_download_rpc_accepts_only_fixed_bundle_names() {
        let mut plugin = TypstReaderPlugin::new();
        assert_eq!(
            plugin.handle_ui_request("fonts-status", json!({})).unwrap()["stage"],
            "idle"
        );
        assert!(plugin
            .handle_ui_request("fonts-download", json!({ "style": "../escape" }))
            .is_err());
    }

    #[test]
    fn prepares_off_thread_and_serves_pages_during_continuation() {
        let root = tempfile::tempdir().unwrap();
        let mut plugin = TypstReaderPlugin::new();
        plugin.data_dir = root.path().join("data");
        plugin.render_delay = Duration::from_millis(200);
        let started = Instant::now();
        let opened = open(
            &mut plugin,
            root.path(),
            "# First\n\nPreview.\n\n# Second\n\nContinuation.\n",
        );
        assert!(started.elapsed() < Duration::from_millis(100));
        assert_eq!(opened["stage"], "queued");
        let id = &opened["render_id"];
        let first = wait(&mut plugin, id, |p| p["page_count"].as_u64().unwrap() > 0);
        assert_eq!(first["complete"], false);
        let started = Instant::now();
        let page = plugin
            .handle_ui_request("page", json!({"cache_key": first["cache_key"], "page": 0}))
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(page["svg"].as_str().unwrap().starts_with("<svg"));
        wait(&mut plugin, id, |p| p["complete"] == true);
    }

    #[test]
    fn duplicate_readers_share_work_and_cancel_independently() {
        let root = tempfile::tempdir().unwrap();
        let mut plugin = TypstReaderPlugin::new();
        plugin.data_dir = root.path().join("data");
        plugin.render_delay = Duration::from_millis(50);
        let content = "# First\n\nPreview.\n\n# Second\n\nContinuation.\n";
        let first = open(&mut plugin, root.path(), content);
        let second = open(&mut plugin, root.path(), content);
        assert_ne!(first["render_id"], second["render_id"]);
        let progress = wait(&mut plugin, &first["render_id"], |p| {
            p["page_count"].as_u64().unwrap() > 0
        });
        wait(&mut plugin, &second["render_id"], |p| {
            p["page_count"].as_u64().unwrap() > 0
        });
        let first_temp = plugin.readers[first["render_id"].as_str().unwrap()]
            .state
            .lock()
            .unwrap()
            .temp_dir
            .clone();
        let second_temp = plugin.readers[second["render_id"].as_str().unwrap()]
            .state
            .lock()
            .unwrap()
            .temp_dir
            .clone();
        assert!(first_temp.is_some());
        assert_eq!(
            first_temp, second_temp,
            "duplicate readers must share one session, not merely the final cache key"
        );
        plugin
            .handle_ui_request("cancel", json!({"render_id": first["render_id"]}))
            .unwrap();
        let finished = wait(&mut plugin, &second["render_id"], |p| p["complete"] == true);
        assert_eq!(finished["cache_key"], progress["cache_key"]);
        assert!(finished["page_count"].as_u64().unwrap() > 0);
        let cache = plugin.data_dir.join("cache");
        let temporary: Vec<_> = fs::read_dir(cache)
            .unwrap()
            .flat_map(|dir| fs::read_dir(dir.unwrap().path()).unwrap())
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".tmp-")
            })
            .collect();
        assert!(temporary.is_empty());
    }

    #[test]
    fn preparation_failure_is_a_terminal_status() {
        let root = tempfile::tempdir().unwrap();
        let mut plugin = TypstReaderPlugin::new();
        plugin.data_dir = root.path().join("data");
        let opened = open(
            &mut plugin,
            root.path(),
            "![](https://example.com/image.png)",
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let progress = plugin
                .handle_ui_request("render-next", json!({"render_id": opened["render_id"]}))
                .unwrap();
            if progress["stage"] == "error" {
                assert_eq!(progress["busy"], false);
                assert!(progress["error"].as_str().unwrap().contains("image"));
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_failed_continuation_keeps_published_pages_readable_until_cancelled() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("broken.svg"), "not an SVG image").unwrap();
        let mut plugin = TypstReaderPlugin::new();
        plugin.data_dir = root.path().join("data");
        let opened = open(
            &mut plugin,
            root.path(),
            "# First\n\nReadable page.\n\n# Second\n\n![](broken.svg)\n",
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let progress = plugin
                .handle_ui_request("render-next", json!({"render_id": opened["render_id"]}))
                .unwrap();
            if progress["stage"] == "error" {
                assert!(progress["page_count"].as_u64().unwrap() > 0);
                let page = plugin
                    .handle_ui_request(
                        "page",
                        json!({"cache_key": progress["cache_key"], "page": 0}),
                    )
                    .unwrap();
                assert!(page["svg"].as_str().unwrap().starts_with("<svg"));
                plugin
                    .handle_ui_request("cancel", json!({"render_id": opened["render_id"]}))
                    .unwrap();
                break;
            }
            assert!(
                Instant::now() < deadline,
                "missing expected compile failure: {progress}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn cancellation_releases_incomplete_cache() {
        let root = tempfile::tempdir().unwrap();
        let mut plugin = TypstReaderPlugin::new();
        plugin.data_dir = root.path().join("data");
        plugin.render_delay = Duration::from_millis(100);
        let opened = open(
            &mut plugin,
            root.path(),
            "# First\n\nPreview.\n\n# Second\n\nContinuation.\n",
        );
        wait(&mut plugin, &opened["render_id"], |p| {
            p["page_count"].as_u64().unwrap() > 0
        });
        plugin
            .handle_ui_request("cancel", json!({"render_id": opened["render_id"]}))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let temporary = fs::read_dir(plugin.data_dir.join("cache"))
                .unwrap()
                .flat_map(|dir| fs::read_dir(dir.unwrap().path()).unwrap())
                .any(|entry| {
                    entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .contains(".tmp-")
                });
            if !temporary {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn reader_limit_keeps_completed_progress_until_the_reader_closes() {
        let root = tempfile::tempdir().unwrap();
        let mut plugin = TypstReaderPlugin::new();
        plugin.data_dir = root.path().join("data");
        let content = "# Book\n\nA short complete book.\n";
        let first = open(&mut plugin, root.path(), content);
        let completed = wait(&mut plugin, &first["render_id"], |p| p["complete"] == true);
        for _ in 1..MAX_READERS {
            let next = open(&mut plugin, root.path(), content);
            wait(&mut plugin, &next["render_id"], |p| p["complete"] == true);
        }
        let error = try_open(&mut plugin, root.path(), content).unwrap_err();
        assert!(error.contains("Too many reading views"), "{error}");
        let still_available = plugin
            .handle_ui_request("render-next", json!({"render_id": first["render_id"]}))
            .unwrap();
        assert_eq!(still_available, completed);
        plugin
            .handle_ui_request("cancel", json!({"render_id": first["render_id"]}))
            .unwrap();
        let replacement = open(&mut plugin, root.path(), content);
        wait(&mut plugin, &replacement["render_id"], |p| {
            p["complete"] == true
        });
    }

    #[test]
    fn dropping_plugin_waits_for_incomplete_cache_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let mut plugin = TypstReaderPlugin::new();
        plugin.data_dir = root.path().join("data");
        plugin.render_delay = Duration::from_millis(200);
        let opened = open(
            &mut plugin,
            root.path(),
            "# First\n\nReady.\n\n# Second\n\nPending.\n",
        );
        let progress = wait(&mut plugin, &opened["render_id"], |p| {
            p["page_count"].as_u64().unwrap() > 0
        });
        assert_eq!(progress["complete"], false);
        let temporary = plugin.readers[opened["render_id"].as_str().unwrap()]
            .state
            .lock()
            .unwrap()
            .temp_dir
            .clone()
            .unwrap();
        assert!(temporary.is_dir());
        drop(plugin);
        // No polling after Drop: returning is the cleanup guarantee required
        // before the plugin process's main function exits.
        assert!(
            !temporary.exists(),
            "shutdown left temporary pages at {}",
            temporary.display()
        );
    }

    #[test]
    fn cancelled_open_bursts_are_bounded_and_can_retry_after_backpressure() {
        let root = tempfile::tempdir().unwrap();
        let mut plugin = TypstReaderPlugin::new();
        plugin.data_dir = root.path().join("data");
        plugin.render_delay = Duration::from_millis(200);
        let content = "# Book\n\nQueued content.\n";
        let first = open(&mut plugin, root.path(), content);
        wait(&mut plugin, &first["render_id"], |p| {
            p["stage"] == "preparing"
        });
        let reader = plugin.readers[first["render_id"].as_str().unwrap()].clone();
        // Hold publication at the end of preparation so the consumer cannot
        // drain the channel while cancelled requests are enqueued.
        let guard = reader.state.lock().unwrap();
        for _ in 0..MAX_READERS {
            let queued = open(&mut plugin, root.path(), content);
            plugin
                .handle_ui_request("cancel", json!({"render_id": queued["render_id"]}))
                .unwrap();
        }
        let started = Instant::now();
        let error = try_open(&mut plugin, root.path(), content).unwrap_err();
        assert!(error.contains("queue is busy"), "{error}");
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "queue admission must not block the RPC thread"
        );
        assert_eq!(
            plugin.readers.len(),
            1,
            "rejected and cancelled opens must not leak reader handles"
        );
        drop(guard);
        let deadline = Instant::now() + Duration::from_secs(5);
        let retried = loop {
            match try_open(&mut plugin, root.path(), content) {
                Ok(opened) => break opened,
                Err(error) => {
                    assert!(error.contains("queue is busy"), "{error}");
                    assert!(Instant::now() < deadline, "queue never accepted a retry");
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        };
        let complete = wait(&mut plugin, &retried["render_id"], |p| {
            p["complete"] == true
        });
        assert!(complete["page_count"].as_u64().unwrap() > 0);
    }
}
