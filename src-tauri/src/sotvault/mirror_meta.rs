//! Git-synced, per-mirror metadata under `{vault}/.notemd/mirrors/`. One file
//! per mirror per device (`{stem}.{deviceId8}.json`) so different devices never
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

/// Meta file path for a mirror+device: `{dir}/{stem}.{deviceId8}.json`, where
/// `stem` is the mirror md's file stem and `deviceId8` its first 8 chars.
pub fn meta_path(vault_root: &Path, mirror_rel: &str, device_id: &str) -> PathBuf {
    let stem = Path::new(mirror_rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("mirror");
    let dev8: String = device_id.chars().take(8).collect();
    meta_dir(vault_root).join(format!("{stem}.{dev8}.json"))
}

/// Write one mirror meta, creating `.notemd/mirrors/` as needed.
pub fn write(vault_root: &Path, meta: &MirrorMeta) -> Result<(), String> {
    let dir = meta_dir(vault_root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = meta_path(vault_root, &meta.mirror, &meta.device_id);
    let txt = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    std::fs::write(path, txt).map_err(|e| e.to_string())
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
                out.push(m);
            }
        }
    }
    out
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
    fn meta_path_uses_stem_and_device8() {
        let p = meta_path(Path::new("/v"), "sync/2026-07-16-foo.md", "550e8400-e29b-41d4");
        assert_eq!(p, Path::new("/v/.notemd/mirrors/2026-07-16-foo.550e8400.json"));
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
