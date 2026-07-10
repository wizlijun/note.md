//! Sync-to-Vault: copy the current file into the git-synced Vault and keep a
//! record mapping each vault copy back to its source for conflict-aware refresh.

pub mod logic;
pub mod store;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use logic::UpdateOutcome;
use store::{Record, RecordStore};

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Copy the relative-local images referenced by `src_md` into
/// `{dest_dir}/{stem}.assets/` and return the markdown with successfully-copied
/// links rewritten to point there. When nothing is bundled, returns `src_md`
/// unchanged. A per-file copy failure is logged and its link left untouched.
fn bundle_referenced_images(
    src_md: &str,
    source_dir: &Path,
    dest_dir: &Path,
    stem: &str,
) -> Result<String, String> {
    let (refs, copies) =
        logic::plan_image_assets(src_md, source_dir, stem, &|p| p.exists());
    if copies.is_empty() {
        return Ok(src_md.to_string());
    }
    let assets = dest_dir.join(logic::assets_dir_name(stem));
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;

    let mut copied: HashSet<String> = HashSet::new();
    for op in &copies {
        let dst = assets.join(&op.dest_filename);
        match std::fs::copy(&op.src_abs, &dst) {
            Ok(_) => {
                copied.insert(op.dest_filename.clone());
            }
            Err(e) => {
                eprintln!("[sotvault] copy asset {:?} failed: {e}", op.src_abs);
            }
        }
    }

    let mut md = src_md.to_string();
    for r in &refs {
        if copied.contains(&r.dest_filename) {
            md = md.replace(&r.original, &r.rewritten);
        }
    }
    Ok(md)
}

/// Copy the source's companion outline note (`foo.md` → `foo.note.md`) next to
/// the vault copy, renamed to the target's (possibly dated/deduped) stem so the
/// outline finds it by the same filename convention. Missing source companion
/// is a no-op; an existing vault companion is overwritten (it belongs to this
/// pair) but never deleted when the source side has none.
fn sync_companion_note(source: &Path, target: &Path) {
    let (Some(src_name), Some(dst_name)) = (
        source.file_name().and_then(|s| s.to_str()),
        target.file_name().and_then(|s| s.to_str()),
    ) else {
        return;
    };
    let (Some(src_note), Some(dst_note)) = (
        logic::companion_note_name(src_name),
        logic::companion_note_name(dst_name),
    ) else {
        return;
    };
    let src_note_path = source.with_file_name(src_note);
    if !src_note_path.is_file() {
        return;
    }
    let dst_note_path = target.with_file_name(dst_note);
    if let Err(e) = std::fs::copy(&src_note_path, &dst_note_path) {
        eprintln!("[sotvault] copy companion note {src_note_path:?} failed: {e}");
    }
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("sotvault-sync.json"))
}

fn load_store(app: &AppHandle) -> Result<RecordStore, String> {
    Ok(store::load_records(&store_path(app)?))
}

fn save_store(app: &AppHandle, s: &RecordStore) -> Result<(), String> {
    store::save_records(&store_path(app)?, s).map_err(|e| e.to_string())
}

/// Resolve the configured Vault root from the git-sync manager. None when the
/// vault is not configured (or the manager is absent, e.g. iOS).
fn resolve_vault_root(app: &AppHandle) -> Option<PathBuf> {
    let mgr = app.try_state::<Arc<crate::vault_sync::VaultSyncManager>>()?;
    let guard = mgr.repo_path.lock().ok()?;
    guard.clone().map(PathBuf::from)
}

/// Sub-directory inside the vault where synced copies are placed.
const SYNC_SUBDIR: &str = "Sync";

