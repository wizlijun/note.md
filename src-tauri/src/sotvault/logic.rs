use super::store::Record;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// SHA-256 hex digest of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

/// Outcome of checking whether an opened vault copy needs updating from source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateOutcome {
    NotTracked,
    SourceMissing,
    UpToDate,
    OriginUpdated,
    Conflict,
}

/// Pure decision: compare current on-disk hashes against the record's
/// last-sync fingerprints. One-directional + conflict-aware:
/// - source unchanged  -> UpToDate (regardless of vault side)
/// - source changed, vault untouched -> OriginUpdated
/// - source changed, vault also changed -> Conflict
pub fn decide_update(record: &Record, source_now: &str, vault_now: &str) -> UpdateOutcome {
    if source_now == record.source_hash {
        return UpdateOutcome::UpToDate;
    }
    if vault_now == record.vault_hash {
        UpdateOutcome::OriginUpdated
    } else {
        UpdateOutcome::Conflict
    }
}

/// Read source + vault files and decide. Missing source -> SourceMissing.
pub fn check_update_io(record: &Record, source: &Path, vault: &Path) -> Result<UpdateOutcome, String> {
    if !source.exists() {
        return Ok(UpdateOutcome::SourceMissing);
    }
    let src = std::fs::read(source).map_err(|e| e.to_string())?;
    let vlt = std::fs::read(vault).map_err(|e| e.to_string())?;
    Ok(decide_update(record, &sha256_hex(&src), &sha256_hex(&vlt)))
}

/// Pick a non-colliding destination inside `dir` for `basename`. If
/// `dir/basename` is free, return it; otherwise append `-2`, `-3`, ... before
/// the extension. `exists` decides occupancy (injected for testability).
pub fn dedup_target(dir: &Path, basename: &str, exists: &dyn Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(basename);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = split_ext(basename);
    let mut n = 2;
    loop {
        let candidate = match &ext {
            Some(e) => dir.join(format!("{stem}-{n}.{e}")),
            None => dir.join(format!("{stem}-{n}")),
        };
        if !exists(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

fn split_ext(name: &str) -> (String, Option<String>) {
    match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), Some(name[i + 1..].to_string())),
        _ => (name.to_string(), None),
    }
}

/// True when `file` is inside `vault_root`.
pub fn is_under_vault(vault_root: &Path, file: &Path) -> bool {
    file.starts_with(vault_root)
}

/// True when `name`'s extension is `md` (case-insensitive).
fn is_markdown(name: &str) -> bool {
    match name.rfind('.') {
        Some(i) if i + 1 < name.len() => name[i + 1..].eq_ignore_ascii_case("md"),
        _ => false,
    }
}

/// True when `name` already starts with a `yyyy-MM-dd-` prefix.
fn has_date_prefix(name: &str) -> bool {
    let b = name.as_bytes();
    if b.len() < 11 {
        return false;
    }
    let d = |i: usize| b[i].is_ascii_digit();
    d(0) && d(1) && d(2) && d(3)
        && b[4] == b'-'
        && d(5) && d(6)
        && b[7] == b'-'
        && d(8) && d(9)
        && b[10] == b'-'
}

