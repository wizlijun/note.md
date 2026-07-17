//! Vault-scoped settings persisted to `{vault}/.notemd/settings.json` so they
//! travel with the git-synced vault. Holds the directory-name conventions
//! shared by sync-to-vault (`syncDir`) and outline notes (`wikipageDir`,
//! `dailynoteDir`). Missing fields fall back to per-field defaults.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const SETTINGS_DIR: &str = ".notemd";
const SETTINGS_FILE: &str = "settings.json";

/// Default sync sub-directory when unset/invalid.
pub const DEFAULT_SYNC_DIR: &str = "sync";

/// Raw parsed settings. Every field is optional: absent = "not configured",
/// so callers apply their own defaults (never persisted implicitly).
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wikipage_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dailynote_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub large_file_threshold_mb: Option<u32>,
}

fn settings_path(vault_root: &Path) -> PathBuf {
    vault_root.join(SETTINGS_DIR).join(SETTINGS_FILE)
}

/// Read settings; a missing file or malformed JSON both yield all-None
/// (this never errors — the vault should still open).
pub fn read(vault_root: &Path) -> VaultSettings {
    match std::fs::read_to_string(settings_path(vault_root)) {
        Ok(txt) => serde_json::from_str(&txt).unwrap_or_default(),
        Err(_) => VaultSettings::default(),
    }
}

/// Write settings, creating the `.notemd/` directory if needed.
pub fn write(vault_root: &Path, settings: &VaultSettings) -> Result<(), String> {
    let dir = vault_root.join(SETTINGS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let txt = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(vault_root), txt).map_err(|e| e.to_string())
}

/// Validate a vault-relative directory name. Rejects empty, absolute paths, and
/// any `..` segment; trims whitespace and collapses `.`/redundant separators.
pub fn validate_rel_dir(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("directory name is empty".into());
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return Err("directory must be relative".into());
    }
    let mut parts: Vec<&str> = Vec::new();
    for seg in trimmed.split(['/', '\\']) {
        let seg = seg.trim();
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err("directory must stay within the vault".into());
        }
        parts.push(seg);
    }
    if parts.is_empty() {
        return Err("directory name is empty".into());
    }
    Ok(parts.join("/"))
}

/// Merge caller-provided (Some) fields onto `base`, validating each provided
/// value. Fields left None keep their base value. Returns the first validation
/// error encountered.
pub fn merge(
    base: VaultSettings,
    sync_dir: Option<String>,
    wikipage_dir: Option<String>,
    dailynote_dir: Option<String>,
    large_file_threshold_mb: Option<u32>,
) -> Result<VaultSettings, String> {
    let mut out = base;
    if let Some(v) = sync_dir {
        out.sync_dir = Some(validate_rel_dir(&v)?);
    }
    if let Some(v) = wikipage_dir {
        out.wikipage_dir = Some(validate_rel_dir(&v)?);
    }
    if let Some(v) = dailynote_dir {
        out.dailynote_dir = Some(validate_rel_dir(&v)?);
    }
    if let Some(mb) = large_file_threshold_mb {
        if mb == 0 {
            return Err("large file threshold must be at least 1 MB".into());
        }
        out.large_file_threshold_mb = Some(mb);
    }
    Ok(out)
}

