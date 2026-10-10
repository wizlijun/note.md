//! Git-synced, per-mirror metadata under `{vault}/.notemd/mirrors/`. One file
//! per mirror per device (full relative-path hash + device hash) so different devices never
//! touch the same file — no cross-device git conflicts (same partitioning idea
//! as recents `<deviceId>.json` and analytics `<day>.<deviceId>.json`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const META_SUBDIR: &str = ".notemd/mirrors";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorMeta {
    /// Vault-relative path of the mirror md, e.g. `sync/2026-07-16-foo.md`.
    pub mirror: String,
    /// Same UUID recents/analytics use (frontend `getDeviceId()`).
    pub device_id: String,
    /// Human-readable label (hostname); display only.
    pub device_name: String,
    /// Absolute path of the original file on `device_id`'s machine.
    pub source: String,
    /// Unix epoch seconds of the last sync.
    pub synced_at: u64,
    /// Checksum of the last-synced mirror content, e.g. `sha256:abcd…`.
    pub checksum: String,
}

/// Directory holding all mirror meta files for a vault.
pub fn meta_dir(vault_root: &Path) -> PathBuf {
    vault_root.join(META_SUBDIR)
}

/// The mirror md path relative to the vault root (forward slashes), or the
/// original string when `vault_path` is not under `vault_root`.
pub fn relative_mirror(vault_root: &Path, vault_path: &Path) -> String {
    match vault_path.strip_prefix(vault_root) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => vault_path.to_string_lossy().to_string(),
    }
}

/// Metadata key uses the complete mirror-relative path and complete device id.
pub fn meta_path(vault_root: &Path, mirror_rel: &str, device_id: &str) -> PathBuf {
    let key = super::logic::sha256_hex(mirror_rel.as_bytes());
    let device = super::logic::sha256_hex(device_id.as_bytes());
    meta_dir(vault_root).join(format!("{key}.{device}.json"))
}

/// Write one mirror meta, creating `.notemd/mirrors/` as needed.
pub fn write(vault_root: &Path, meta: &MirrorMeta) -> Result<(), String> {
    let dir = meta_dir(vault_root);
    let path = meta_path(vault_root, &meta.mirror, &meta.device_id);
    for candidate in [vault_root.join(".notemd"), dir.clone(), path.clone()] {
        if std::fs::symlink_metadata(&candidate).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("symlink in mirror metadata path".into());
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let txt = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    std::fs::write(path, txt).map_err(|e| e.to_string())
}

/// Refresh all known device metadata for this mirror. Old stem-based metadata
/// remains readable; writes use the full relative path key.
pub fn refresh_checksums(vault_root: &Path, mirror: &Path, hash: &str) -> Result<(), String> {
    let relative = relative_mirror(vault_root, mirror);
    for mut meta in read_all(vault_root).into_iter().filter(|m| m.mirror == relative) {
        meta.checksum = format!("sha256:{hash}");
        meta.synced_at = super::now_secs();
        write(vault_root, &meta)?;
    }
    Ok(())
}

/// Distinct sibling mirrors of `mirror_rel`: metas with the same `checksum` but
/// a DIFFERENT mirror path (i.e. the same content mirrored as a separate file,
/// typically on another device). Deduped to one entry per distinct mirror path.
pub fn sibling_mirrors(metas: &[MirrorMeta], mirror_rel: &str, checksum: &str) -> Vec<MirrorMeta> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for m in metas {
        if m.checksum == checksum && m.mirror != mirror_rel && seen.insert(m.mirror.clone()) {
            out.push(m.clone());
        }
    }
    out
}

