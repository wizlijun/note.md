//! File-level git history for vault files. Reuses `vault_sync::git_ops` to run
//! `git log`/`git show` against the vault repo. Desktop-only in practice
//! (commands are registered only in the non-iOS invoke handler).

use std::path::Path;

use crate::vault_sync::git_ops;

/// One commit that touched a given file. `timestamp` is Unix seconds (author date).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub timestamp: i64,
    pub subject: String,
}

/// The field separator we embed in the `git log --format` string (ASCII Unit
/// Separator, 0x1f — will never appear in a one-line subject).
const FS: char = '\u{1f}';

/// Parse the `git log --format=%H<FS>%h<FS>%an<FS>%at<FS>%s` output (one commit
/// per line) into structured commits. Blank lines and malformed lines are skipped.
pub fn parse_log(stdout: &str) -> Vec<GitCommit> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(5, FS);
            let hash = parts.next()?.trim().to_string();
            if hash.is_empty() {
                return None;
            }
            let short = parts.next()?.trim().to_string();
            let author = parts.next()?.trim().to_string();
            let timestamp = parts.next()?.trim().parse::<i64>().ok()?;
            let subject = parts.next().unwrap_or("").trim().to_string();
            Some(GitCommit { hash, short, author, timestamp, subject })
        })
        .collect()
}

/// The repo-relative, forward-slashed path of `abs` under `repo`. Errors when
/// `abs` is not under `repo`.
pub fn rel_path(repo: &Path, abs: &Path) -> Result<String, String> {
    let rel = abs
        .strip_prefix(repo)
        .map_err(|_| "file is not under the vault repo".to_string())?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn parse_log_reads_fields() {
        let fs = '\u{1f}';
        let line = format!("abcdef123456{fs}abcdef1{fs}Jane Doe{fs}1700000000{fs}fix: a thing");
        let out = parse_log(&format!("{line}\n"));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].hash, "abcdef123456");
        assert_eq!(out[0].short, "abcdef1");
        assert_eq!(out[0].author, "Jane Doe");
        assert_eq!(out[0].timestamp, 1_700_000_000);
        assert_eq!(out[0].subject, "fix: a thing");
    }

    #[test]
    fn parse_log_skips_blank_and_malformed() {
        let fs = '\u{1f}';
        let good = format!("h{fs}s{fs}a{fs}123{fs}subj");
        let bad = format!("h{fs}s{fs}a{fs}notanumber{fs}subj");
        let out = parse_log(&format!("\n{good}\n{bad}\n\n"));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].subject, "subj");
    }

    #[test]
    fn rel_path_forward_slashes_under_repo() {
        let repo = PathBuf::from("/vault");
        let abs = PathBuf::from("/vault/Sync/note.md");
        assert_eq!(rel_path(&repo, &abs).unwrap(), "Sync/note.md");
    }

    #[test]
    fn rel_path_rejects_outside() {
        let repo = PathBuf::from("/vault");
        let abs = PathBuf::from("/elsewhere/note.md");
        assert!(rel_path(&repo, &abs).is_err());
    }
}
