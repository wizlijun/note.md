//! Install / uninstall / repair the `mdedit` symlink.
//!
//! macOS-only in v1. Uses `osascript -e 'do shell script ... with
//! administrator privileges'` for paths that require elevation.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Serialize)]
pub struct InstallStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub target_valid: bool,
}

pub fn current_app_binary() -> PathBuf {
    std::env::current_exe()
        .unwrap_or_else(|_| PathBuf::from("/Applications/M↓.app/Contents/MacOS/M↓"))
}

pub fn candidate_dirs() -> Vec<PathBuf> {
    let mut out = vec![
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        out.push(Path::new(&home).join(".local/bin"));
    }
    out
}

/// POSIX-escape a string so it can be embedded inside a single-quoted shell
/// argument. Replaces `'` with `'\''` (close-quote, escaped quote, open-quote).
fn sh_single_quote_escape(s: &str) -> String {
    s.replace('\'', "'\\''")
}

fn assert_candidate(dir: &str) -> Result<(), String> {
    let candidates = candidate_dirs();
    let path = std::path::Path::new(dir);
    if candidates.iter().any(|c| c == path) {
        Ok(())
    } else {
        Err(format!(
            "mdedit: refusing to install into '{dir}' — only candidate dirs are allowed"
        ))
    }
}

pub fn install(dir: &Path) -> Result<bool, String> {
    let target = current_app_binary();
    if !target.exists() {
        return Err(format!("source binary missing: {}", target.display()));
    }
    let link = dir.join("mdedit");

    let need_sudo = matches!(dir.to_str(), Some("/usr/local/bin") | Some("/opt/homebrew/bin"));

    if !need_sudo {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        if link.symlink_metadata().is_ok() {
            std::fs::remove_file(&link).map_err(|e| e.to_string())?;
        }
        std::os::unix::fs::symlink(&target, &link).map_err(|e| e.to_string())?;
        return Ok(true);
    }

    let script = format!(
        "mkdir -p '{dir}' && ln -sfn '{target}' '{link}'",
        dir = sh_single_quote_escape(&dir.display().to_string()),
        target = sh_single_quote_escape(&target.display().to_string()),
        link = sh_single_quote_escape(&link.display().to_string()),
    );
    let status = Command::new("osascript")
        .args(["-e", &format!("do shell script \"{}\" with administrator privileges",
            script.replace('"', "\\\""))])
        .status()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if !status.success() {
        return Err(format!("osascript exited {}", status.code().unwrap_or(-1)));
    }
    Ok(true)
}

pub fn uninstall(dir: &Path) -> Result<(), String> {
    let link = dir.join("mdedit");
    if link.symlink_metadata().is_err() {
        return Ok(());
    }
    let need_sudo = matches!(dir.to_str(), Some("/usr/local/bin") | Some("/opt/homebrew/bin"));
    if !need_sudo {
        std::fs::remove_file(&link).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let script = format!(
        "rm -f '{}'",
        sh_single_quote_escape(&link.display().to_string())
    );
    let status = Command::new("osascript")
        .args(["-e", &format!("do shell script \"{}\" with administrator privileges",
            script.replace('"', "\\\""))])
        .status()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if !status.success() {
        return Err(format!("osascript exited {}", status.code().unwrap_or(-1)));
    }
    Ok(())
}

pub fn status(installed_path: Option<&Path>) -> InstallStatus {
    if let Some(p) = installed_path {
        if p.exists() {
            let resolved = std::fs::read_link(p).ok();
            let current = current_app_binary();
            let target_valid = resolved.as_deref().map(|r| r == current).unwrap_or(false);
            return InstallStatus {
                installed: true,
                path: Some(p.display().to_string()),
                target_valid,
            };
        }
    }
    for dir in candidate_dirs() {
        let link = dir.join("mdedit");
        if link.exists() {
            let resolved = std::fs::read_link(&link).ok();
            let current = current_app_binary();
            let target_valid = resolved.as_deref().map(|r| r == current).unwrap_or(false);
            return InstallStatus {
                installed: true,
                path: Some(link.display().to_string()),
                target_valid,
            };
        }
    }
    InstallStatus { installed: false, path: None, target_valid: false }
}

#[tauri::command]
pub fn cli_install_status() -> InstallStatus {
    status(None)
}

#[tauri::command]
pub fn cli_install(dir: String) -> Result<(), String> {
    assert_candidate(&dir)?;
    install(Path::new(&dir)).map(|_| ())
}

#[tauri::command]
pub fn cli_uninstall(dir: String) -> Result<(), String> {
    assert_candidate(&dir)?;
    uninstall(Path::new(&dir))
}

#[tauri::command]
pub fn cli_install_candidates() -> Vec<String> {
    candidate_dirs().into_iter().map(|p| p.display().to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink as unix_symlink;

    #[test]
    fn status_reports_installed_when_link_present() {
        let dir = std::env::temp_dir().join(format!("mdedit-status-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let link = dir.join("mdedit");
        let target = std::env::current_exe().unwrap();
        unix_symlink(&target, &link).unwrap();

        let st = status(Some(&link));
        assert!(st.installed);
        assert_eq!(st.path.as_deref(), Some(link.display().to_string().as_str()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_reports_not_installed_when_no_link() {
        let st = status(Some(Path::new("/this/does/not/exist/mdedit")));
        assert!(!st.installed);
    }

    #[test]
    fn install_creates_symlink_in_writable_dir() {
        let dir = std::env::temp_dir().join(format!("mdedit-install-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let ok = install(&dir).unwrap();
        assert!(ok);
        let link = dir.join("mdedit");
        assert!(link.symlink_metadata().is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn uninstall_removes_existing_symlink() {
        let dir = std::env::temp_dir().join(format!("mdedit-uninst-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        install(&dir).unwrap();
        uninstall(&dir).unwrap();
        assert!(dir.join("mdedit").symlink_metadata().is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cli_install_rejects_arbitrary_dir() {
        // Calling assert_candidate directly since cli_install is a Tauri command.
        let r = assert_candidate("/tmp/whatever");
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("only candidate dirs"));
    }

    #[test]
    fn cli_install_accepts_candidate_dirs() {
        let cands = candidate_dirs();
        // First candidate is /usr/local/bin (or /opt/homebrew/bin on Apple Silicon)
        let r = assert_candidate(&cands[0].display().to_string());
        assert!(r.is_ok());
    }

    #[test]
    fn sh_single_quote_escape_handles_quote() {
        assert_eq!(sh_single_quote_escape("a'b"), "a'\\''b");
        assert_eq!(sh_single_quote_escape("no quotes"), "no quotes");
        assert_eq!(sh_single_quote_escape("'"), "'\\''");
    }
}
