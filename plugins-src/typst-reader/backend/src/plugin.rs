use crate::render::{self, RenderRequest};
use notemd_plugin_sdk as sdk;
use sdk::plugin_protocol as proto;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, TryRecvError};

struct RenderJob {
    receiver: Receiver<Result<(render::RenderSession, render::RenderResult), String>>,
    page_count: usize,
    temp_dir: PathBuf,
}

pub struct TypstReaderPlugin {
    data_dir: PathBuf,
    sessions: HashMap<String, render::RenderSession>,
    jobs: HashMap<String, RenderJob>,
    #[cfg(test)]
    render_delay: std::time::Duration,
}

impl TypstReaderPlugin {
    pub fn new() -> Self {
        Self {
            data_dir: std::env::temp_dir().join("notemd-typst-reader-uninitialized"),
            sessions: HashMap::new(),
            jobs: HashMap::new(),
            #[cfg(test)]
            render_delay: std::time::Duration::ZERO,
        }
    }

    fn handle_ui_request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        match method.strip_prefix("plugin.").unwrap_or(method) {
            "render" => {
                let request: RenderRequest = serde_json::from_value(params)
                    .map_err(|error| format!("invalid render request: {error}"))?;
                let (result, session) = render::prepare(&self.data_dir.join("cache"), &request)?;
                if let Some(session) = session {
                    if let Some(job) = self.jobs.get(&result.cache_key) {
                        return serde_json::to_value(render::in_progress(
                            &result.cache_key,
                            job.page_count,
                        ))
                        .map_err(|error| error.to_string());
                    }
                    if let Some(existing) = self.sessions.get(&result.cache_key) {
                        return serde_json::to_value(render::in_progress(
                            &result.cache_key,
                            existing.page_count(),
                        ))
                        .map_err(|error| error.to_string());
                    }
                    if self.sessions.len() >= 4 && !self.sessions.contains_key(session.key()) {
                        if let Some(oldest) = self.sessions.keys().next().cloned() {
                            self.sessions.remove(&oldest);
                        }
                    }
                    self.sessions.insert(result.cache_key.clone(), session);
                }
                serde_json::to_value(result).map_err(|error| error.to_string())
            }
            "render-next" => {
                let key = params
                    .get("cache_key")
                    .and_then(Value::as_str)
                    .ok_or("render-next needs cache_key")?;
                if let Some(job) = self.jobs.remove(key) {
                    match job.receiver.try_recv() {
                        Ok(Ok((session, result))) => {
                            if !result.complete {
                                self.sessions.insert(key.to_string(), session);
                            }
                            return serde_json::to_value(result).map_err(|error| error.to_string());
                        }
                        Ok(Err(error)) => return Err(error),
                        Err(TryRecvError::Empty) => {
                            let result = render::in_progress(key, job.page_count);
                            self.jobs.insert(key.to_string(), job);
                            return serde_json::to_value(result).map_err(|error| error.to_string());
                        }
                        Err(TryRecvError::Disconnected) => {
                            return Err("render worker stopped unexpectedly".into());
                        }
                    }
                }
                let mut session = self
                    .sessions
                    .remove(key)
                    .ok_or("render session is unavailable")?;
                let page_count = session.page_count();
                let temp_dir = session.temp_dir().to_path_buf();
                let (sender, receiver) = mpsc::sync_channel(1);
                #[cfg(test)]
                let render_delay = self.render_delay;
                std::thread::Builder::new()
                    .name("notemd-typst-render".into())
                    .spawn(move || {
                        #[cfg(test)]
                        std::thread::sleep(render_delay);
                        let result =
                            render::render_next(&mut session).map(|progress| (session, progress));
                        let _ = sender.send(result);
                    })
                    .map_err(|error| format!("start render worker: {error}"))?;
                self.jobs.insert(
                    key.to_string(),
                    RenderJob {
                        receiver,
                        page_count,
                        temp_dir,
                    },
                );
                serde_json::to_value(render::in_progress(key, page_count))
                    .map_err(|error| error.to_string())
            }
            "page" => {
                let key = params
                    .get("cache_key")
                    .and_then(Value::as_str)
                    .ok_or("page needs cache_key")?;
                let page_index = params
                    .get("page")
                    .and_then(Value::as_u64)
                    .ok_or("page needs a non-negative page")?
                    as usize;
                let cache_dir = self.data_dir.join("cache");
                let svg = if let Some(session) = self.sessions.get(key) {
                    render::session_page(session, page_index)?
                } else if let Some(job) = self.jobs.get(key) {
                    render::in_progress_page(
                        &cache_dir,
                        key,
                        &job.temp_dir,
                        job.page_count,
                        page_index,
                    )?
                } else {
                    render::page(&cache_dir, key, page_index)?
                };
                Ok(json!({ "svg": svg }))
            }
            other => Err(format!("unknown ui method '{other}'")),
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

    fn deactivate(&mut self, _host: &sdk::Host) {}

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
    use serde_json::json;
    use std::fs;
    use std::time::{Duration, Instant};

    fn progress(plugin: &mut TypstReaderPlugin, key: &str) -> render::RenderResult {
        serde_json::from_value(
            plugin
                .handle_ui_request("render-next", json!({ "cache_key": key }))
                .unwrap(),
        )
        .unwrap()
    }

    fn wait_for_batch(plugin: &mut TypstReaderPlugin, key: &str) -> render::RenderResult {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let result = progress(plugin, key);
            if !result.busy {
                return result;
            }
            assert!(Instant::now() < deadline, "render worker did not finish");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn serves_an_existing_page_while_the_next_batch_is_rendering() {
        let root = tempfile::tempdir().unwrap();
        let book = root.path().join("book");
        fs::create_dir(&book).unwrap();
        let source = book.join("book.typeset.md");
        let content = "# First\n\nPreview.\n\n# Second\n\nContinuation paragraph.\n";
        fs::write(&source, content).unwrap();
        let mut plugin = TypstReaderPlugin::new();
        plugin.data_dir = root.path().join("data");
        plugin.render_delay = Duration::from_millis(250);
        let prepared: render::RenderResult = serde_json::from_value(
            plugin
                .handle_ui_request(
                    "render",
                    json!({
                        "uri": source,
                        "content": content,
                        "vault_root": root.path(),
                        "book_style": "wonderous-book"
                    }),
                )
                .unwrap(),
        )
        .unwrap();

        assert!(progress(&mut plugin, &prepared.cache_key).busy);
        let first = wait_for_batch(&mut plugin, &prepared.cache_key);
        assert!(!first.complete);
        assert!(first.page_count > 0);
        assert!(progress(&mut plugin, &prepared.cache_key).busy);

        let started = Instant::now();
        let page = plugin
            .handle_ui_request(
                "page",
                json!({ "cache_key": prepared.cache_key, "page": 0 }),
            )
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(page["svg"].as_str().unwrap().starts_with("<svg"));

        while plugin.jobs.contains_key(&prepared.cache_key) {
            let _ = wait_for_batch(&mut plugin, &prepared.cache_key);
        }
    }
}
