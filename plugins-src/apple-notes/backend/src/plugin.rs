use notemd_apple_notes::sync::{sync, SyncReport};
use notemd_plugin_sdk::{self as sdk, plugin_protocol as proto};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct State {
    auto_sync: bool,
    last_finished: Option<u64>,
    report: Option<SyncReport>,
    error: Option<String>,
    vault: Option<String>,
    #[serde(skip)]
    running: bool,
}

pub struct AppleNotesPlugin {
    state: Arc<Mutex<State>>,
    state_path: PathBuf,
    poller: Option<tokio::task::JoinHandle<()>>,
    jobs: Vec<tokio::task::JoinHandle<()>>,
}

impl AppleNotesPlugin {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            state_path: PathBuf::new(),
            poller: None,
            jobs: Vec::new(),
        }
    }

    fn status(&self) -> Result<Value, String> {
        let state = self.state.lock().map_err(|e| e.to_string())?;
        let mut value = serde_json::to_value(&*state).map_err(|e| e.to_string())?;
        value["running"] = json!(state.running);
        Ok(value)
    }

    fn start_sync(&mut self, host: &sdk::Host) -> Result<Value, String> {
        self.jobs.retain(|job| !job.is_finished());
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if state.running {
            return Err("Apple Notes sync is already running".into());
        }
        state.running = true;
        state.error = None;
        drop(state);
        self.jobs.push(tokio::spawn(run_sync(
            host.clone(),
            self.state.clone(),
            self.state_path.clone(),
        )));
        self.status()
    }
}

impl Drop for AppleNotesPlugin {
    fn drop(&mut self) {
        if let Some(task) = self.poller.take() {
            task.abort();
        }
        for task in self.jobs.drain(..) {
            task.abort();
        }
    }
}

fn save_state(path: &Path, state: &State) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing plugin data directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

async fn run_sync(host: sdk::Host, state: Arc<Mutex<State>>, state_path: PathBuf) {
    let result = async {
        let info = tokio::time::timeout(
            Duration::from_secs(15),
            host.request("host.vault.info", json!({})),
        )
        .await
        .map_err(|_| "Timed out resolving the active Vault".to_string())??;
        let vault = info["root"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Configure a Vault before syncing Apple Notes")?;
        let vault = PathBuf::from(vault);
        state.lock().map_err(|e| e.to_string())?.vault = Some(vault.to_string_lossy().into());
        tokio::task::spawn_blocking(move || sync(&vault, false))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    let mut state = state.lock().unwrap();
    state.running = false;
    state.last_finished = Some(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    );
    match result {
        Ok(report) => {
            state.report = Some(report);
            state.error = None;
        }
        Err(error) => {
            host.log_warn(&format!("apple-notes: {error}"));
            state.report = None;
            state.error = Some(error);
        }
    }
    if let Err(error) = save_state(&state_path, &state) {
        state.error = Some(format!("Could not save sync status: {error}"));
        host.log_warn(state.error.as_deref().unwrap());
    }
}

fn cli_value<'a>(context: &'a Value, key: &str) -> Option<&'a Value> {
    [
        format!("/cli/flags/{key}"),
        format!("/cli/args/{key}"),
        format!("/cli/{key}"),
        format!("/{key}"),
    ]
    .iter()
    .find_map(|pointer| context.pointer(pointer))
}

