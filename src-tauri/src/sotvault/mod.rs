//! Sync-to-Vault: copy the current file into the git-synced Vault and keep a
//! record mapping each vault copy back to its source for conflict-aware refresh.

pub mod logic;
pub mod store;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use logic::UpdateOutcome;
use store::{NoteHome, Record, RecordStore};

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


/// Outcome of reconciling a pair's companion notes: the new merge base to
/// persist on the `Record`, and whether conflict markers were produced.
#[derive(Debug)]
pub struct NoteReconcileOutcome {
    pub new_base: Option<String>,
    pub conflict: bool,
}

/// The companion-note path for an md path (`foo.md` → `foo.note.md`), or None
/// when `md` is itself a note / non-md.
fn companion_path(md: &Path) -> Option<PathBuf> {
    let name = md.file_name().and_then(|s| s.to_str())?;
    let note = logic::companion_note_name(name)?;
    Some(md.with_file_name(note))
}

/// Read a note file. `Ok(None)` = absent. `Ok(Some(text))` = UTF-8 content.
/// `Err(())` = present but unreadable (IO error or non-UTF-8). The caller must
/// then skip the whole reconcile rather than treat the file as absent, which
/// would overwrite an unreadable-but-present note (data loss).
fn read_note(p: &Path) -> Result<Option<String>, ()> {
    if !p.is_file() {
        return Ok(None);
    }
    match std::fs::read_to_string(p) {
        Ok(s) => Ok(Some(s)),
        Err(e) => {
            eprintln!("[sotvault] read note {p:?} failed ({e}); skipping note reconcile to avoid overwrite");
            Err(())
        }
    }
}

/// Back up `content` next to `note` as `<stem>.conflict.<ts>.<ext>`
/// (e.g. `foo.note.md` → `foo.note.conflict.1720000000.md`), mirroring the
/// `.conflict.<ts>` convention in `vault_sync/conflict.rs`.
fn backup_conflict_note(note: &Path, content: &str, ts: u64) {
    let stem = note.file_stem().and_then(|s| s.to_str()).unwrap_or("note");
    let ext = note
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let backup = note.with_file_name(format!("{stem}.conflict.{ts}{ext}"));
    if let Err(e) = std::fs::write(&backup, content) {
        eprintln!("[sotvault] write conflict backup {backup:?} failed: {e}");
    }
}

/// Reconcile the companion notes of a synced pair.
/// `source` = source md path, `vault_md` = vault-copy md path, `base` = the
/// record's stored `note_merge_base`, `vault_homed` = when true, the note lives
/// ONLY next to the vault copy and the source side is never read or written.
/// Writes the merged content to whichever side(s) changed, backs up both
/// originals to `.conflict.<ts>` on conflict, and returns the new base + conflict
/// flag. Per-file IO errors are logged and non-fatal (sync must not fail because
/// a note write hiccuped).
fn reconcile_companion_notes(
    source: &Path,
    vault_md: &Path,
    base: Option<&str>,
    vault_homed: bool,
) -> NoteReconcileOutcome {
    let Some(vault_note) = companion_path(vault_md) else {
        return NoteReconcileOutcome { new_base: base.map(str::to_string), conflict: false };
    };

    // Vault-homed: the note lives ONLY next to the vault copy. Never read or
    // write the source-side note — that is exactly the source-dir pollution the
    // vault-homed mode exists to prevent. Base simply tracks the vault note.
    if vault_homed {
        return match read_note(&vault_note) {
            Ok(Some(c)) => NoteReconcileOutcome { new_base: Some(c), conflict: false },
            // absent or unreadable → never clobber the stored ancestor
            _ => NoteReconcileOutcome { new_base: base.map(str::to_string), conflict: false },
        };
    }

    // Sidecar (legacy): bidirectional 3-way reconcile of both sides.
    let Some(src_note) = companion_path(source) else {
        return NoteReconcileOutcome { new_base: base.map(str::to_string), conflict: false };
    };
    let (src_content, vault_content) = match (read_note(&src_note), read_note(&vault_note)) {
        (Ok(s), Ok(v)) => (s, v),
        _ => return NoteReconcileOutcome { new_base: base.map(str::to_string), conflict: false },
    };

    let plan = logic::reconcile_note(base, src_content.as_deref(), vault_content.as_deref());

    if plan.conflict {
        let ts = now_secs();
        if let Some(s) = &src_content {
            backup_conflict_note(&src_note, s, ts);
        }
        if let Some(v) = &vault_content {
            backup_conflict_note(&vault_note, v, ts);
        }
    }
    if let Some(content) = &plan.write_vault {
        if let Err(e) = std::fs::write(&vault_note, content) {
            eprintln!("[sotvault] write vault note {vault_note:?} failed: {e}");
        }
    }
    if let Some(content) = &plan.write_source {
        if let Err(e) = std::fs::write(&src_note, content) {
            eprintln!("[sotvault] write source note {src_note:?} failed: {e}");
        }
    }
    NoteReconcileOutcome { new_base: plan.new_base, conflict: plan.conflict }
}

