use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::time;

use crate::git_ops;
use crate::watcher;

pub async fn run(repo_path: PathBuf, remote: String, branch: String) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!(
        "Starting vaultgitsync daemon: repo={}, remote={}, branch={}",
        repo_path.display(),
        remote,
        branch
    );

    if !repo_path.join(".git").exists() {
        return Err(format!("Not a git repository: {}", repo_path.display()).into());
    }

    // Initial sync on startup
    tracing::info!("Running initial sync...");
    if let Err(e) = git_ops::sync(&repo_path, &remote, &branch) {
        tracing::warn!("Initial sync error (non-fatal): {e}");
    }

    let sync_lock = Arc::new(Mutex::new(()));

    // File watcher channel
    let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
    let _watcher = watcher::start(&repo_path, tx)?;
    tracing::info!("File watcher started on {}", repo_path.display());

    // Spawn debounced file-change sync
    let repo_clone = repo_path.clone();
    let remote_clone = remote.clone();
    let branch_clone = branch.clone();
    let lock_clone = Arc::clone(&sync_lock);

    let change_handle = tokio::task::spawn_blocking(move || {
        loop {
            // Wait for first event
            match rx.recv() {
                Ok(_) => {}
                Err(_) => break,
            }

            // Debounce: drain all events within 2 seconds
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(_) => {}
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }

            // Execute sync with lock
            let _guard = lock_clone.lock().unwrap();
            tracing::info!("File change detected, syncing...");
            if let Err(e) = git_ops::sync(&repo_clone, &remote_clone, &branch_clone) {
                tracing::error!("Sync error: {e}");
            } else {
                tracing::info!("Sync completed");
            }
        }
    });

    // Periodic pull (every 30s) to get remote changes
    let repo_pull = repo_path.clone();
    let remote_pull = remote.clone();
    let branch_pull = branch.clone();
    let lock_pull = Arc::clone(&sync_lock);

    let pull_handle = tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            let repo_p = repo_pull.clone();
            let remote_p = remote_pull.clone();
            let branch_p = branch_pull.clone();
            let lock_p = Arc::clone(&lock_pull);

            tokio::task::spawn_blocking(move || {
                let _guard = lock_p.lock().unwrap();
                if let Err(e) = git_ops::sync(&repo_p, &remote_p, &branch_p) {
                    tracing::warn!("Periodic sync error: {e}");
                }
            })
            .await
            .ok();
        }
    });

    tokio::select! {
        _ = change_handle => {
            tracing::error!("File watcher stopped unexpectedly");
        }
        _ = pull_handle => {
            tracing::error!("Periodic pull stopped unexpectedly");
        }
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("Shutting down...");
        }
    }

    Ok(())
}