/// Read every mirror meta in the vault; corrupt/unparseable files are skipped.
pub fn read_all(vault_root: &Path) -> Vec<MirrorMeta> {
    let dir = meta_dir(vault_root);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for ent in entries.flatten() {
        let p = ent.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(txt) = std::fs::read_to_string(&p) {
            if let Ok(m) = serde_json::from_str::<MirrorMeta>(&txt) {
                // Prefer refreshed full-path metadata over its historic stem key.
                let current = meta_path(vault_root, &m.mirror, &m.device_id);
                if p != current && current.exists() { continue; }
                out.push(m);
            }
        }
    }
    let mut unique = std::collections::BTreeMap::new();
    for meta in out {
        let key = (meta.mirror.clone(), meta.device_id.clone());
        if unique.get(&key).is_none_or(|prior: &MirrorMeta| prior.synced_at <= meta.synced_at) { unique.insert(key, meta); }
    }
    unique.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn meta(mirror: &str, dev: &str, src: &str) -> MirrorMeta {
        MirrorMeta {
            mirror: mirror.into(),
            device_id: dev.into(),
            device_name: "Test-Mac".into(),
            source: src.into(),
            synced_at: 100,
            checksum: "sha256:abc".into(),
        }
    }

    #[test]
    fn relative_mirror_strips_vault_root() {
        let root = Path::new("/v");
        assert_eq!(relative_mirror(root, Path::new("/v/sync/2026-07-16-foo.md")), "sync/2026-07-16-foo.md");
    }

    #[test]
    fn relative_mirror_passthrough_when_outside() {
        assert_eq!(relative_mirror(Path::new("/v"), Path::new("/other/x.md")), "/other/x.md");
    }

    #[test]
    fn meta_path_uses_full_relative_path_and_device() {
        let p = meta_path(Path::new("/v"), "sync/2026-07-16-foo.md", "550e8400-e29b-41d4");
        assert_ne!(p, meta_path(Path::new("/v"), "other/2026-07-16-foo.md", "550e8400-e29b-41d4"));
        assert_ne!(p, meta_path(Path::new("/v"), "sync/2026-07-16-foo.md", "550e8400-different"));
    }

    #[test]
    fn write_then_read_all_round_trips() {
        let dir = TempDir::new().unwrap();
        let m = meta("sync/2026-07-16-foo.md", "550e8400-e29b", "/Users/bruce/Downloads/foo.md");
        write(dir.path(), &m).unwrap();
        let all = read_all(dir.path());
        assert_eq!(all, vec![m]);
    }

    #[test]
    fn legacy_metadata_is_read_and_refresh_prefers_full_path_key() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(meta_dir(dir.path())).unwrap();
        let old = meta("sync/p/docs/a.md", "device-id", "/source/a.md");
        std::fs::write(meta_dir(dir.path()).join("a.device-i.json"), serde_json::to_vec(&old).unwrap()).unwrap();
        assert_eq!(read_all(dir.path()).len(), 1);
        refresh_checksums(dir.path(), &dir.path().join(&old.mirror), "newhash").unwrap();
        let read = read_all(dir.path());
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].checksum, "sha256:newhash");
    }

    #[test]
    fn read_all_skips_corrupt_and_missing_dir() {
        let dir = TempDir::new().unwrap();
        assert!(read_all(dir.path()).is_empty()); // no dir yet
        std::fs::create_dir_all(meta_dir(dir.path())).unwrap();
        std::fs::write(meta_dir(dir.path()).join("bad.deadbeef.json"), "{ not json").unwrap();
        write(dir.path(), &meta("sync/a.md", "d", "/s/a.md")).unwrap();
        assert_eq!(read_all(dir.path()).len(), 1);
    }

    #[test]
    fn sibling_mirrors_same_checksum_distinct_files() {
        let metas = vec![
            meta("sync/a.md", "d1", "/a/x.md"),        // checksum sha256:abc (helper default)
            meta("sync/b.md", "d2", "/b/x.md"),        // same content, other device/file
            meta("sync/a.md", "d3", "/c/x.md"),        // same mirror as #1 → not a sibling
        ];
        let sibs = sibling_mirrors(&metas, "sync/a.md", "sha256:abc");
        assert_eq!(sibs.len(), 1);
        assert_eq!(sibs[0].mirror, "sync/b.md");
    }

    #[test]
    fn sibling_mirrors_ignores_other_checksums_and_self() {
        let mut other = meta("sync/c.md", "d9", "/d/y.md");
        other.checksum = "sha256:zzz".into();
        let metas = vec![meta("sync/a.md", "d1", "/a/x.md"), other];
        assert!(sibling_mirrors(&metas, "sync/a.md", "sha256:abc").is_empty());
    }

    #[test]
    fn two_devices_same_mirror_are_separate_files() {
        let dir = TempDir::new().unwrap();
        write(dir.path(), &meta("sync/foo.md", "aaaaaaaa-1", "/a/foo.md")).unwrap();
        write(dir.path(), &meta("sync/foo.md", "bbbbbbbb-2", "/b/foo.md")).unwrap();
        assert_eq!(read_all(dir.path()).len(), 2);
    }
}
