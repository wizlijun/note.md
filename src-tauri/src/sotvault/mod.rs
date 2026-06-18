//! Sync-to-Vault: copy the current file into the git-synced Vault and keep a
//! record mapping each vault copy back to its source for conflict-aware refresh.

pub mod logic;
pub mod store;

use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use logic::UpdateOutcome;
use store::{Record, RecordStore};

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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
pub fn sotvault_sync_to_vault(app: AppHandle, src_path: String) -> Result<Record, String> {
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

    let target = logic::dedup_target(&subdir, basename, &|p| p.exists());
    let bytes = std::fs::read(&source).map_err(|e| e.to_string())?;
    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    let hash = logic::sha256_hex(&bytes);

    let mut s = load_store(&app)?;
    let rec = Record {
        vault_path: target.to_string_lossy().to_string(),
        source_path: source.to_string_lossy().to_string(),
        synced_at: now_secs(),
        source_hash: hash.clone(),
        vault_hash: hash,
    };
    s.upsert(rec.clone());
    save_store(&app, &s)?;
    Ok(rec)
}

#[tauri::command]
pub fn sotvault_check_update(app: AppHandle, opened_path: String) -> Result<UpdateOutcome, String> {
    let s = load_store(&app)?;
    let record = match s.find_by_vault(&opened_path) {
        Some(r) => r.clone(),
        None => return Ok(UpdateOutcome::NotTracked),
    };
    logic::check_update_io(
        &record,
        std::path::Path::new(&record.source_path),
        std::path::Path::new(&record.vault_path),
    )
}

/// Overwrite the vault copy from its source, refresh fingerprints, and return
/// the new content so the open tab can be reloaded.
#[tauri::command]
pub fn sotvault_apply_update(app: AppHandle, vault_path: String) -> Result<String, String> {
    let mut s = load_store(&app)?;
    let rec = s.find_by_vault(&vault_path).cloned().ok_or("not tracked")?;
    let bytes = std::fs::read(&rec.source_path).map_err(|e| e.to_string())?;
    std::fs::write(&rec.vault_path, &bytes).map_err(|e| e.to_string())?;
    let hash = logic::sha256_hex(&bytes);
    let updated = Record { synced_at: now_secs(), source_hash: hash.clone(), vault_hash: hash, ..rec };
    s.upsert(updated);
    save_store(&app, &s)?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
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
