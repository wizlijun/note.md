use std::path::Path;
use std::process::Command;

pub type GitResult<T> = Result<T, String>;

pub fn run_git(repo: &Path, args: &[&str]) -> GitResult<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("git spawn: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

pub fn has_changes(repo: &Path) -> GitResult<bool> {
    let out = run_git(repo, &["status", "--porcelain"])?;
    Ok(!out.trim().is_empty())
}

pub fn fetch(repo: &Path, remote: &str, branch: &str) -> GitResult<()> {
    run_git(repo, &["fetch", remote, branch])?;
    Ok(())
}

pub fn sync(repo: &Path, remote: &str, branch: &str) -> GitResult<()> {
    fetch(repo, remote, branch)?;

    if !has_changes(repo)? {
        let ff = run_git(repo, &["pull", "--ff-only", remote, branch]);
        if ff.is_err() {
            run_git(repo, &["pull", "--rebase", remote, branch])?;
        }
        return Ok(());
    }

    run_git(repo, &["add", "-A"])?;
    run_git(repo, &["stash", "push", "-m", "vaultgitsync-auto"])?;

    let rebase = run_git(repo, &["rebase", &format!("{remote}/{branch}")]);
    if rebase.is_err() {
        let _ = run_git(repo, &["rebase", "--abort"]);
        let _ = run_git(repo, &["stash", "pop"]);
        return Err("rebase failed, skipping cycle".into());
    }

    let pop = run_git(repo, &["stash", "pop"]);
    if pop.is_err() {
        super::conflict::handle_conflicts(repo)?;
    }

    run_git(repo, &["add", "-A"])?;

    if has_changes(repo)? {
        let ts = chrono_now();
        run_git(repo, &["commit", "-m", &format!("vault: auto-sync {ts}")])?;
    }

    let push = run_git(repo, &["push", remote, branch]);
    if let Err(e) = push {
        return Err(format!("push failed (will retry): {e}"));
    }

    Ok(())
}

fn chrono_now() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}
