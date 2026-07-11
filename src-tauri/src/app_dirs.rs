//! Bundle-identifier constants and the one-time data-dir migration for the
//! v4.9 rename `com.laobu.mdeditor` → `net.notemd.app` (domain: notemd.net).
//!
//! macOS keys the per-app support dir (`~/Library/Application Support/<id>`)
//! by bundle identifier, so the rename would otherwise orphan settings.json,
//! themes/, sotvault caches, and window state. `com.laobu.mdeditor-shared`
//! is NOT migrated: shipped ExLibris builds read that path by name.

use std::path::Path;

pub const BUNDLE_ID: &str = "net.notemd.app";
pub const LEGACY_BUNDLE_ID: &str = "com.laobu.mdeditor";

/// Move the legacy app-support dir to the new identifier's location.
/// Runs at every process start (GUI and CLI); no-op unless the legacy dir
/// exists and the new one doesn't, so a downgraded app recreating the old
/// dir never clobbers migrated data.
pub fn migrate_legacy_app_support() {
    let Some(home) = dirs::home_dir() else { return };
    migrate_in(&home.join("Library/Application Support"));
}

fn migrate_in(base: &Path) {
    let old = base.join(LEGACY_BUNDLE_ID);
    let new = base.join(BUNDLE_ID);
    if old.is_dir() && !new.exists() {
        let _ = std::fs::rename(&old, &new);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn moves_legacy_dir_when_new_absent() {
        let tmp = TempDir::new().unwrap();
        let old = tmp.path().join(LEGACY_BUNDLE_ID);
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("settings.json"), "{}").unwrap();

        migrate_in(tmp.path());

        assert!(!old.exists());
        assert!(tmp.path().join(BUNDLE_ID).join("settings.json").exists());
    }

    #[test]
    fn keeps_new_dir_when_both_exist() {
        let tmp = TempDir::new().unwrap();
        let old = tmp.path().join(LEGACY_BUNDLE_ID);
        let new = tmp.path().join(BUNDLE_ID);
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("settings.json"), "old").unwrap();
        std::fs::create_dir(&new).unwrap();
        std::fs::write(new.join("settings.json"), "new").unwrap();

        migrate_in(tmp.path());

        assert_eq!(std::fs::read_to_string(new.join("settings.json")).unwrap(), "new");
        assert!(old.exists());
    }

    #[test]
    fn noop_when_legacy_absent() {
        let tmp = TempDir::new().unwrap();
        migrate_in(tmp.path());
        assert!(!tmp.path().join(BUNDLE_ID).exists());
    }
}
