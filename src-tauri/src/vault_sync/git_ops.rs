use std::path::Path;
use std::process::Command;

use super::SyncReport;

pub type GitResult<T> = Result<T, String>;

/// Returns the `git --version` string when the executable is present and
/// runnable, otherwise `None`. Used to surface "git unavailable" prominently
/// instead of silently reporting a healthy sync.
pub fn version() -> Option<String> {
    let output = Command::new("git").arg("--version").output().ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

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

/// git add -A,然后把超阈值文件撤出暂存(仍留在工作区),返回被排除清单。
fn stage_except_oversized(repo: &Path) -> GitResult<Vec<String>> {
    let oversized = super::large_files::detect_oversized(repo)?;
    run_git(repo, &["add", "-A"])?;
    for f in &oversized {
        let _ = run_git(repo, &["reset", "--", f]);
    }
    Ok(oversized)
}

/// 暂存区是否有待提交内容(用于提交守卫)。
fn has_staged(repo: &Path) -> bool {
    run_git(repo, &["diff", "--cached", "--quiet"]).is_err()
}

pub fn sync(repo: &Path, remote: &str, branch: &str) -> GitResult<SyncReport> {
    let has_remote = run_git(repo, &["remote", "get-url", remote]).is_ok();
    let mut skipped_large: Vec<String> = Vec::new();

    if has_remote {
        let fetch_ok = fetch(repo, remote, branch).is_ok();

        if !has_changes(repo)? {
            if fetch_ok {
                let ff = run_git(repo, &["pull", "--ff-only", remote, branch]);
                if ff.is_err() {
                    let _ = run_git(repo, &["pull", "--rebase", remote, branch]);
                }
            }
            return Ok(SyncReport { skipped_large });
        }

        skipped_large = stage_except_oversized(repo)?;

        if fetch_ok {
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

            // stash pop / 冲突处理会重新引入改动,再跑一次门禁保证大文件不漏网。
            let more = stage_except_oversized(repo)?;
            for f in more {
                if !skipped_large.contains(&f) {
                    skipped_large.push(f);
                }
            }
        }
    } else {
        if !has_changes(repo)? {
            return Ok(SyncReport { skipped_large });
        }
        skipped_large = stage_except_oversized(repo)?;
    }

    if has_staged(repo) {
        let ts = chrono_now();
        run_git(repo, &["commit", "-m", &format!("vault: auto-sync {ts}")])?;
    }

    if has_remote {
        let push = run_git(repo, &["push", remote, branch]);
        if let Err(e) = push {
            return Err(format!("push failed (will retry): {e}"));
        }
    }

    Ok(SyncReport { skipped_large })
}

fn chrono_now() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}

#[cfg(test)]
mod gate_tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn git(dir: &std::path::Path, args: &[&str]) {
        assert!(Command::new("git").args(args).current_dir(dir).status().unwrap().success());
    }

    fn init_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        git(dir.path(), &["init", "-q"]);
        git(dir.path(), &["config", "user.email", "t@t"]);
        git(dir.path(), &["config", "user.name", "t"]);
        dir
    }

    #[test]
    fn stage_except_oversized_leaves_big_file_unstaged() {
        let dir = init_repo();
        std::fs::write(dir.path().join("small.md"), "hi").unwrap();
        std::fs::write(dir.path().join("big.bin"), vec![b'x'; 11 * 1024 * 1024]).unwrap();
        let skipped = stage_except_oversized(dir.path()).unwrap();
        assert_eq!(skipped, vec!["big.bin".to_string()]);
        let staged = run_git(dir.path(), &["diff", "--cached", "--name-only"]).unwrap();
        assert!(staged.contains("small.md"));
        assert!(!staged.contains("big.bin"));
    }

    #[test]
    fn sync_no_remote_skips_big_and_commits_rest() {
        let dir = init_repo();
        std::fs::write(dir.path().join("note.md"), "content").unwrap();
        std::fs::write(dir.path().join("huge.bin"), vec![b'x'; 11 * 1024 * 1024]).unwrap();
        let report = sync(dir.path(), "origin", "main").unwrap();
        assert_eq!(report.skipped_large, vec!["huge.bin".to_string()]);
        let tree = run_git(dir.path(), &["ls-tree", "-r", "--name-only", "HEAD"]).unwrap();
        assert!(tree.contains("note.md"));
        assert!(!tree.contains("huge.bin"));
    }

    #[test]
    fn sync_only_big_file_makes_no_commit() {
        let dir = init_repo();
        std::fs::write(dir.path().join("seed.md"), "seed").unwrap();
        git(dir.path(), &["add", "seed.md"]);
        git(dir.path(), &["commit", "-q", "-m", "seed"]);
        let head_before = run_git(dir.path(), &["rev-parse", "HEAD"]).unwrap();
        std::fs::write(dir.path().join("only.bin"), vec![b'x'; 11 * 1024 * 1024]).unwrap();
        let report = sync(dir.path(), "origin", "main").unwrap();
        assert_eq!(report.skipped_large, vec!["only.bin".to_string()]);
        let head_after = run_git(dir.path(), &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(head_before, head_after, "不应产生空 commit");
    }
}
