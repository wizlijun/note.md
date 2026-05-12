use std::path::{Path, PathBuf};
use std::process::Command;

use git2::{Repository, StatusOptions};

pub type SyncResult<T> = Result<T, Box<dyn std::error::Error>>;

/// Core sync: fetch -> stash local -> rebase -> stash pop -> handle conflicts -> commit -> push
pub fn sync(repo_path: &Path, remote: &str, branch: &str) -> SyncResult<()> {
    let repo_str = repo_path.to_str().unwrap_or(".");

    // 1. Fetch
    run_git(repo_path, &["fetch", remote, branch])?;

    // 2. Check local changes
    let has_local_changes = has_changes(repo_path)?;

    if !has_local_changes {
        // Fast-forward pull only
        let result = run_git(repo_path, &["pull", "--ff-only", remote, branch]);
        if result.is_err() {
            tracing::warn!("[{repo_str}] ff-only pull failed, trying rebase");
            run_git(repo_path, &["pull", "--rebase", remote, branch])?;
        }
        return Ok(());
    }

    // 3. Stash local changes
    run_git(repo_path, &["stash", "push", "-m", "vaultgitsync-auto"])?;

    // 4. Rebase on remote
    let rebase_ok = run_git(repo_path, &["rebase", &format!("{remote}/{branch}")]).is_ok();
    if !rebase_ok {
        run_git(repo_path, &["rebase", "--abort"])?;
        run_git(repo_path, &["stash", "pop"])?;
        tracing::error!("[{repo_str}] Rebase failed, skipping this sync cycle");
        return Ok(());
    }

    // 5. Pop stash
    let pop_result = run_git(repo_path, &["stash", "pop"]);
    if pop_result.is_err() {
        // Conflict during stash pop
        handle_conflicts(repo_path)?;
    }

    // 6. Commit all
    run_git(repo_path, &["add", "-A"])?;

    let has_staged = has_changes(repo_path)?;
    if has_staged {
        let timestamp = chrono_now();
        run_git(
            repo_path,
            &["commit", "-m", &format!("vault: auto-sync {timestamp}")],
        )?;
    }

    // 7. Push
    let push_result = run_git(repo_path, &["push", remote, branch]);
    if push_result.is_err() {
        tracing::warn!("[{repo_str}] Push failed, will retry next cycle");
    }

    Ok(())
}

/// Handle conflicts: save local version as .conflict.<timestamp> file, accept theirs
fn handle_conflicts(repo_path: &Path) -> SyncResult<()> {
    let repo = Repository::open(repo_path)?;
    let statuses = repo.statuses(Some(
        StatusOptions::new().include_untracked(false).renames_head_to_index(true),
    ))?;

    let timestamp = chrono_now();

    for entry in statuses.iter() {
        let status = entry.status();
        if status.is_conflicted() {
            if let Some(path_str) = entry.path() {
                let file_path = repo_path.join(path_str);
                let conflict_path = make_conflict_path(&file_path, &timestamp);

                // Save local (ours) version
                if file_path.exists() {
                    std::fs::copy(&file_path, &conflict_path)?;
                    tracing::warn!(
                        "Conflict: {} -> saved local as {}",
                        path_str,
                        conflict_path.display()
                    );
                }

                // Accept theirs
                run_git(repo_path, &["checkout", "--theirs", path_str])?;
                run_git(repo_path, &["add", path_str])?;
            }
        }
    }

    // Also add conflict backup files
    run_git(repo_path, &["add", "-A"])?;

    Ok(())
}

fn make_conflict_path(file_path: &Path, timestamp: &str) -> PathBuf {
    let stem = file_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let ext = file_path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let parent = file_path.parent().unwrap_or(Path::new("."));
    parent.join(format!("{stem}.conflict.{timestamp}{ext}"))
}

pub fn has_changes(repo_path: &Path) -> SyncResult<bool> {
    let repo = Repository::open(repo_path)?;
    let statuses = repo.statuses(Some(
        StatusOptions::new()
            .include_untracked(true)
            .recurse_untracked_dirs(true),
    ))?;
    Ok(!statuses.is_empty())
}

pub fn print_status(repo_path: &Path) -> SyncResult<()> {
    let repo = Repository::open(repo_path)?;
    let statuses = repo.statuses(Some(
        StatusOptions::new()
            .include_untracked(true)
            .recurse_untracked_dirs(true),
    ))?;

    if statuses.is_empty() {
        println!("Clean - no pending changes");
    } else {
        println!("{} file(s) with changes:", statuses.len());
        for entry in statuses.iter() {
            if let Some(path) = entry.path() {
                let status = entry.status();
                let marker = if status.is_conflicted() {
                    "CONFLICT"
                } else if status.is_wt_new() || status.is_index_new() {
                    "NEW"
                } else if status.is_wt_modified() || status.is_index_modified() {
                    "MODIFIED"
                } else if status.is_wt_deleted() || status.is_index_deleted() {
                    "DELETED"
                } else {
                    "?"
                };
                println!("  [{marker}] {path}");
            }
        }
    }
    Ok(())
}

pub fn list_conflicts(repo_path: &Path) {
    let pattern = ".conflict.";
    let mut found = false;

    if let Ok(entries) = walkdir(repo_path) {
        for entry in entries {
            if entry.to_string_lossy().contains(pattern) {
                if !found {
                    println!("Unresolved conflict files:");
                    found = true;
                }
                println!("  {}", entry.display());
            }
        }
    }

    if !found {
        println!("No conflict files found.");
    }
}

pub fn init_repo(path: &Path, remote_url: &str) -> SyncResult<()> {
    if path.join(".git").exists() {
        tracing::info!("Repository already exists at {}", path.display());
    } else {
        std::fs::create_dir_all(path)?;
        run_git(path, &["init"])?;
        run_git(path, &["remote", "add", "origin", remote_url])?;
        tracing::info!("Initialized repository at {}", path.display());
    }

    // Try initial pull
    let _ = run_git(path, &["pull", "origin", "main"]);

    println!("Repository ready: {}", path.display());
    println!("Remote: {remote_url}");
    Ok(())
}

fn run_git(repo_path: &Path, args: &[&str]) -> SyncResult<()> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git {} failed: {}", args.join(" "), stderr).into());
    }
    Ok(())
}

fn chrono_now() -> String {
    use std::time::SystemTime;
    let duration = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    // Simple timestamp: YYYYMMDD-HHMMSS (UTC)
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Approximate date calculation
    let mut y = 1970u64;
    let mut remaining_days = days;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        y += 1;
    }
    let months_days: [u64; 12] = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 1u64;
    for &md in &months_days {
        if remaining_days < md {
            break;
        }
        remaining_days -= md;
        m += 1;
    }
    let d = remaining_days + 1;

    format!("{y:04}{m:02}{d:02}-{hours:02}{minutes:02}{seconds:02}")
}

fn is_leap(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn walkdir(path: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut results = Vec::new();
    walk_recursive(path, &mut results)?;
    Ok(results)
}

fn walk_recursive(dir: &Path, results: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if dir.is_dir() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().map(|n| n == ".git").unwrap_or(false) {
                    continue;
                }
                walk_recursive(&path, results)?;
            } else {
                results.push(path);
            }
        }
    }
    Ok(())
}
