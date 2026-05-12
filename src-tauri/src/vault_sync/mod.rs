pub mod conflict;
pub mod git_ops;
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
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultSyncStatus {
    pub state: SyncState,
    pub repo_path: Option<String>,
    pub last_sync: Option<String>,
    pub error_message: Option<String>,
}

pub struct VaultSyncManager {
    pub state: Mutex<SyncState>,
    pub repo_path: Mutex<Option<String>>,
    pub remote: String,
    pub branch: String,
    pub logs: LogBuffer,
    pub last_sync: Mutex<Option<String>>,
    pub error_msg: Mutex<Option<String>>,
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
    VaultSyncStatus { state, repo_path, last_sync, error_message }
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

    let repo_path = store.get("vault_sync.repo_path")
        .and_then(|v| v.as_str().map(|s| s.to_string()));

    if let Some(ref path) = repo_path {
        let mgr = app.state::<Arc<VaultSyncManager>>();
        *mgr.repo_path.lock().unwrap() = Some(path.clone());

        let auto_start = store.get("vault_sync.auto_start")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if auto_start {
            *mgr.state.lock().unwrap() = SyncState::Stopped;
            let app_clone = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let _ = service::start(&app_clone);
            });
        } else {
            *mgr.state.lock().unwrap() = SyncState::Stopped;
        }
    }
}
