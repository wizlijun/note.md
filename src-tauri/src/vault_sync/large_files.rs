//! 同步门禁:检测工作区里将要进 commit 的超阈值文件。阈值来自 vault 级
//! 配置 `{vault}/.notemd/settings.json`(随 git 同步),默认 10 MB。
//! 无状态:每轮 sync 重算,文件被用户挪走/压缩后清单自然为空。

use std::path::Path;

use super::git_ops::{run_git, GitResult};

/// 阈值缺省值(MB)。与前端 DEFAULT_LARGE_FILE_THRESHOLD_MB 对齐。
pub const DEFAULT_LARGE_FILE_THRESHOLD_MB: u32 = 10;

/// 从 vault 配置解析出有效阈值(字节)。缺省/0 → 默认 10 MB。
pub fn resolve_threshold_bytes(vault_root: &Path) -> u64 {
    let mb = crate::sotvault::vault_settings::read(vault_root)
        .large_file_threshold_mb
        .filter(|&m| m > 0)
        .unwrap_or(DEFAULT_LARGE_FILE_THRESHOLD_MB);
    mb as u64 * 1024 * 1024
}

/// 解析一行 `git status --porcelain` 输出,返回其"待提交"文件的工作区相对路径。
/// 只关心新进来的内容:untracked(`??`)与暂存/工作区的 A/M。忽略删除、重命名旧名。
fn pending_path(line: &str) -> Option<String> {
    if line.len() < 4 {
        return None;
    }
    let (status, rest) = line.split_at(2);
    let path = rest.trim();
    let x = status.as_bytes()[0];
    let y = status.as_bytes()[1];
    if status == "??" {
        return Some(unquote(path));
    }
    if x == b'D' || y == b'D' {
        return None;
    }
    if matches!(x, b'A' | b'M' | b'R' | b'C') || matches!(y, b'A' | b'M') {
        let name = path.rsplit(" -> ").next().unwrap_or(path);
        return Some(unquote(name));
    }
    None
}

/// git 对含空格/非 ASCII 的路径会加引号,这里只做最小去引号(去首尾双引号)。
fn unquote(p: &str) -> String {
    let t = p.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

/// 返回工作区里 size > 阈值 的待提交文件(相对 repo 根路径)。无法 stat 的条目安全跳过。
pub fn detect_oversized(repo: &Path) -> GitResult<Vec<String>> {
    let threshold = resolve_threshold_bytes(repo);
    let status = run_git(repo, &["-c", "core.quotepath=false", "status", "--porcelain"])?;
    let mut out = Vec::new();
    for line in status.lines() {
        let Some(rel) = pending_path(line) else { continue };
        let abs = repo.join(&rel);
        if let Ok(meta) = std::fs::metadata(&abs) {
            if meta.is_file() && meta.len() > threshold {
                out.push(rel);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").args(args).current_dir(dir).status().unwrap();
        assert!(ok.success(), "git {:?} failed", args);
    }

    fn init_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        git(dir.path(), &["init", "-q"]);
        dir
    }

    fn write_bytes(dir: &Path, name: &str, len: usize) {
        std::fs::write(dir.join(name), vec![b'x'; len]).unwrap();
    }

    #[test]
    fn detects_only_oversized_untracked() {
        let dir = init_repo();
        write_bytes(dir.path(), "small.bin", 1024);
        write_bytes(dir.path(), "big.bin", 11 * 1024 * 1024);
        let found = detect_oversized(dir.path()).unwrap();
        assert_eq!(found, vec!["big.bin".to_string()]);
    }

    #[test]
    fn threshold_boundary_is_strict_greater_than() {
        let dir = init_repo();
        write_bytes(dir.path(), "exact.bin", 10 * 1024 * 1024);
        write_bytes(dir.path(), "over.bin", 10 * 1024 * 1024 + 1);
        let mut found = detect_oversized(dir.path()).unwrap();
        found.sort();
        assert_eq!(found, vec!["over.bin".to_string()]);
    }

    #[test]
    fn detects_oversized_with_non_ascii_name() {
        let dir = init_repo();
        // 中文文件名,11 MB > 10 MB 默认阈值
        write_bytes(dir.path(), "大文件视频.bin", 11 * 1024 * 1024);
        let found = detect_oversized(dir.path()).unwrap();
        assert_eq!(found, vec!["大文件视频.bin".to_string()]);
    }

    #[test]
    fn respects_configured_threshold_from_vault_settings() {
        let dir = init_repo();
        crate::sotvault::vault_settings::write(
            dir.path(),
            &crate::sotvault::vault_settings::VaultSettings {
                large_file_threshold_mb: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        write_bytes(dir.path(), "six.bin", 6 * 1024 * 1024);
        let found = detect_oversized(dir.path()).unwrap();
        assert!(found.contains(&"six.bin".to_string()));
    }
}