/// Parse the optional `note_home` command arg into a `NoteHome` (unknown/None → Sidecar).
fn parse_note_home(s: Option<&str>) -> NoteHome {
    match s {
        Some("vault") => NoteHome::Vault,
        _ => NoteHome::Sidecar,
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
    note_home: Option<String>,
    reuse_existing: Option<bool>,
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

    let mut s = load_store(&app)?;
    // Share re-homing reuses this source's existing vault copy (in-place update)
    // so repeated shares don't proliferate `-2` copies. Manual sync omits the
    // flag → fresh dedup, preserving its snapshot semantics.
    let existing = if reuse_existing.unwrap_or(false) {
        s.find_by_source(&source.to_string_lossy())
            .map(|r| PathBuf::from(&r.vault_path))
    } else {
        None
    };
    let target = logic::sync_target(existing, &subdir, &basename, &|p| p.exists());
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

    let prior_base = s
        .find_by_vault(&target.to_string_lossy())
        .and_then(|r| r.note_merge_base.clone());
    let home = parse_note_home(note_home.as_deref());
    let note = reconcile_companion_notes(&source, &target, prior_base.as_deref(), home == NoteHome::Vault);

    let source_hash = logic::sha256_hex(&src_bytes);
    let vault_hash = logic::sha256_hex(&vault_bytes);

    let rec = Record {
        vault_path: target.to_string_lossy().to_string(),
        source_path: source.to_string_lossy().to_string(),
        synced_at: now_secs(),
        source_hash,
        vault_hash,
        note_merge_base: note.new_base,
        note_home: home,
    };
    s.upsert(rec.clone());
    save_store(&app, &s)?;
    if note.conflict {
        let _ = app.emit("sotvault://note-conflict", ());
    }
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
    let prior = rec.note_merge_base.clone();
    let vault_homed = rec.note_home == NoteHome::Vault;
    let note = reconcile_companion_notes(
        Path::new(&rec.source_path),
        &vault_pathbuf,
        prior.as_deref(),
        vault_homed,
    );

    let updated = Record {
        synced_at: now_secs(),
        source_hash: logic::sha256_hex(&src_bytes),
        vault_hash: logic::sha256_hex(&vault_bytes),
        note_merge_base: note.new_base,
        ..rec
    };
    s.upsert(updated);
    save_store(&app, &s)?;
    if note.conflict {
        let _ = app.emit("sotvault://note-conflict", ());
    }
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
    fn reconcile_first_sync_copies_source_note_to_vault() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::write(src_dir.join("foo.md"), b"# main").unwrap();
        std::fs::write(src_dir.join("foo.note.md"), b"- outline note").unwrap();
        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&dest_dir).unwrap();
        let target = dest_dir.join("2026-07-10-foo.md");

        let out = reconcile_companion_notes(&src_dir.join("foo.md"), &target, None, false);

        assert_eq!(std::fs::read(dest_dir.join("2026-07-10-foo.note.md")).unwrap(), b"- outline note");
        assert_eq!(out.new_base.as_deref(), Some("- outline note"));
        assert!(!out.conflict);
    }

    #[test]
    fn reconcile_missing_source_note_is_noop() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::write(src_dir.join("foo.md"), b"# main").unwrap();
        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&dest_dir).unwrap();

        let out = reconcile_companion_notes(&src_dir.join("foo.md"), &dest_dir.join("foo.md"), None, false);

        // no note on either side → nothing written, no base
        assert!(std::fs::read_dir(&dest_dir).unwrap().next().is_none());
        assert_eq!(out.new_base, None);
        assert!(!out.conflict);
    }

    #[test]
    fn reconcile_conflict_writes_markers_and_two_backups() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&dest_dir).unwrap();
        std::fs::write(src_dir.join("foo.md"), b"# main").unwrap();
        std::fs::write(dest_dir.join("foo.md"), b"# main").unwrap();
        // both note sides edited the same base line differently
        std::fs::write(src_dir.join("foo.note.md"), b"line local\n").unwrap();
        std::fs::write(dest_dir.join("foo.note.md"), b"line vault\n").unwrap();

        let out = reconcile_companion_notes(
            &src_dir.join("foo.md"),
            &dest_dir.join("foo.md"),
            Some("line base\n"),
            false,
        );

        assert!(out.conflict);
        // both note files now carry conflict markers and identical content
        let s = std::fs::read_to_string(src_dir.join("foo.note.md")).unwrap();
        let v = std::fs::read_to_string(dest_dir.join("foo.note.md")).unwrap();
        assert!(s.contains("<<<<<<<"));
        assert_eq!(s, v);
        // one .conflict backup next to each side, preserving the originals
        let src_backup = std::fs::read_dir(&src_dir).unwrap()
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().contains(".conflict."))
            .expect("source-side .conflict backup missing");
        assert_eq!(std::fs::read_to_string(src_backup.path()).unwrap(), "line local\n");
        let vault_backup = std::fs::read_dir(&dest_dir).unwrap()
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().contains(".conflict."))
            .expect("vault-side .conflict backup missing");
        assert_eq!(std::fs::read_to_string(vault_backup.path()).unwrap(), "line vault\n");
    }

    #[test]
    fn reconcile_fast_forward_pulls_vault_edit_into_source() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&dest_dir).unwrap();
        // source note untouched since base; vault note moved on
        std::fs::write(src_dir.join("foo.note.md"), b"base\n").unwrap();
        std::fs::write(dest_dir.join("foo.note.md"), b"vault edit\n").unwrap();

        let out = reconcile_companion_notes(
            &src_dir.join("foo.md"),
            &dest_dir.join("foo.md"),
            Some("base\n"),
            false,
        );

        assert!(!out.conflict);
        assert_eq!(std::fs::read_to_string(src_dir.join("foo.note.md")).unwrap(), "vault edit\n");
        assert_eq!(std::fs::read_to_string(dest_dir.join("foo.note.md")).unwrap(), "vault edit\n");
        assert_eq!(out.new_base.as_deref(), Some("vault edit\n"));
    }

    #[test]
    fn vault_homed_reconcile_never_writes_source_note() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&dest_dir).unwrap();
        std::fs::write(src_dir.join("foo.md"), b"# main").unwrap();
        std::fs::write(dest_dir.join("foo.md"), b"# main").unwrap();
        std::fs::write(dest_dir.join("foo.note.md"), b"- vault only note").unwrap();

        let out = reconcile_companion_notes(
            &src_dir.join("foo.md"),
            &dest_dir.join("foo.md"),
            None,
            true, // vault_homed
        );

        assert!(!src_dir.join("foo.note.md").exists(), "source note must never be written for vault-homed pair");
        assert_eq!(std::fs::read(dest_dir.join("foo.note.md")).unwrap(), b"- vault only note");
        assert_eq!(out.new_base.as_deref(), Some("- vault only note"));
        assert!(!out.conflict);
    }

    #[test]
    fn parse_note_home_arg() {
        assert_eq!(parse_note_home(Some("vault")), NoteHome::Vault);
        assert_eq!(parse_note_home(Some("sidecar")), NoteHome::Sidecar);
        assert_eq!(parse_note_home(None), NoteHome::Sidecar);
    }

    #[test]
    fn vault_homed_reconcile_absent_note_preserves_base() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&dest_dir).unwrap();
        // no note on either side
        let out = reconcile_companion_notes(
            &src_dir.join("foo.md"),
            &dest_dir.join("foo.md"),
            Some("- prior base"),
            true, // vault_homed
        );
        assert!(!src_dir.join("foo.note.md").exists());
        assert_eq!(out.new_base.as_deref(), Some("- prior base"));
        assert!(!out.conflict);
    }
}

