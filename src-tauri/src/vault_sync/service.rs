use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use super::{git_ops, watcher, SyncState, VaultSyncManager};

pub fn start(app: &AppHandle) -> Result<(), String> {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    let repo_path = mgr.repo_path.lock().unwrap().clone()
        .ok_or("Vault sync not configured: no repo_path")?;
    let repo = PathBuf::from(&repo_path);

    if !repo.join(".git").exists() {
        return Err(format!("Not a git repo: {repo_path}"));
    }

    {
        let mut stop = mgr.stop_flag.lock().unwrap();
        *stop = false;
    }
    set_state(app, SyncState::Running);
    mgr.logs.push("INFO", "Sync started");

    let app_handle = app.clone();
    let remote = mgr.remote.clone();
    let branch = mgr.branch.clone();

    std::thread::spawn(move || {
        run_loop(app_handle, repo, remote, branch);
    });

    Ok(())
}

pub fn stop(app: &AppHandle) -> Result<(), String> {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    {
        let mut stop = mgr.stop_flag.lock().unwrap();
        *stop = true;
    }
    set_state(app, SyncState::Stopped);
    mgr.logs.push("INFO", "Sync stopped");
    Ok(())
}

pub fn sync_once(app: &AppHandle) -> Result<(), String> {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    let repo_path = mgr.repo_path.lock().unwrap().clone()
        .ok_or("Not configured")?;
    let repo = PathBuf::from(&repo_path);
    let remote = mgr.remote.clone();
    let branch = mgr.branch.clone();

    do_sync(app, &repo, &remote, &branch);
    Ok(())
}

fn run_loop(app: AppHandle, repo: PathBuf, remote: String, branch: String) {
    let (tx, rx) = std::sync::mpsc::channel::<()>();

    let _watcher = match watcher::start(&repo, tx.clone()) {
        Ok(w) => w,
        Err(e) => {
            let mgr = app.state::<Arc<VaultSyncManager>>();
            mgr.logs.push("ERROR", &format!("Watcher failed: {e}"));
            set_state(&app, SyncState::Error);
            return;
        }
    };

    // Initial sync immediately on start
    do_sync(&app, &repo, &remote, &branch);

    let tx_periodic = tx.clone();
    let app_for_periodic = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(30));
            let mgr = app_for_periodic.state::<Arc<VaultSyncManager>>();
            if *mgr.stop_flag.lock().unwrap() {
                break;
            }
            let _ = tx_periodic.send(());
        }
    });

    loop {
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(_) => {
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                while std::time::Instant::now() < deadline {
                    let _ = rx.recv_timeout(Duration::from_millis(200));
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let mgr = app.state::<Arc<VaultSyncManager>>();
                if *mgr.stop_flag.lock().unwrap() {
                    break;
                }
                continue;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }

        let mgr = app.state::<Arc<VaultSyncManager>>();
        if *mgr.stop_flag.lock().unwrap() {
            break;
        }

        do_sync(&app, &repo, &remote, &branch);
    }
}

fn do_sync(app: &AppHandle, repo: &PathBuf, remote: &str, branch: &str) {
    let mgr = app.state::<Arc<VaultSyncManager>>();

    // Guard: if `git` itself cannot be run, never report a healthy sync.
    match git_ops::version() {
        Some(ver) => {
            let was_unavailable = !*mgr.git_available.lock().unwrap();
            *mgr.git_available.lock().unwrap() = true;
            if was_unavailable {
                mgr.logs.push("INFO", &format!("git is available again: {ver}"));
            }
        }
        None => {
            *mgr.git_available.lock().unwrap() = false;
            let msg = "git executable not found on PATH — sync is paused";
            *mgr.error_msg.lock().unwrap() = Some(msg.to_string());
            set_state(app, SyncState::GitUnavailable);
            mgr.logs.push("ERROR", msg);
            let _ = app.emit("vault-sync-log", ());
            return;
        }
    }

    set_state(app, SyncState::Syncing);
    mgr.logs.push("INFO", "Syncing...");

    let head_before = git_ops::run_git(repo, &["rev-parse", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string());

    match git_ops::sync(repo, remote, branch) {
        Ok(()) => {
            let ts = format!("{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default().as_secs());
            *mgr.last_sync.lock().unwrap() = Some(ts);
            *mgr.error_msg.lock().unwrap() = None;
            set_state(app, SyncState::Running);
            mgr.logs.push("INFO", "Sync completed");

            // If this sync changed any per-device recents file, tell the UI to refresh the menu.
            let head_after = git_ops::run_git(repo, &["rev-parse", "HEAD"])
                .ok()
                .map(|s| s.trim().to_string());
            if let (Some(before), Some(after)) = (head_before.as_ref(), head_after.as_ref()) {
                if before != after {
                    if let Ok(diff) = git_ops::run_git(repo, &["diff", "--name-only", before, after]) {
                        if diff.lines().any(|l| l.trim().starts_with(".notemd/recents/")) {
                            let _ = app.emit("editor://recents-synced", ());
                        }
                    }
                }
            }
        }
        Err(e) => {
            if e.contains("conflict") || e.contains("Conflict") {
                set_state(app, SyncState::Conflict);
                mgr.logs.push("WARN", &format!("Conflict: {e}"));
            } else {
                *mgr.error_msg.lock().unwrap() = Some(e.clone());
                set_state(app, SyncState::Error);
                mgr.logs.push("ERROR", &e);
            }
        }
    }

    let _ = app.emit("vault-sync-log", ());
}

fn set_state(app: &AppHandle, state: SyncState) {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    *mgr.state.lock().unwrap() = state;
    let _ = app.emit("vault-sync-state-changed", state);
    #[cfg(not(target_os = "ios"))]
    crate::refresh_tray_status(app);
}
