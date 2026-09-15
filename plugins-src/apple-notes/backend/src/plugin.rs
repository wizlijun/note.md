use notemd_apple_notes::sync::{
    read_persisted_state, sync_recorded, write_persisted_state, PersistedState, SyncReport,
};
use notemd_plugin_sdk::{self as sdk, plugin_protocol as proto};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    #[serde(skip)]
    ready: bool,
}

impl State {
    fn persisted(&self) -> PersistedState {
        PersistedState {
            auto_sync: self.auto_sync,
            last_finished: self.last_finished,
            report: self.report.clone(),
            error: self.error.clone(),
        }
    }

    fn apply(&mut self, saved: PersistedState) {
        self.auto_sync = saved.auto_sync;
        self.last_finished = saved.last_finished;
        self.report = saved.report;
        self.error = saved.error;
    }
}

pub struct AppleNotesPlugin {
    state: Arc<Mutex<State>>,
    legacy_state_path: PathBuf,
    poller: Option<tokio::task::JoinHandle<()>>,
    jobs: Vec<tokio::task::JoinHandle<()>>,
}

impl AppleNotesPlugin {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            legacy_state_path: PathBuf::new(),
            poller: None,
            jobs: Vec::new(),
        }
    }

    fn status(&self) -> Result<Value, String> {
        refresh_from_vault(&self.state)?;
        let state = self.state.lock().map_err(|e| e.to_string())?;
        let mut value = serde_json::to_value(&*state).map_err(|e| e.to_string())?;
        value["running"] = json!(state.running);
        value["ready"] = json!(state.ready);
        Ok(value)
    }

    fn start_sync(&mut self, host: &sdk::Host) -> Result<Value, String> {
        self.jobs.retain(|job| !job.is_finished());
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if state.running {
            return Err("Apple Notes sync is already running".into());
        }
        if !state.ready {
            return Err("Apple Notes state is still loading".into());
        }
        state.running = true;
        state.error = None;
        drop(state);
        self.jobs
            .push(tokio::spawn(run_sync(host.clone(), self.state.clone())));
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

fn refresh_from_vault(state: &Arc<Mutex<State>>) -> Result<(), String> {
    let (vault, running) = {
        let state = state.lock().map_err(|e| e.to_string())?;
        (state.vault.clone(), state.running)
    };
    let Some(vault) = vault else {
        return Ok(());
    };
    if running {
        return Ok(());
    }
    let saved = read_persisted_state(Path::new(&vault))?.unwrap_or_default();
    let mut state = state.lock().map_err(|e| e.to_string())?;
    if !state.running {
        state.apply(saved);
    }
    Ok(())
}

async fn resolve_vault(host: &sdk::Host) -> Result<PathBuf, String> {
    let info = tokio::time::timeout(
        Duration::from_secs(15),
        host.request("host.vault.info", json!({})),
    )
    .await
    .map_err(|_| "Timed out resolving the active Vault".to_string())??;
    info["root"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "Configure a Vault before syncing Apple Notes".into())
}

fn migrate_legacy_state(vault: &Path, legacy_path: &Path) -> Result<PersistedState, String> {
    let vault_state = read_persisted_state(vault)?;
    let legacy = match fs::read(legacy_path) {
        Ok(bytes) => serde_json::from_slice::<State>(&bytes).ok(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let saved = match (vault_state, legacy) {
        (Some(saved), Some(legacy)) => {
            if saved == PersistedState::default() {
                let saved = legacy.persisted();
                write_persisted_state(vault, &saved)?;
                saved
            } else {
                saved
            }
        }
        (Some(saved), None) => saved,
        // No Vault ledger is the reset signal. Never resurrect global history
        // after the user removed the complete `applenotes/` directory.
        (None, _) => PersistedState::default(),
    };
    match fs::remove_file(legacy_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Could not remove legacy Apple Notes state: {error}"
            ))
        }
    }
    Ok(saved)
}

async fn hydrate(
    host: &sdk::Host,
    state: &Arc<Mutex<State>>,
    legacy_path: &Path,
) -> Result<(), String> {
    let vault = resolve_vault(host).await?;
    let worker_vault = vault.clone();
    let worker_legacy = legacy_path.to_path_buf();
    let saved =
        tokio::task::spawn_blocking(move || migrate_legacy_state(&worker_vault, &worker_legacy))
            .await
            .map_err(|e| e.to_string())??;
    let mut state = state.lock().unwrap();
    state.vault = Some(vault.to_string_lossy().into());
    state.apply(saved);
    state.ready = true;
    Ok(())
}

