//! iOS-only vault sync module. macOS continues to use `vault_sync` (CLI-based).
//!
//! Architecture: pure libgit2 (`git2` crate) with vendored libgit2 + OpenSSL.
//! PAT credentials live in iOS Keychain via a Swift bridge.

#![cfg(any(target_os = "ios", test))]

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

pub mod path;
pub mod list_dir;
pub mod keychain;
pub mod sig;
pub mod clone;
pub mod sync;
pub mod conflict;

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    NotConfigured,
    Cloning,
    Idle,
    Syncing,
    Error,
    Conflict,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultStatus {
    pub state: SyncState,
    pub last_sync: Option<u64>,         // epoch ms
    pub error_message: Option<String>,
    pub has_conflicts: bool,
    pub configured: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VaultConfigure {
    pub remote_url: String,
    pub branch: String,
    pub pat: String,
    pub author_name: String,
    pub author_email: String,
}

#[derive(Debug)]
pub enum VaultError {
    NotConfigured,
    NetworkError(String),
    AuthFailed,
    NotFoundOrNoAccess,
    RebaseFailed,
    PushRejected(String),
    FsError(String),
    GitError(String),
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::NotConfigured => write!(f, "vault not configured"),
            Self::NetworkError(s) => write!(f, "network: {s}"),
            Self::AuthFailed => write!(f, "auth failed"),
            Self::NotFoundOrNoAccess => write!(f, "not found / no access"),
            Self::RebaseFailed => write!(f, "rebase failed"),
            Self::PushRejected(s) => write!(f, "push rejected: {s}"),
            Self::FsError(s) => write!(f, "fs: {s}"),
            Self::GitError(s) => write!(f, "git: {s}"),
        }
    }
}

impl From<git2::Error> for VaultError {
    fn from(e: git2::Error) -> Self {
        let msg = e.message().to_string();
        match e.class() {
            git2::ErrorClass::Net | git2::ErrorClass::Http => Self::NetworkError(msg),
            git2::ErrorClass::Reference if e.code() == git2::ErrorCode::Auth => Self::AuthFailed,
            _ if msg.contains("authentication") || msg.contains("401") => Self::AuthFailed,
            _ if msg.contains("404") || msg.contains("not found") => Self::NotFoundOrNoAccess,
            _ => Self::GitError(msg),
        }
    }
}

impl From<std::io::Error> for VaultError {
    fn from(e: std::io::Error) -> Self { Self::FsError(e.to_string()) }
}

pub struct VaultIosManager {
    pub state: Mutex<SyncState>,
    pub last_sync: Mutex<Option<u64>>,
    pub error_msg: Mutex<Option<String>>,
    pub has_conflicts: Mutex<bool>,
    pub remote_url: Mutex<Option<String>>,
    pub branch: Mutex<String>,
    pub author_name: Mutex<String>,
    pub author_email: Mutex<String>,
}

impl VaultIosManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(SyncState::NotConfigured),
            last_sync: Mutex::new(None),
            error_msg: Mutex::new(None),
            has_conflicts: Mutex::new(false),
            remote_url: Mutex::new(None),
            branch: Mutex::new("main".into()),
            author_name: Mutex::new("mdeditor on iOS".into()),
            author_email: Mutex::new(String::new()),
        }
    }

    pub fn snapshot_status(&self, configured: bool) -> VaultStatus {
        VaultStatus {
            state: *self.state.lock().unwrap(),
            last_sync: *self.last_sync.lock().unwrap(),
            error_message: self.error_msg.lock().unwrap().clone(),
            has_conflicts: *self.has_conflicts.lock().unwrap(),
            configured,
        }
    }
}

#[tauri::command]
pub fn vault_status(app: AppHandle) -> VaultStatus {
    let mgr = app.state::<Arc<VaultIosManager>>();
    let configured = mgr.remote_url.lock().unwrap().is_some();
    mgr.snapshot_status(configured)
}

use tauri::Emitter;

