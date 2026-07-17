pub mod conflict;
pub mod git_ops;
pub mod large_files;
pub mod log_buffer;
pub mod service;
pub mod watcher;

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

use log_buffer::LogBuffer;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    NotConfigured,
    Stopped,
    Running,
    Syncing,
    Conflict,
    Error,
    /// The `git` executable could not be found or failed to run.
    GitUnavailable,
}

impl SyncState {
    /// A short human-readable label for menus, tooltips and log headers.
    pub fn label(self) -> &'static str {
        match self {
            SyncState::NotConfigured => "Not configured",
            SyncState::Stopped => "Stopped",
            SyncState::Running => "Running",
            SyncState::Syncing => "Syncing…",
            SyncState::Conflict => "Conflict — needs attention",
            SyncState::Error => "Error",
            SyncState::GitUnavailable => "Git unavailable",
        }
    }

    /// True when the state represents a problem the user should notice.
    pub fn is_problem(self) -> bool {
        matches!(
            self,
            SyncState::Conflict | SyncState::Error | SyncState::GitUnavailable
        )
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultSyncStatus {
    pub state: SyncState,
    pub repo_path: Option<String>,
    pub last_sync: Option<String>,
    pub error_message: Option<String>,
    pub git_available: bool,
}

pub struct VaultSyncManager {
    pub state: Mutex<SyncState>,
    pub repo_path: Mutex<Option<String>>,
    pub remote: String,
    pub branch: String,
    pub logs: LogBuffer,
    pub last_sync: Mutex<Option<String>>,
    pub error_msg: Mutex<Option<String>>,
    pub git_available: Mutex<bool>,
    pub stop_flag: Mutex<bool>,
}

impl VaultSyncManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(SyncState::NotConfigured),
            repo_path: Mutex::new(None),
            remote: "origin".into(),
            branch: "main".into(),
            logs: LogBuffer::new(1000),
            last_sync: Mutex::new(None),
            error_msg: Mutex::new(None),
            git_available: Mutex::new(true),
            stop_flag: Mutex::new(false),
        }
    }
}

#[tauri::command]
pub fn vault_sync_start(app: AppHandle) -> Result<(), String> {
    service::start(&app)
}

#[tauri::command]
pub fn vault_sync_stop(app: AppHandle) -> Result<(), String> {
    service::stop(&app)
}

#[tauri::command]
pub fn vault_sync_now(app: AppHandle) -> Result<(), String> {
    service::sync_once(&app)
}

#[tauri::command]
pub fn vault_sync_status(app: AppHandle) -> VaultSyncStatus {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    let state = *mgr.state.lock().unwrap();
    let repo_path = mgr.repo_path.lock().unwrap().clone();
    let last_sync = mgr.last_sync.lock().unwrap().clone();
    let error_message = mgr.error_msg.lock().unwrap().clone();
    let git_available = *mgr.git_available.lock().unwrap();
    VaultSyncStatus { state, repo_path, last_sync, error_message, git_available }
}

#[tauri::command]
pub fn vault_sync_logs(app: AppHandle) -> Vec<log_buffer::LogEntry> {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    mgr.logs.entries()
}

pub fn init(app: &AppHandle) {
    use tauri_plugin_store::StoreExt;

    let store = match app.store("settings.json") {
        Ok(s) => s,
        Err(_) => return,
    };

    let repo_path = crate::shared_config::config_path()
        .ok()
        .and_then(|p| crate::shared_config::read(&p).ok())
        .and_then(|cfg| cfg.sotvault)
        .filter(|s| !s.is_empty());

    if let Some(ref path) = repo_path {
        let mgr = app.state::<Arc<VaultSyncManager>>();
        *mgr.repo_path.lock().unwrap() = Some(path.clone());

        let auto_start = store.get("vault_sync.auto_start")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        if auto_start {
            *mgr.state.lock().unwrap() = SyncState::Stopped;
            let app_clone = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let _ = service::start(&app_clone);
                crate::update_tray_icon(&app_clone, true);
            });
        } else {
            *mgr.state.lock().unwrap() = SyncState::Stopped;
        }
    }
}