async fn run_sync(host: sdk::Host, state: Arc<Mutex<State>>) {
    let outcome = async {
        let vault = resolve_vault(&host).await?;
        state.lock().map_err(|e| e.to_string())?.vault = Some(vault.to_string_lossy().into());
        let worker_vault = vault.clone();
        let result = tokio::task::spawn_blocking(move || sync_recorded(&worker_vault, false))
            .await
            .map_err(|e| e.to_string())?;
        Ok::<_, String>((vault, result))
    }
    .await;
    let mut state = state.lock().unwrap();
    state.running = false;
    state.ready = true;
    match outcome {
        Ok((vault, result)) => {
            match read_persisted_state(&vault) {
                Ok(Some(saved)) => state.apply(saved),
                Ok(None) => state.apply(PersistedState::default()),
                Err(error) => state.error = Some(error),
            }
            if let Err(error) = result {
                host.log_warn(&format!("apple-notes: {error}"));
                state.report = None;
                state.error = Some(error);
            }
        }
        Err(error) => {
            host.log_warn(&format!("apple-notes: {error}"));
            state.report = None;
            state.error = Some(error);
        }
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
        let _ = host;
        self.legacy_state_path = PathBuf::from(&params.data_dir).join("state.json");
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
        let legacy_path = self.legacy_state_path.clone();
        self.poller = Some(tokio::spawn(async move {
            loop {
                let needs_hydration = state.lock().unwrap().vault.is_none();
                if needs_hydration {
                    if let Err(error) = hydrate(&host, &state, &legacy_path).await {
                        host.log_warn(&format!("apple-notes: {error}"));
                        let mut current = state.lock().unwrap();
                        current.ready = true;
                        current.auto_sync = false;
                        current.error = Some(error);
                    }
                } else if let Err(error) = refresh_from_vault(&state) {
                    host.log_warn(&format!("apple-notes: {error}"));
                    let mut current = state.lock().unwrap();
                    current.auto_sync = false;
                    current.error = Some(error);
                }
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
                    run_sync(host.clone(), state.clone()).await;
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
                let report = sync_recorded(&vault, dry_run)?;
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
                if !state.ready {
                    return Err("Apple Notes state is still loading".into());
                }
                let vault = state
                    .vault
                    .as_deref()
                    .map(PathBuf::from)
                    .ok_or("Configure a Vault before changing Apple Notes settings")?;
                let old = state.auto_sync;
                state.auto_sync = enabled;
                let saved = state.persisted();
                drop(state);
                if let Err(error) = write_persisted_state(&vault, &saved) {
                    let mut state = self.state.lock().map_err(|e| e.to_string())?;
                    state.auto_sync = old;
                    return Err(error);
                }
                let state = self.state.lock().map_err(|e| e.to_string())?;
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

    fn legacy(path: &Path, state: &State) {
        fs::write(path, serde_json::to_vec(state).unwrap()).unwrap();
    }

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

    #[test]
    fn legacy_app_support_state_moves_into_an_existing_vault_ledger() {
        let vault = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("state.json");
        write_persisted_state(vault.path(), &PersistedState::default()).unwrap();
        legacy(
            &path,
            &State {
                auto_sync: true,
                last_finished: Some(42),
                ..Default::default()
            },
        );

        let saved = migrate_legacy_state(vault.path(), &path).unwrap();
        assert!(saved.auto_sync);
        assert_eq!(saved.last_finished, Some(42));
        assert_eq!(read_persisted_state(vault.path()).unwrap(), Some(saved));
        assert!(!path.exists());
    }

    #[test]
    fn removed_applenotes_directory_is_a_reset_and_does_not_resurrect_global_history() {
        let vault = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("state.json");
        legacy(
            &path,
            &State {
                auto_sync: true,
                last_finished: Some(42),
                ..Default::default()
            },
        );

        assert_eq!(
            migrate_legacy_state(vault.path(), &path).unwrap(),
            PersistedState::default()
        );
        assert!(!path.exists());
        assert!(!vault.path().join("applenotes/id-sync.json").exists());
    }

    #[test]
    fn status_refresh_resets_memory_after_applenotes_is_removed() {
        let vault = tempfile::tempdir().unwrap();
        let saved = PersistedState {
            auto_sync: true,
            last_finished: Some(42),
            ..Default::default()
        };
        write_persisted_state(vault.path(), &saved).unwrap();
        let state = Arc::new(Mutex::new(State {
            auto_sync: true,
            last_finished: Some(42),
            vault: Some(vault.path().to_string_lossy().into()),
            ready: true,
            ..Default::default()
        }));
        fs::remove_dir_all(vault.path().join("applenotes")).unwrap();

        refresh_from_vault(&state).unwrap();
        let current = state.lock().unwrap();
        assert!(!current.auto_sync);
        assert_eq!(current.last_finished, None);
        assert!(current.report.is_none());
        assert!(current.error.is_none());
    }

    #[test]
    fn invalid_legacy_global_state_is_removed_without_blocking_vault_state() {
        let vault = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("state.json");
        let saved = PersistedState {
            last_finished: Some(42),
            ..Default::default()
        };
        write_persisted_state(vault.path(), &saved).unwrap();
        fs::write(&path, b"not json").unwrap();

        assert_eq!(migrate_legacy_state(vault.path(), &path).unwrap(), saved);
        assert!(!path.exists());
    }
}