/// For Markdown files lacking a `yyyy-MM-dd-` prefix, prepend `<date_prefix>-`.
/// Non-Markdown files and already-dated names are returned unchanged.
pub fn dated_basename(basename: &str, date_prefix: &str) -> String {
    if !is_markdown(basename) || has_date_prefix(basename) {
        return basename.to_string();
    }
    format!("{date_prefix}-{basename}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn rec(source_hash: &str, vault_hash: &str) -> Record {
        Record {
            vault_path: "/vault/a.md".into(),
            source_path: "/src/a.md".into(),
            synced_at: 1,
            source_hash: source_hash.into(),
            vault_hash: vault_hash.into(),
        }
    }

    #[test]
    fn sha256_is_stable() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn source_unchanged_is_up_to_date() {
        let r = rec("S", "V");
        assert_eq!(decide_update(&r, "S", "V"), UpdateOutcome::UpToDate);
        // vault drift alone never prompts
        assert_eq!(decide_update(&r, "S", "V2"), UpdateOutcome::UpToDate);
    }

    #[test]
    fn source_changed_vault_intact_is_origin_updated() {
        let r = rec("S", "V");
        assert_eq!(decide_update(&r, "S2", "V"), UpdateOutcome::OriginUpdated);
    }

    #[test]
    fn both_changed_is_conflict() {
        let r = rec("S", "V");
        assert_eq!(decide_update(&r, "S2", "V2"), UpdateOutcome::Conflict);
    }

    #[test]
    fn check_update_io_reports_source_missing() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("a.md");
        std::fs::write(&vault, b"x").unwrap();
        let mut r = rec("S", "V");
        r.source_path = tmp.path().join("missing.md").to_string_lossy().into();
        r.vault_path = vault.to_string_lossy().into();
        let out = check_update_io(&r, Path::new(&r.source_path), &vault).unwrap();
        assert_eq!(out, UpdateOutcome::SourceMissing);
    }

    #[test]
    fn check_update_io_detects_origin_update() {
        let tmp = TempDir::new().unwrap();
        let source = tmp.path().join("src.md");
        let vault = tmp.path().join("vault.md");
        std::fs::write(&source, b"NEW").unwrap();
        std::fs::write(&vault, b"OLD").unwrap();
        let r = Record {
            vault_path: vault.to_string_lossy().into(),
            source_path: source.to_string_lossy().into(),
            synced_at: 1,
            source_hash: sha256_hex(b"OLD"),
            vault_hash: sha256_hex(b"OLD"),
        };
        let out = check_update_io(&r, &source, &vault).unwrap();
        assert_eq!(out, UpdateOutcome::OriginUpdated);
    }

    #[test]
    fn dedup_returns_basename_when_free() {
        let got = dedup_target(Path::new("/v"), "a.md", &|_p| false);
        assert_eq!(got, PathBuf::from("/v/a.md"));
    }

    #[test]
    fn dedup_appends_suffix_on_collision() {
        // /v/a.md and /v/a-2.md taken; expect /v/a-3.md
        let taken = ["/v/a.md", "/v/a-2.md"];
        let exists = |p: &Path| taken.contains(&p.to_string_lossy().as_ref());
        let got = dedup_target(Path::new("/v"), "a.md", &exists);
        assert_eq!(got, PathBuf::from("/v/a-3.md"));
    }

    #[test]
    fn dedup_handles_no_extension() {
        let exists = |p: &Path| p.to_string_lossy() == "/v/README";
        let got = dedup_target(Path::new("/v"), "README", &exists);
        assert_eq!(got, PathBuf::from("/v/README-2"));
    }

    #[test]
    fn is_under_vault_prefix() {
        assert!(is_under_vault(Path::new("/Users/b/Vault"), Path::new("/Users/b/Vault/Imported/a.md")));
        assert!(!is_under_vault(Path::new("/Users/b/Vault"), Path::new("/Users/b/work/a.md")));
    }

    #[test]
    fn dated_basename_prefixes_undated_md() {
        assert_eq!(dated_basename("notes.md", "2026-06-18"), "2026-06-18-notes.md");
        assert_eq!(dated_basename("NOTES.MD", "2026-06-18"), "2026-06-18-NOTES.MD");
    }

    #[test]
    fn dated_basename_leaves_already_dated_md() {
        assert_eq!(dated_basename("2026-01-02-notes.md", "2026-06-18"), "2026-01-02-notes.md");
    }

    #[test]
    fn dated_basename_ignores_non_md() {
        assert_eq!(dated_basename("photo.png", "2026-06-18"), "photo.png");
        assert_eq!(dated_basename("README", "2026-06-18"), "README");
    }

    #[test]
    fn dated_basename_prefixes_when_existing_prefix_is_not_strict_format() {
        // single-digit month/day is not a yyyy-MM-dd- prefix
        assert_eq!(dated_basename("2026-1-2-notes.md", "2026-06-18"), "2026-06-18-2026-1-2-notes.md");
    }
}