/// The effective sync sub-directory: the configured value when present and
/// valid, otherwise [`DEFAULT_SYNC_DIR`].
pub fn resolve_sync_dir(vault_root: &Path) -> String {
    read(vault_root)
        .sync_dir
        .and_then(|v| validate_rel_dir(&v).ok())
        .unwrap_or_else(|| DEFAULT_SYNC_DIR.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn read_missing_file_is_all_none() {
        let dir = TempDir::new().unwrap();
        assert_eq!(read(dir.path()), VaultSettings::default());
    }

    #[test]
    fn read_malformed_json_is_all_none() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join(SETTINGS_DIR)).unwrap();
        std::fs::write(settings_path(dir.path()), "{ not json").unwrap();
        assert_eq!(read(dir.path()), VaultSettings::default());
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = TempDir::new().unwrap();
        let s = VaultSettings {
            sync_dir: Some("sync".into()),
            wikipage_dir: Some("wiki".into()),
            dailynote_dir: None,
            large_file_threshold_mb: None,
        };
        write(dir.path(), &s).unwrap();
        assert_eq!(read(dir.path()), s);
    }

    #[test]
    fn write_creates_notemd_dir() {
        let dir = TempDir::new().unwrap();
        write(dir.path(), &VaultSettings::default()).unwrap();
        assert!(dir.path().join(SETTINGS_DIR).join(SETTINGS_FILE).is_file());
    }

    #[test]
    fn validate_accepts_relative_and_nested() {
        assert_eq!(validate_rel_dir("sync").unwrap(), "sync");
        assert_eq!(validate_rel_dir("  Sync  ").unwrap(), "Sync");
        assert_eq!(validate_rel_dir("Attachments/sync").unwrap(), "Attachments/sync");
        assert_eq!(validate_rel_dir("a//b/").unwrap(), "a/b");
    }

    #[test]
    fn validate_rejects_empty_absolute_and_dotdot() {
        assert!(validate_rel_dir("").is_err());
        assert!(validate_rel_dir("   ").is_err());
        assert!(validate_rel_dir("/abs").is_err());
        assert!(validate_rel_dir("../escape").is_err());
        assert!(validate_rel_dir("a/../b").is_err());
    }

    #[test]
    fn merge_keeps_untouched_fields() {
        let base = VaultSettings {
            sync_dir: Some("sync".into()),
            wikipage_dir: Some("wiki".into()),
            dailynote_dir: Some("daily".into()),
            large_file_threshold_mb: None,
        };
        let out = merge(base, Some("box".into()), None, None, None).unwrap();
        assert_eq!(out.sync_dir.as_deref(), Some("box"));
        assert_eq!(out.wikipage_dir.as_deref(), Some("wiki"));
        assert_eq!(out.dailynote_dir.as_deref(), Some("daily"));
    }

    #[test]
    fn merge_rejects_invalid_provided_value() {
        assert!(merge(VaultSettings::default(), Some("../x".into()), None, None, None).is_err());
    }

    #[test]
    fn resolve_sync_dir_defaults_when_unset() {
        let dir = TempDir::new().unwrap();
        assert_eq!(resolve_sync_dir(dir.path()), DEFAULT_SYNC_DIR);
    }

    #[test]
    fn resolve_sync_dir_uses_configured_value() {
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            &VaultSettings { sync_dir: Some("box".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(resolve_sync_dir(dir.path()), "box");
    }

    #[test]
    fn resolve_sync_dir_falls_back_when_configured_value_invalid() {
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            &VaultSettings { sync_dir: Some("../nope".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(resolve_sync_dir(dir.path()), DEFAULT_SYNC_DIR);
    }

    #[test]
    fn merge_sets_and_validates_threshold() {
        let out = merge(VaultSettings::default(), None, None, None, Some(25)).unwrap();
        assert_eq!(out.large_file_threshold_mb, Some(25));
        assert!(merge(VaultSettings::default(), None, None, None, Some(0)).is_err());
    }

    #[test]
    fn merge_keeps_threshold_when_none() {
        let base = VaultSettings { large_file_threshold_mb: Some(50), ..Default::default() };
        let out = merge(base, Some("box".into()), None, None, None).unwrap();
        assert_eq!(out.large_file_threshold_mb, Some(50));
    }

    #[test]
    fn threshold_round_trips() {
        let dir = TempDir::new().unwrap();
        let s = VaultSettings { large_file_threshold_mb: Some(10), ..Default::default() };
        write(dir.path(), &s).unwrap();
        assert_eq!(read(dir.path()), s);
    }
}
