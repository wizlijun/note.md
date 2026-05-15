//! iOS-only vault sync module. macOS continues to use `vault_sync` (CLI-based).
//!
//! Architecture: pure libgit2 (`git2` crate) with vendored libgit2 + OpenSSL.
//! PAT credentials live in iOS Keychain via a Swift bridge.

#![cfg(any(target_os = "ios", test))]

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

pub mod path;

#[cfg(test)]
mod tests;

// Submodules will be added by later tasks (list_dir, keychain, sig, clone, sync, conflict).

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
