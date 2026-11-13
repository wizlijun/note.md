use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use super::{git_ops, watcher, SyncState, VaultSyncManager};

/// vault 内连续这么久没有文件变动,才认为这一阵编辑告一段落、可以同步。
const QUIET_PERIOD: Duration = Duration::from_secs(10);
/// 一直不停笔时的兜底:距首个事件超过这么久就无条件同步一次。
const MAX_DEFER: Duration = Duration::from_secs(120);

pub fn start(app: &AppHandle) -> Result<(), String> {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    let _lifecycle = mgr.lifecycle.lock().unwrap();
    {
        let mut worker = mgr.worker.lock().unwrap();
        if worker.as_ref().is_some_and(|handle| !handle.is_finished()) {
            return if *mgr.stop_flag.lock().unwrap() { Err("Vault sync is still stopping".into()) } else { Ok(()) };
        }
        if let Some(handle) = worker.take() { let _ = handle.join(); }
    }
    let repo_path = mgr.repo_path.lock().unwrap().clone()
        .ok_or("Vault sync not configured: no repo_path")?;
    if !crate::vault_management::sync_enabled(app, &repo_path)? { return Err("Vault sync is paused".into()); }
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

    *mgr.worker.lock().unwrap() = Some(std::thread::spawn(move || {
        run_loop(app_handle.clone(), repo, remote, branch);
        let mgr = app_handle.state::<Arc<VaultSyncManager>>();
        if *mgr.stop_flag.lock().unwrap() { set_state(&app_handle, SyncState::Stopped); }
    }));

    Ok(())
}

pub fn stop(app: &AppHandle) -> Result<(), String> {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    let _lifecycle = mgr.lifecycle.lock().unwrap();
    *mgr.stop_flag.lock().unwrap() = true;
    wait_for_worker(&mgr.worker, Duration::from_secs(15))?;
    let _sync = mgr.sync_gate.try_lock().map_err(|_| "A manual sync is still running; retry when it finishes")?;
    set_state(app, SyncState::Stopped);
    mgr.logs.push("INFO", "Sync stopped");
    Ok(())
}

fn wait_for_worker(worker: &std::sync::Mutex<Option<std::thread::JoinHandle<()>>>, timeout: Duration) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let done = worker.lock().unwrap().as_ref().is_none_or(|handle| handle.is_finished());
        if done { break; }
        if std::time::Instant::now() >= deadline { return Err("Vault sync is still stopping; retry after the current operation finishes".into()); }
        std::thread::sleep(Duration::from_millis(25));
    }
    if let Some(handle) = worker.lock().unwrap().take() {
        handle.join().map_err(|_| "Vault sync worker exited unexpectedly")?;
    }
    Ok(())
}

pub fn sync_once(app: &AppHandle) -> Result<(), String> {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    let _guard = mgr.sync_gate.try_lock().map_err(|_| "Sync is already running")?;
    if *mgr.stop_flag.lock().unwrap() { return Err("Vault sync is paused".into()); }
    let repo_path = mgr.repo_path.lock().unwrap().clone().ok_or("Not configured")?;
    if !crate::vault_management::sync_enabled(app, &repo_path)? { return Err("Vault sync is paused".into()); }
    do_sync(app, &PathBuf::from(repo_path), &mgr.remote, &mgr.branch);
    if let Some(error) = mgr.error_msg.lock().unwrap().clone() { return Err(error); }
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
    {
        let mgr = app.state::<Arc<VaultSyncManager>>();
        let _guard = mgr.sync_gate.lock().unwrap();
        if !*mgr.stop_flag.lock().unwrap() { do_sync(&app, &repo, &remote, &branch); }
    }

    let mut last_periodic = std::time::Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(_) => {
                // 等编辑停下来再同步:每来一个文件事件就把窗口顺延,连续 QUIET_PERIOD
                // 没有动静才跑一轮。创作和大批量修改基本只发生在单台设备上,上传晚
                // 几十秒无所谓,但每 15 秒抢一轮 git 会在用户正打字时反复扰动仓库。
                // MAX_DEFER 兜底:长时间不停笔也要定期落一个检查点,不能无限推迟。
                let start = std::time::Instant::now();
                loop {
                    if *app.state::<Arc<VaultSyncManager>>().stop_flag.lock().unwrap() { return; }
                    match rx.recv_timeout(QUIET_PERIOD) {
                        // 又有改动 —— 顺延,除非已经拖到上限。
                        Ok(_) if start.elapsed() < MAX_DEFER => continue,
                        _ => break,
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let mgr = app.state::<Arc<VaultSyncManager>>();
                if *mgr.stop_flag.lock().unwrap() {
                    break;
                }
                if last_periodic.elapsed() < Duration::from_secs(30) { continue; }
                last_periodic = std::time::Instant::now();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }

        let mgr = app.state::<Arc<VaultSyncManager>>();
        if *mgr.stop_flag.lock().unwrap() {
            break;
        }

        {
            let mgr = app.state::<Arc<VaultSyncManager>>();
            let _guard = mgr.sync_gate.lock().unwrap();
            if !*mgr.stop_flag.lock().unwrap() { do_sync(&app, &repo, &remote, &branch); }
        }
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
        Ok(report) => {
            *mgr.skipped_large_files.lock().unwrap() = report.skipped_large.clone();
            if !report.skipped_large.is_empty() {
                mgr.logs.push(
                    "WARN",
                    &format!("{} file(s) over the size limit were left out of sync: {}",
                        report.skipped_large.len(),
                        report.skipped_large.join(", ")),
                );
            }
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

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::sync::{mpsc, Mutex};

    #[test]
    fn timeout_retains_worker_until_old_write_finishes_before_next_worker() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("writes");
        let old_path = path.clone();
        let (release, wait) = mpsc::channel();
        let worker = Mutex::new(Some(std::thread::spawn(move || {
            wait.recv().unwrap();
            std::fs::write(old_path, "old finished").unwrap();
        })));
        assert!(wait_for_worker(&worker, Duration::from_millis(1)).is_err());
        assert!(worker.lock().unwrap().is_some());
        assert!(!path.exists());
        release.send(()).unwrap();
        wait_for_worker(&worker, Duration::from_secs(2)).unwrap();
        assert!(worker.lock().unwrap().is_none());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old finished");
        let next_path = path.clone();
        *worker.lock().unwrap() = Some(std::thread::spawn(move || { std::fs::write(next_path, "new finished").unwrap(); }));
        wait_for_worker(&worker, Duration::from_secs(2)).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new finished");
    }

    #[test]
    fn panicked_worker_is_an_error_not_a_successful_stop() {
        let worker = Mutex::new(Some(std::thread::spawn(|| panic!("injected worker failure"))));
        assert!(wait_for_worker(&worker, Duration::from_secs(2)).is_err());
        assert!(worker.lock().unwrap().is_none());
    }
}