#[tauri::command]
pub fn sotvault_vault_root(app: AppHandle) -> Result<Option<String>, String> {
    Ok(resolve_vault_root(&app).map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn sotvault_records(app: AppHandle) -> Result<Vec<Record>, String> {
    Ok(load_store(&app)?.records)
}

#[tauri::command]
pub fn sotvault_forget(app: AppHandle, vault_path: String) -> Result<(), String> {
    let mut s = load_store(&app)?;
    s.remove(&vault_path);
    save_store(&app, &s)
}

#[tauri::command]
pub fn sotvault_sync_to_vault(
    app: AppHandle,
    src_path: String,
    date_prefix: Option<String>,
) -> Result<Record, String> {
    let source = PathBuf::from(&src_path);
    if !source.is_file() {
        return Err("source file does not exist".into());
    }
    let vault_root = resolve_vault_root(&app).ok_or("Vault not configured")?;
    let subdir = vault_root.join(SYNC_SUBDIR);
    std::fs::create_dir_all(&subdir).map_err(|e| e.to_string())?;
    let basename = source
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("invalid source filename")?;
    // For undated .md files, prepend the caller-supplied local date (yyyy-MM-dd).
    let basename = match date_prefix.as_deref() {
        Some(p) if !p.is_empty() => logic::dated_basename(basename, p),
        _ => basename.to_string(),
    };

    let target = logic::dedup_target(&subdir, &basename, &|p| p.exists());
    let src_bytes = std::fs::read(&source).map_err(|e| e.to_string())?;

    let stem = target
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let source_dir = source.parent().unwrap_or_else(|| Path::new("."));

    // Non-UTF-8 (unusual for md): copy bytes verbatim, no asset handling.
    let vault_bytes: Vec<u8> = match std::str::from_utf8(&src_bytes) {
        Ok(src_md) => bundle_referenced_images(src_md, source_dir, &subdir, &stem)?.into_bytes(),
        Err(_) => src_bytes.clone(),
    };
    std::fs::write(&target, &vault_bytes).map_err(|e| e.to_string())?;
    sync_companion_note(&source, &target);

    let source_hash = logic::sha256_hex(&src_bytes);
    let vault_hash = logic::sha256_hex(&vault_bytes);

    let mut s = load_store(&app)?;
    let rec = Record {
        vault_path: target.to_string_lossy().to_string(),
        source_path: source.to_string_lossy().to_string(),
        synced_at: now_secs(),
        source_hash,
        vault_hash,
    };
    s.upsert(rec.clone());
    save_store(&app, &s)?;
    Ok(rec)
}

/// Result of an open-time update check. `vault_path` is the tracked vault copy
/// for whichever side was opened; `opened_is_source` distinguishes "opened the
/// source file" from "opened the vault copy" so the UI can word the prompt.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub outcome: UpdateOutcome,
    pub vault_path: Option<String>,
    pub opened_is_source: bool,
}

/// Check whether an opened file (either the vault copy OR its source) is out of
/// sync. Keyed by vault_path first, then source_path, so opening either side of
/// a synced pair surfaces a pending change.
#[tauri::command]
pub fn sotvault_check_update(app: AppHandle, opened_path: String) -> Result<UpdateCheck, String> {
    let s = load_store(&app)?;
    let (record, opened_is_source) = match s.find_by_vault(&opened_path) {
        Some(r) => (r.clone(), false),
        None => match s.find_by_source(&opened_path) {
            Some(r) => (r.clone(), true),
            None => {
                return Ok(UpdateCheck {
                    outcome: UpdateOutcome::NotTracked,
                    vault_path: None,
                    opened_is_source: false,
                })
            }
        },
    };
    let outcome = logic::check_update_io(
        &record,
        std::path::Path::new(&record.source_path),
        std::path::Path::new(&record.vault_path),
    )?;
    Ok(UpdateCheck {
        outcome,
        vault_path: Some(record.vault_path),
        opened_is_source,
    })
}

/// Overwrite the vault copy from its source, refresh fingerprints, and return
/// the new content so the open tab can be reloaded.
#[tauri::command]
pub fn sotvault_apply_update(app: AppHandle, vault_path: String) -> Result<String, String> {
    let mut s = load_store(&app)?;
    let rec = s.find_by_vault(&vault_path).cloned().ok_or("not tracked")?;
    let src_bytes = std::fs::read(&rec.source_path).map_err(|e| e.to_string())?;

    let vault_pathbuf = PathBuf::from(&rec.vault_path);
    let dest_dir = vault_pathbuf.parent().unwrap_or_else(|| Path::new("."));
    let stem = vault_pathbuf
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let source_dir = Path::new(&rec.source_path)
        .parent()
        .unwrap_or_else(|| Path::new("."));

    let vault_string: String = match std::str::from_utf8(&src_bytes) {
        Ok(src_md) => bundle_referenced_images(src_md, source_dir, dest_dir, &stem)?,
        Err(_) => return Err("source is not valid UTF-8".into()),
    };
    let vault_bytes = vault_string.clone().into_bytes();
    std::fs::write(&rec.vault_path, &vault_bytes).map_err(|e| e.to_string())?;
    sync_companion_note(Path::new(&rec.source_path), &vault_pathbuf);

    let updated = Record {
        synced_at: now_secs(),
        source_hash: logic::sha256_hex(&src_bytes),
        vault_hash: logic::sha256_hex(&vault_bytes),
        ..rec
    };
    s.upsert(updated);
    save_store(&app, &s)?;
    Ok(vault_string)
}

/// Acknowledge a conflict by keeping the vault copy as-is and re-baselining the
/// record to the current source + vault fingerprints (stops further prompts).
#[tauri::command]
pub fn sotvault_accept_current(app: AppHandle, vault_path: String) -> Result<(), String> {
    let mut s = load_store(&app)?;
    let rec = s.find_by_vault(&vault_path).cloned().ok_or("not tracked")?;
    let src = std::fs::read(&rec.source_path).map_err(|e| e.to_string())?;
    let vlt = std::fs::read(&rec.vault_path).map_err(|e| e.to_string())?;
    let updated = Record {
        synced_at: now_secs(),
        source_hash: logic::sha256_hex(&src),
        vault_hash: logic::sha256_hex(&vlt),
        ..rec
    };
    s.upsert(updated);
    save_store(&app, &s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn bundle_copies_image_and_rewrites_link() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        std::fs::create_dir_all(src_dir.join("assets")).unwrap();
        std::fs::write(src_dir.join("assets/x.png"), b"PNGDATA").unwrap();

        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&dest_dir).unwrap();

        let md = "![a](assets/x.png)";
        let out = bundle_referenced_images(md, &src_dir, &dest_dir, "2026-07-03-note").unwrap();

        assert_eq!(out, "![a](2026-07-03-note.assets/x.png)");
        let copied = dest_dir.join("2026-07-03-note.assets/x.png");
        assert_eq!(std::fs::read(&copied).unwrap(), b"PNGDATA");
    }

    #[test]
    fn bundle_no_images_returns_unchanged_and_creates_nothing() {
        let tmp = TempDir::new().unwrap();
        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&dest_dir).unwrap();

        let md = "# just text, [a link](note.md)";
        let out = bundle_referenced_images(md, tmp.path(), &dest_dir, "note").unwrap();

        assert_eq!(out, md);
        assert!(!dest_dir.join("note.assets").exists());
    }

    #[test]
    fn companion_note_synced_with_renamed_target() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::write(src_dir.join("foo.md"), b"# main").unwrap();
        std::fs::write(src_dir.join("foo.note.md"), b"- outline note").unwrap();

        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&dest_dir).unwrap();
        let target = dest_dir.join("2026-07-10-foo.md");

        sync_companion_note(&src_dir.join("foo.md"), &target);

        let copied = dest_dir.join("2026-07-10-foo.note.md");
        assert_eq!(std::fs::read(&copied).unwrap(), b"- outline note");
    }

    #[test]
    fn companion_note_missing_is_a_noop() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::write(src_dir.join("foo.md"), b"# main").unwrap();
        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&dest_dir).unwrap();

        sync_companion_note(&src_dir.join("foo.md"), &dest_dir.join("foo.md"));

        assert!(std::fs::read_dir(&dest_dir).unwrap().next().is_none());
    }
}

