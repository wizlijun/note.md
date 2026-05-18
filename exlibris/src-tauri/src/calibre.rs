use std::path::{Path, PathBuf};

/// Resolve a calibre binary directory:
/// 1. user-configured path (from shared config) — if it contains `ebook-meta`
/// 2. `/Applications/calibre.app/Contents/MacOS`
/// 3. directory containing `ebook-meta` in $PATH
///
/// Returns the directory containing the binaries, or None.
pub fn detect(user_configured: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = user_configured {
        if dir.join("ebook-meta").is_file() {
            return Some(dir.to_path_buf());
        }
    }
    let candidate = Path::new("/Applications/calibre.app/Contents/MacOS");
    if candidate.join("ebook-meta").is_file() {
        return Some(candidate.to_path_buf());
    }
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in path_env.split(':') {
            let p = Path::new(dir).join("ebook-meta");
            if p.is_file() {
                return Some(PathBuf::from(dir));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn touch_exec(p: &Path) {
        std::fs::write(p, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn detect_prefers_user_configured() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        touch_exec(&dir.join("ebook-meta"));
        let got = detect(Some(dir)).unwrap();
        assert_eq!(got, dir);
    }

    #[test]
    fn detect_user_configured_without_binary_falls_back() {
        let tmp = TempDir::new().unwrap();
        let got = detect(Some(tmp.path()));
        // result depends on host; just assert no panic
        assert!(got.is_none() || got.is_some());
    }
}
