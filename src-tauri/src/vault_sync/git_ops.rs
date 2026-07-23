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

/// 本地 HEAD 是否领先 {remote}/{branch}(存在已 commit 未 push 的提交)。
/// 远端跟踪引用缺失(首推或从未 fetch 成功)按领先处理,交给 push 判定;
/// 空仓库(HEAD 未诞生)无可推,按不领先处理。
fn is_ahead(repo: &Path, remote: &str, branch: &str) -> bool {
    if run_git(repo, &["rev-parse", "--verify", "HEAD"]).is_err() {
        return false;
    }
    match run_git(repo, &["rev-list", "--count", &format!("{remote}/{branch}..HEAD")]) {
        Ok(n) => n.trim().parse::<u64>().map(|c| c > 0).unwrap_or(true),
        Err(_) => true,
    }
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
                    if let Err(e) = run_git(repo, &["pull", "--rebase", remote, branch]) {
                        let _ = run_git(repo, &["rebase", "--abort"]);
                        return Err(format!("pull --rebase failed, skipping cycle: {e}"));
                    }
                }
            }
            // 树干净≠已同步:上轮 commit 成功但 push 失败会留下滞留提交,
            // 不补推就 return Ok 会把失败盖成"Sync completed"且永不重试。
            if is_ahead(repo, remote, branch) {
                run_git(repo, &["push", remote, branch])
                    .map_err(|e| format!("push failed (will retry): {e}"))?;
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

    /// bare 远端 + 已推首个提交的工作仓库,返回 (work, bare)。
    fn init_remote_pair(root: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let bare = root.join("remote.git");
        git(root, &["init", "--bare", "-q", "remote.git"]);
        let work = root.join("work");
        std::fs::create_dir(&work).unwrap();
        git(&work, &["init", "-q", "-b", "main"]);
        git(&work, &["config", "user.email", "t@t"]);
        git(&work, &["config", "user.name", "t"]);
        git(&work, &["remote", "add", "origin", bare.to_str().unwrap()]);
        std::fs::write(work.join("note.md"), "base\n").unwrap();
        git(&work, &["add", "note.md"]);
        git(&work, &["commit", "-q", "-m", "seed"]);
        git(&work, &["push", "-q", "origin", "main"]);
        (work, bare)
    }

    #[test]
    fn push_failure_then_clean_cycle_retries_push() {
        let root = TempDir::new().unwrap();
        let (work, bare) = init_remote_pair(root.path());

        // 远端不可达的一轮:commit 落盘、push 失败
        let missing = root.path().join("missing.git");
        git(&work, &["remote", "set-url", "origin", missing.to_str().unwrap()]);
        std::fs::write(work.join("note.md"), "stranded\n").unwrap();
        let err = sync(&work, "origin", "main").unwrap_err();
        assert!(err.contains("push failed"), "unexpected error: {err}");

        // 远端恢复后的下一轮:工作区已干净,必须补推滞留提交
        git(&work, &["remote", "set-url", "origin", bare.to_str().unwrap()]);
        sync(&work, "origin", "main").unwrap();

        let local = run_git(&work, &["rev-parse", "HEAD"]).unwrap();
        let remote_head = run_git(&bare, &["rev-parse", "main"]).unwrap();
        assert_eq!(local.trim(), remote_head.trim(), "干净树周期应补推滞留提交");

        // 已同步的干净树再跑一轮仍应成功
        sync(&work, "origin", "main").unwrap();
    }

    #[test]
    fn clean_tree_diverged_conflict_surfaces_error() {
        let root = TempDir::new().unwrap();
        let (work, _bare) = init_remote_pair(root.path());

        // 另一设备对同一文件推进冲突提交
        let other = root.path().join("other");
        git(root.path(), &["clone", "-q", "remote.git", "other"]);
        git(&other, &["config", "user.email", "o@o"]);
        git(&other, &["config", "user.name", "o"]);
        std::fs::write(other.join("note.md"), "theirs\n").unwrap();
        git(&other, &["commit", "-q", "-am", "theirs"]);
        git(&other, &["push", "-q", "origin", "main"]);

        // 本地滞留一个冲突提交,工作区干净
        std::fs::write(work.join("note.md"), "ours\n").unwrap();
        git(&work, &["commit", "-q", "-am", "ours"]);

        let err = sync(&work, "origin", "main").unwrap_err();
        assert!(err.contains("pull --rebase failed"), "unexpected error: {err}");
        assert!(
            !work.join(".git/rebase-merge").exists() && !work.join(".git/rebase-apply").exists(),
            "不应停留在 rebase 中间态"
        );
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
