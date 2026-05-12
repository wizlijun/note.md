use std::path::Path;
use super::git_ops::{run_git, GitResult};

pub fn handle_conflicts(repo: &Path) -> GitResult<()> {
    let status = run_git(repo, &["status", "--porcelain"])?;
    let timestamp = ts_now();

    for line in status.lines() {
        if line.starts_with("UU ") || line.starts_with("AA ") {
            let file = line[3..].trim();
            let file_path = repo.join(file);

            if file_path.exists() {
                let conflict_name = make_conflict_name(file, &timestamp);
                let conflict_path = repo.join(&conflict_name);
                let _ = std::fs::copy(&file_path, &conflict_path);
            }

            let _ = run_git(repo, &["checkout", "--theirs", file]);
            let _ = run_git(repo, &["add", file]);
        }
    }

    run_git(repo, &["add", "-A"])?;
    Ok(())
}

fn make_conflict_name(file: &str, timestamp: &str) -> String {
    let path = Path::new(file);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let parent = path.parent().unwrap_or(Path::new(""));
    parent.join(format!("{stem}.conflict.{timestamp}{ext}")).to_string_lossy().to_string()
}

fn ts_now() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}