fn configured_vault() -> Option<PathBuf> {
    let path = std::env::var_os("NOTEMD_SHARED_CONFIG")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| {
                PathBuf::from(home).join("Library/Application Support/net.notemd.app/shared.json")
            })
        })?;
    let config: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    config["sotvault"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn cli_report(report: SyncReport) -> Value {
    json!({"__notemd_cli_result": {
        "exit_code": if report.complete { 0 } else { 4 },
        "message": format!("Apple Notes {}: {} created, {} updated, {} moved, {} deleted, {} unchanged, {} locked",
            if report.dry_run { "dry-run" } else { "sync" }, report.created, report.updated,
            report.moved, report.deleted, report.unchanged, report.locked),
        "data": report
    }})
}

impl sdk::NotemdPlugin for AppleNotesPlugin {
    fn initialize(&mut self, host: &sdk::Host, params: &proto::InitializeParams) {
        self.state_path = PathBuf::from(&params.data_dir).join("state.json");
        match std::fs::read(&self.state_path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(state) => *self.state.lock().unwrap() = state,
                Err(error) => {
                    self.state.lock().unwrap().error =
                        Some(format!("Could not read saved settings: {error}"));
                    host.log_warn(&format!(
                        "apple-notes: invalid settings; auto sync disabled: {error}"
                    ));
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                self.state.lock().unwrap().error =
                    Some(format!("Could not read saved settings: {error}"))
            }
        }
    }

    fn activate(&mut self, host: &sdk::Host, params: &proto::ActivateParams) -> Result<(), String> {
        if !cfg!(target_os = "macos") {
            return Err("Apple Notes sync is only available on macOS".into());
        }
        if params.event.starts_with("onCli:") {
            return Ok(());
        }
        if self.poller.is_some() {
            return Ok(());
        }
        let host = host.clone();
        let state = self.state.clone();
        let path = self.state_path.clone();
        self.poller = Some(tokio::spawn(async move {
            loop {
                let should_sync = {
                    let mut state = state.lock().unwrap();
                    if state.auto_sync && !state.running {
                        state.running = true;
                        state.error = None;
                        true
                    } else {
                        false
                    }
                };
                if should_sync {
                    run_sync(host.clone(), state.clone(), path.clone()).await;
                }
                tokio::time::sleep(Duration::from_secs(5 * 60)).await;
            }
        }));
        Ok(())
    }

    fn deactivate(&mut self, _host: &sdk::Host) {
        if let Some(task) = self.poller.take() {
            task.abort();
        }
        for task in self.jobs.drain(..) {
            task.abort();
        }
    }

    fn execute_command(
        &mut self,
        _host: &sdk::Host,
        params: &proto::ExecuteCommandParams,
    ) -> Result<Value, String> {
        match params.command.as_str() {
            "open" => Ok(json!({"ok": true})),
            "sync" => {
                let vault = cli_value(&params.context, "vault")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
                    .or_else(configured_vault)
                    .ok_or("No Vault configured; pass --vault PATH")?;
                let dry_run = cli_value(&params.context, "dry-run")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let report = sync(&vault, dry_run)?;
                Ok(cli_report(report))
            }
            other => Err(format!("Unknown Apple Notes command: {other}")),
        }
    }

    fn on_ui_request(
        &mut self,
        host: &sdk::Host,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        match method.strip_prefix("plugin.").unwrap_or(method) {
            "status" => self.status(),
            "sync" => self.start_sync(host),
            "settings" => {
                let enabled = params["auto_sync"]
                    .as_bool()
                    .ok_or("auto_sync must be a boolean")?;
                let mut state = self.state.lock().map_err(|e| e.to_string())?;
                let old = state.auto_sync;
                state.auto_sync = enabled;
                if let Err(error) = save_state(&self.state_path, &state) {
                    state.auto_sync = old;
                    return Err(error);
                }
                let start = enabled && !old && !state.running;
                drop(state);
                if start {
                    self.start_sync(host)
                } else {
                    self.status()
                }
            }
            other => Err(format!("Unknown Apple Notes request: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_envelope_keeps_partial_report_and_failure_exit_code() {
        let report = SyncReport {
            created: 2,
            complete: false,
            warnings: vec!["locked note".into()],
            ..Default::default()
        };
        let result = cli_report(report);
        assert_eq!(result["__notemd_cli_result"]["exit_code"], 4);
        assert_eq!(result["__notemd_cli_result"]["data"]["created"], 2);
        assert_eq!(
            result["__notemd_cli_result"]["data"]["warnings"][0],
            "locked note"
        );
        assert_eq!(
            cli_report(SyncReport {
                complete: true,
                ..Default::default()
            })["__notemd_cli_result"]["exit_code"],
            0
        );
    }
}
