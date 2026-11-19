//! `<app_data>/plugins/state.json` — the single source of truth for which
//! v2 plugins are installed and enabled (spec §3).

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::{Path, PathBuf}};

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct InstallState { #[serde(default)] pub installed: BTreeMap<String, InstalledPlugin> }

#[derive(Debug, Serialize, Deserialize)]
pub struct InstalledPlugin { pub version: String, pub enabled: bool }

pub fn plugins_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    tauri::Manager::path(app).app_data_dir().ok().map(|d| d.join("plugins"))
}

pub fn load(root: &Path) -> InstallState {
    std::fs::read(root.join("state.json")).ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// A complete inventory may be empty only when no state exists yet or it parses as empty.
pub fn load_strict(root: &Path) -> Result<InstallState, String> {
    let path = root.join("state.json");
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(InstallState::default()),
        Err(error) => return Err(format!("cannot read plugin install state {}: {error}", path.display())),
    };
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("cannot parse plugin install state {}: {error}", path.display()))
}

pub fn save(root: &Path, s: &InstallState) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let tmp = root.join("state.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, root.join("state.json")).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_load_allows_first_launch_and_valid_empty_state() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_strict(&dir.path().join("missing-plugins")).unwrap().installed.is_empty());
        std::fs::write(dir.path().join("state.json"), r#"{"installed":{}}"#).unwrap();
        assert!(load_strict(dir.path()).unwrap().installed.is_empty());
    }

    #[test]
    fn strict_load_rejects_corrupt_state_instead_of_claiming_empty() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("state.json"), "{ not json").unwrap();
        assert!(load_strict(dir.path()).is_err());
    }

    #[test]
    fn strict_load_rejects_io_failure_instead_of_claiming_empty() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("state.json")).unwrap();
        assert!(load_strict(dir.path()).is_err());
    }

    #[test]
    fn round_trip_and_atomic_write() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("plugins"); // save must create it
        let mut s = InstallState::default();
        s.installed.insert(
            "notemd.md2pdf".into(),
            InstalledPlugin { version: "1.0.0".into(), enabled: true },
        );
        s.installed.insert(
            "notemd.other".into(),
            InstalledPlugin { version: "0.2.0".into(), enabled: false },
        );
        save(&root, &s).unwrap();

        // Atomic write: the temp file must be gone after a successful save.
        assert!(!root.join("state.json.tmp").exists(), "tmp file must be renamed away");
        assert!(root.join("state.json").is_file());

        let loaded = load(&root);
        assert_eq!(loaded.installed.len(), 2);
        let p = &loaded.installed["notemd.md2pdf"];
        assert_eq!(p.version, "1.0.0");
        assert!(p.enabled);
        let q = &loaded.installed["notemd.other"];
        assert_eq!(q.version, "0.2.0");
        assert!(!q.enabled);
    }

    #[test]
    fn load_defaults_when_missing_or_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        // Missing file ⇒ default
        assert!(load(dir.path()).installed.is_empty());
        // Corrupt file ⇒ default
        std::fs::write(dir.path().join("state.json"), "{ not json").unwrap();
        assert!(load(dir.path()).installed.is_empty());
    }
}