#[tauri::command]
pub async fn vault_configure(
    app: AppHandle,
    cfg: VaultConfigure,
) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let mgr_state = app.state::<Arc<VaultIosManager>>();
    let mgr: Arc<VaultIosManager> = mgr_state.inner().clone();

    // Save non-secret config to settings.json.
    if let Ok(store) = app.store("settings.json") {
        let _ = store.set("vault_ios.remote_url", serde_json::json!(&cfg.remote_url));
        let _ = store.set("vault_ios.branch", serde_json::json!(&cfg.branch));
        let _ = store.set("vault_ios.author_name", serde_json::json!(&cfg.author_name));
        let _ = store.set("vault_ios.author_email", serde_json::json!(&cfg.author_email));
        let _ = store.save();
    }

    *mgr.remote_url.lock().unwrap() = Some(cfg.remote_url.clone());
    *mgr.branch.lock().unwrap() = cfg.branch.clone();
    *mgr.author_name.lock().unwrap() = cfg.author_name.clone();
    *mgr.author_email.lock().unwrap() = cfg.author_email.clone();
    *mgr.state.lock().unwrap() = SyncState::Cloning;
    let _ = app.emit("vault-status-changed", ());

    let dest = path::vault_path(&app).map_err(|e| e.to_string())?;
    let app_for_progress = app.clone();
    let clone_result = clone::clone_repo(
        &cfg.remote_url,
        &cfg.branch,
        &cfg.pat,
        &dest,
        move |p| {
            let _ = app_for_progress.emit("vault-clone-progress", serde_json::json!({
                "stage": p.stage,
                "received_objects": p.received_objects,
                "total_objects": p.total_objects,
                "bytes": p.bytes,
            }));
        },
    );

    match clone_result {
        Ok(()) => {
            *mgr.state.lock().unwrap() = SyncState::Idle;
            *mgr.last_sync.lock().unwrap() = Some(now_ms());
            *mgr.error_msg.lock().unwrap() = None;
            let _ = app.emit("vault-status-changed", ());
            Ok(())
        }
        Err(e) => {
            *mgr.state.lock().unwrap() = SyncState::Error;
            *mgr.error_msg.lock().unwrap() = Some(e.to_string());
            let _ = app.emit("vault-status-changed", ());
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn vault_sync_now(app: AppHandle, pat: String) -> Result<VaultStatus, String> {
    let mgr_state = app.state::<Arc<VaultIosManager>>();
    let mgr: Arc<VaultIosManager> = mgr_state.inner().clone();

    let configured = mgr.remote_url.lock().unwrap().is_some();
    if !configured {
        *mgr.state.lock().unwrap() = SyncState::Error;
        *mgr.error_msg.lock().unwrap() = Some("not configured".into());
        return Err("vault not configured".into());
    }

    *mgr.state.lock().unwrap() = SyncState::Syncing;
    *mgr.error_msg.lock().unwrap() = None;
    let _ = app.emit("vault-status-changed", ());

    let vault_dir = path::vault_path(&app).map_err(|e| e.to_string())?;
    if !vault_dir.join(".git").exists() {
        *mgr.state.lock().unwrap() = SyncState::NotConfigured;
        let _ = app.emit("vault-status-changed", ());
        return Err("vault directory missing".into());
    }

    let branch = mgr.branch.lock().unwrap().clone();
    let remote_url = mgr.remote_url.lock().unwrap().clone().unwrap_or_default();

    let mgr_clone = Arc::clone(&mgr);
    let result = tokio::task::spawn_blocking(move || {
        sync::sync_once(&mgr_clone, &vault_dir, &branch, &remote_url, &pat)
    }).await.map_err(|e| e.to_string())?;

    match result {
        Ok(_outcome) => {
            *mgr.state.lock().unwrap() = SyncState::Idle;
            *mgr.last_sync.lock().unwrap() = Some(now_ms());
            let _ = app.emit("vault-status-changed", ());
            Ok(mgr.snapshot_status(true))
        }
        Err(e) => {
            *mgr.state.lock().unwrap() = SyncState::Error;
            *mgr.error_msg.lock().unwrap() = Some(e.to_string());
            let _ = app.emit("vault-status-changed", ());
            Err(e.to_string())
        }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn init(app: &AppHandle) {
    use tauri_plugin_store::StoreExt;
    let mgr = Arc::new(VaultIosManager::new());

    if let Ok(store) = app.store("settings.json") {
        if let Some(url) = store.get("vault_ios.remote_url").and_then(|v| v.as_str().map(String::from)) {
            *mgr.remote_url.lock().unwrap() = Some(url);
            *mgr.state.lock().unwrap() = SyncState::Idle;
        }
        if let Some(b) = store.get("vault_ios.branch").and_then(|v| v.as_str().map(String::from)) {
            *mgr.branch.lock().unwrap() = b;
        }
        if let Some(n) = store.get("vault_ios.author_name").and_then(|v| v.as_str().map(String::from)) {
            *mgr.author_name.lock().unwrap() = n;
        }
        if let Some(e) = store.get("vault_ios.author_email").and_then(|v| v.as_str().map(String::from)) {
            *mgr.author_email.lock().unwrap() = e;
        }
    }

    app.manage(mgr);
}
