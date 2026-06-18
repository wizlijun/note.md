# Sync to SotVault Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggleable built-in `sotvault` plugin that copies the current file into the existing git-synced Vault, tracks each copy's origin, and offers a conflict-aware refresh when a tracked vault copy is reopened and its source has changed.

**Architecture:** A Rust module (`src-tauri/src/sotvault/`) holds all filesystem + record logic and exposes Tauri commands. A built-in, no-binary plugin manifest contributes the "Sync to Vault…" File-menu item (gated by the existing `is_plugin_enabled` mechanism). The front-end intercepts the `sotvault` menu dispatch (built-in plugins can't be invoked as binaries), drives the sync/check flows via the Tauri commands, and runs an open-time update check at the end of `openFile`.

**Tech Stack:** Rust (Tauri 2, `sha2`, `hex`, `serde_json`, `tempfile` for tests), Svelte 5 runes, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-18-sync-to-sotvault-design.md`

---

## File Structure

**Rust (new module `src-tauri/src/sotvault/`):**
- `store.rs` — `Record` / `RecordStore` types + corruption-tolerant JSON load/save.
- `logic.rs` — pure helpers: `sha256_hex`, `UpdateOutcome`, `decide_update`, `check_update_io`, `dedup_target`, `is_under_vault`.
- `mod.rs` — Tauri commands + path/vault-root resolution glue.

**Rust (modified):**
- `src-tauri/src/lib.rs` — declare `mod sotvault`; register the 7 commands in the desktop `invoke_handler`.

**Plugin manifest (new):**
- `src-tauri/plugins/sotvault/manifest.json` — built-in, no binary, one File-menu entry.

**Front-end (new):**
- `src/lib/sotvault-logic.ts` — pure: record type, `isTracked`, `canSyncToVault`, `dialogActionFor`.
- `src/lib/sotvault.svelte.ts` — reactive store + Tauri wrappers + dialog orchestration.
- `src/lib/sotvault-logic.test.ts`, `src/lib/sotvault.test.ts` — Vitest.

**Front-end (modified):**
- `src/lib/plugins/types.ts` — extend `EnabledWhenContext.currentTab` with two optional booleans.
- `src/lib/tabs.svelte.ts` — add `reloadTabFromDisk`; call the open-time check at the end of `openFile`.
- `src/App.svelte` — intercept `sotvault` dispatch; feed derived booleans into the `enabled_when` context; refresh the store at startup.

---

## Task 1: Rust record store (`store.rs`)

**Files:**
- Create: `src-tauri/src/sotvault/store.rs`
- Create: `src-tauri/src/sotvault/mod.rs` (stub — declares submodules so the crate compiles)

- [ ] **Step 1: Create the module stub so `store` is reachable**

Create `src-tauri/src/sotvault/mod.rs` with exactly:

```rust
//! Sync-to-Vault: copy the current file into the git-synced Vault and keep a
//! record mapping each vault copy back to its source for conflict-aware refresh.

pub mod logic;
pub mod store;
```

(`logic` is added in Task 2; create it as an empty file now so this compiles.)

```bash
: > src-tauri/src/sotvault/logic.rs
```

- [ ] **Step 2: Write the failing test for store load/save + corruption recovery**

Create `src-tauri/src/sotvault/store.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub vault_path: String,
    pub source_path: String,
    pub synced_at: u64,
    pub source_hash: String,
    pub vault_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordStore {
    pub version: u32,
    pub records: Vec<Record>,
}

impl Default for RecordStore {
    fn default() -> Self {
        Self { version: 1, records: Vec::new() }
    }
}

impl RecordStore {
    pub fn find_by_vault(&self, vault_path: &str) -> Option<&Record> {
        self.records.iter().find(|r| r.vault_path == vault_path)
    }

    pub fn upsert(&mut self, rec: Record) {
        if let Some(existing) = self.records.iter_mut().find(|r| r.vault_path == rec.vault_path) {
            *existing = rec;
        } else {
            self.records.push(rec);
        }
    }

    pub fn remove(&mut self, vault_path: &str) {
        self.records.retain(|r| r.vault_path != vault_path);
    }
}

/// Load records from `path`. A missing file yields an empty store. A corrupt
/// file is renamed to `<path>.corrupt` and an empty store is returned.
pub fn load_records(path: &Path) -> RecordStore {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return RecordStore::default(),
    };
    match serde_json::from_slice::<RecordStore>(&bytes) {
        Ok(s) => s,
        Err(_) => {
            let backup = path.with_extension("json.corrupt");
            let _ = std::fs::rename(path, &backup);
            RecordStore::default()
        }
    }
}

pub fn save_records(path: &Path, store: &RecordStore) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(store)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::fs::write(path, json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn rec(vault: &str, source: &str) -> Record {
        Record {
            vault_path: vault.into(),
            source_path: source.into(),
            synced_at: 100,
            source_hash: "aaa".into(),
            vault_hash: "aaa".into(),
        }
    }

    #[test]
    fn missing_file_is_empty_store() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("sotvault-sync.json");
        let store = load_records(&p);
        assert_eq!(store.records.len(), 0);
        assert_eq!(store.version, 1);
    }

    #[test]
    fn save_then_load_round_trips() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("nested").join("sotvault-sync.json");
        let mut store = RecordStore::default();
        store.upsert(rec("/vault/a.md", "/src/a.md"));
        save_records(&p, &store).unwrap();
        let loaded = load_records(&p);
        assert_eq!(loaded.records, store.records);
    }

    #[test]
    fn upsert_replaces_by_vault_path() {
        let mut store = RecordStore::default();
        store.upsert(rec("/vault/a.md", "/src/old.md"));
        store.upsert(rec("/vault/a.md", "/src/new.md"));
        assert_eq!(store.records.len(), 1);
        assert_eq!(store.find_by_vault("/vault/a.md").unwrap().source_path, "/src/new.md");
    }

    #[test]
    fn remove_drops_record() {
        let mut store = RecordStore::default();
        store.upsert(rec("/vault/a.md", "/src/a.md"));
        store.remove("/vault/a.md");
        assert!(store.find_by_vault("/vault/a.md").is_none());
    }

    #[test]
    fn corrupt_file_backs_up_and_resets() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("sotvault-sync.json");
        std::fs::write(&p, b"{ this is not json").unwrap();
        let store = load_records(&p);
        assert_eq!(store.records.len(), 0);
        assert!(p.with_extension("json.corrupt").exists());
    }
}
```

- [ ] **Step 3: Register the module so tests compile**

In `src-tauri/src/lib.rs`, add a module declaration next to the existing `pub mod vault_sync;` (around line 30):

```rust
#[cfg(not(target_os = "ios"))]
pub mod sotvault;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test sotvault::store`
Expected: PASS — 5 tests (`missing_file_is_empty_store`, `save_then_load_round_trips`, `upsert_replaces_by_vault_path`, `remove_drops_record`, `corrupt_file_backs_up_and_resets`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sotvault/ src-tauri/src/lib.rs
git commit -m "feat(sotvault): record store with corruption recovery"
```

---

## Task 2: Rust pure logic (`logic.rs`)

**Files:**
- Modify: `src-tauri/src/sotvault/logic.rs` (currently empty from Task 1)

- [ ] **Step 1: Write the logic module with its failing tests**

Replace the empty `src-tauri/src/sotvault/logic.rs` with:

```rust
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
}
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test sotvault::logic`
Expected: PASS — 10 tests.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/sotvault/logic.rs
git commit -m "feat(sotvault): pure update-decision + dedup + hashing logic"
```

---

## Task 3: Rust Tauri commands + manifest + registration

**Files:**
- Modify: `src-tauri/src/sotvault/mod.rs`
- Modify: `src-tauri/src/lib.rs:599-646` (desktop `invoke_handler` list)
- Create: `src-tauri/plugins/sotvault/manifest.json`

- [ ] **Step 1: Add the commands to `mod.rs`**

Replace `src-tauri/src/sotvault/mod.rs` with:

```rust
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

/// Sub-directory inside the vault where imported copies are placed.
const IMPORT_SUBDIR: &str = "Imported";

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
    let subdir = vault_root.join(IMPORT_SUBDIR);
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
```

- [ ] **Step 2: Register the commands in the desktop handler**

In `src-tauri/src/lib.rs`, inside the `#[cfg(not(target_os = "ios"))]` `generate_handler!` list (after `vault_sync::vault_sync_logs,` at line 627), add:

```rust
                sotvault::sotvault_vault_root,
                sotvault::sotvault_records,
                sotvault::sotvault_forget,
                sotvault::sotvault_sync_to_vault,
                sotvault::sotvault_check_update,
                sotvault::sotvault_apply_update,
                sotvault::sotvault_accept_current,
```

- [ ] **Step 3: Create the plugin manifest**

Create `src-tauri/plugins/sotvault/manifest.json`:

```json
{
  "id": "sotvault",
  "name": "Sync to Vault",
  "version": "0.1.0",
  "description": "Copy the current file into the Vault and keep it refreshed from its source.",
  "kind": "builtin",
  "default_enabled": false,
  "host_capabilities": [],
  "menus": [
    {
      "location": "file",
      "label": "Sync to Vault…",
      "command": "sync-to-vault",
      "enabled_when": "currentTab.canSyncToVault"
    }
  ]
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: PASS (no errors). Warnings about unused commands are acceptable until the front-end calls them.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sotvault/mod.rs src-tauri/src/lib.rs src-tauri/plugins/sotvault/manifest.json
git commit -m "feat(sotvault): tauri commands + builtin manifest"
```

---

## Task 4: Front-end pure logic (`sotvault-logic.ts`)

**Files:**
- Create: `src/lib/sotvault-logic.ts`
- Test: `src/lib/sotvault-logic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/sotvault-logic.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isTracked, canSyncToVault, dialogActionFor, type SotRecord } from './sotvault-logic'

const rec = (vault: string, source: string): SotRecord => ({
  vault_path: vault, source_path: source, synced_at: 1, source_hash: 'a', vault_hash: 'a',
})

describe('isTracked', () => {
  it('matches by vault_path', () => {
    const recs = [rec('/v/Imported/a.md', '/src/a.md')]
    expect(isTracked('/v/Imported/a.md', recs)).toBe(true)
    expect(isTracked('/src/a.md', recs)).toBe(false)
    expect(isTracked(null, recs)).toBe(false)
  })
})

describe('canSyncToVault', () => {
  const recs = [rec('/v/Imported/a.md', '/src/a.md')]
  it('true for a saved file outside the vault and not tracked', () => {
    expect(canSyncToVault('/src/b.md', '/v', recs)).toBe(true)
  })
  it('false when no path or no vault root', () => {
    expect(canSyncToVault(null, '/v', recs)).toBe(false)
    expect(canSyncToVault('/src/b.md', null, recs)).toBe(false)
  })
  it('false when the file already lives under the vault root', () => {
    expect(canSyncToVault('/v/Imported/a.md', '/v', recs)).toBe(false)
    expect(canSyncToVault('/v/notes.md', '/v', recs)).toBe(false)
  })
  it('does not treat a sibling dir sharing a prefix as inside the vault', () => {
    expect(canSyncToVault('/vault-backup/x.md', '/vault', recs)).toBe(true)
  })
})

describe('dialogActionFor', () => {
  it('maps outcomes to actions', () => {
    expect(dialogActionFor('origin_updated')).toBe('confirm-origin')
    expect(dialogActionFor('conflict')).toBe('conflict')
    expect(dialogActionFor('source_missing')).toBe('source-missing')
    expect(dialogActionFor('up_to_date')).toBe('none')
    expect(dialogActionFor('not_tracked')).toBe('none')
    expect(dialogActionFor('anything-else')).toBe('none')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- sotvault-logic`
Expected: FAIL — cannot resolve `./sotvault-logic`.

- [ ] **Step 3: Implement the pure module**

Create `src/lib/sotvault-logic.ts`:

```ts
export interface SotRecord {
  vault_path: string
  source_path: string
  synced_at: number
  source_hash: string
  vault_hash: string
}

export function isTracked(path: string | null, records: SotRecord[]): boolean {
  if (!path) return false
  return records.some((r) => r.vault_path === path)
}

function isUnder(path: string, root: string): boolean {
  if (path === root) return true
  const r = root.endsWith('/') ? root : root + '/'
  return path.startsWith(r)
}

export function canSyncToVault(
  path: string | null,
  vaultRoot: string | null,
  records: SotRecord[],
): boolean {
  if (!path || !vaultRoot) return false
  if (isUnder(path, vaultRoot)) return false
  if (isTracked(path, records)) return false
  return true
}

export type DialogAction = 'none' | 'source-missing' | 'confirm-origin' | 'conflict'

export function dialogActionFor(outcome: string): DialogAction {
  switch (outcome) {
    case 'origin_updated': return 'confirm-origin'
    case 'conflict': return 'conflict'
    case 'source_missing': return 'source-missing'
    default: return 'none'
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm test -- sotvault-logic`
Expected: PASS — all assertions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sotvault-logic.ts src/lib/sotvault-logic.test.ts
git commit -m "feat(sotvault): front-end pure logic for gating + dialog mapping"
```

---

## Task 5: Front-end store + orchestration (`sotvault.svelte.ts`)

**Files:**
- Create: `src/lib/sotvault.svelte.ts`
- Test: `src/lib/sotvault.test.ts`
- Modify: `src/lib/tabs.svelte.ts` (add `reloadTabFromDisk`)

- [ ] **Step 1: Add `reloadTabFromDisk` to `tabs.svelte.ts`**

In `src/lib/tabs.svelte.ts`, add this exported function after `openFile` (it reuses the already-imported `readMd`, `statFile`, `sha256Hex`, and mirrors the file-watcher auto-reload at `file-watcher.svelte.ts:64-78`):

```ts
/** Re-read `path` from disk into its open tab (used after a vault apply-update). */
export async function reloadTabFromDisk(path: string): Promise<void> {
  const t = tabs.find((x) => x.filePath === path)
  if (!t) return
  const content = await readMd(path)
  const stat = await statFile(path)
  const hash = await sha256Hex(content)
  const oldContent = t.initialContent
  t.initialContent = content
  t.currentContent = content
  t.lastKnownMtime = stat?.mtime ?? 0
  t.lastKnownHash = hash
  t.externalState = 'fresh'
  t.externalBannerDismissed = false
  t.pendingExternal = undefined
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('mdeditor:auto-reloaded', {
      detail: { tabId: t.id, oldContent, newContent: content },
    }))
  }
}
```

- [ ] **Step 2: Write the failing test for the orchestration**

Create `src/lib/sotvault.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
const ask = vi.fn()
const pushToast = vi.fn()
const reloadTabFromDisk = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (...a: unknown[]) => ask(...a) }))
vi.mock('./toast.svelte', () => ({ pushToast: (...a: unknown[]) => pushToast(...a) }))
vi.mock('./plugins/registry', () => ({ isPluginActive: () => true }))
vi.mock('./tabs.svelte', () => ({
  activeTab: () => ({ filePath: '/src/a.md' }),
  reloadTabFromDisk: (...a: unknown[]) => reloadTabFromDisk(...a),
}))

import { maybeCheckVaultUpdate } from './sotvault.svelte'

beforeEach(() => {
  invoke.mockReset(); ask.mockReset(); pushToast.mockReset(); reloadTabFromDisk.mockReset()
})

describe('maybeCheckVaultUpdate', () => {
  it('does nothing on up_to_date', async () => {
    invoke.mockResolvedValueOnce('up_to_date')
    await maybeCheckVaultUpdate({ filePath: '/v/Imported/a.md' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('toasts on source_missing, no dialog', async () => {
    invoke.mockResolvedValueOnce('source_missing')
    await maybeCheckVaultUpdate({ filePath: '/v/Imported/a.md' })
    expect(ask).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
  })

  it('applies update when origin_updated is confirmed', async () => {
    invoke
      .mockResolvedValueOnce('origin_updated')   // sotvault_check_update
      .mockResolvedValueOnce('NEW CONTENT')      // sotvault_apply_update
      .mockResolvedValueOnce('/v')               // sotvault_vault_root (refresh)
      .mockResolvedValueOnce([])                 // sotvault_records (refresh)
    ask.mockResolvedValueOnce(true)
    await maybeCheckVaultUpdate({ filePath: '/v/Imported/a.md' })
    expect(invoke).toHaveBeenCalledWith('sotvault_apply_update', { vaultPath: '/v/Imported/a.md' })
    expect(reloadTabFromDisk).toHaveBeenCalledWith('/v/Imported/a.md')
  })

  it('does not apply when origin_updated is declined', async () => {
    invoke.mockResolvedValueOnce('origin_updated')
    ask.mockResolvedValueOnce(false)
    await maybeCheckVaultUpdate({ filePath: '/v/Imported/a.md' })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('conflict: overwrite path applies update', async () => {
    invoke
      .mockResolvedValueOnce('conflict')
      .mockResolvedValueOnce('NEW')   // apply_update
      .mockResolvedValueOnce('/v')    // refresh root
      .mockResolvedValueOnce([])      // refresh records
    ask.mockResolvedValueOnce(true)   // overwrite? yes
    await maybeCheckVaultUpdate({ filePath: '/v/Imported/a.md' })
    expect(invoke).toHaveBeenCalledWith('sotvault_apply_update', { vaultPath: '/v/Imported/a.md' })
  })

  it('conflict: keep-vault path accepts current', async () => {
    invoke
      .mockResolvedValueOnce('conflict')
      .mockResolvedValueOnce(undefined) // accept_current
      .mockResolvedValueOnce('/v')      // refresh root
      .mockResolvedValueOnce([])        // refresh records
    ask.mockResolvedValueOnce(false)    // overwrite? no
    ask.mockResolvedValueOnce(true)     // keep vault & stop prompting? yes
    await maybeCheckVaultUpdate({ filePath: '/v/Imported/a.md' })
    expect(invoke).toHaveBeenCalledWith('sotvault_accept_current', { vaultPath: '/v/Imported/a.md' })
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test -- sotvault.test`
Expected: FAIL — cannot resolve `./sotvault.svelte`.

- [ ] **Step 4: Implement the store + orchestration**

Create `src/lib/sotvault.svelte.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'
import { pushToast } from './toast.svelte'
import { activeTab, reloadTabFromDisk } from './tabs.svelte'
import { isPluginActive } from './plugins/registry'
import {
  canSyncToVault as computeCanSync,
  isTracked as computeIsTracked,
  dialogActionFor,
  type SotRecord,
} from './sotvault-logic'

export const sotvaultStore = $state<{ vaultRoot: string | null; records: SotRecord[]; tick: number }>({
  vaultRoot: null,
  records: [],
  tick: 0,
})

export async function refreshSotvault(): Promise<void> {
  if (!isPluginActive('sotvault')) return
  try {
    const [root, records] = await Promise.all([
      invoke<string | null>('sotvault_vault_root'),
      invoke<SotRecord[]>('sotvault_records'),
    ])
    sotvaultStore.vaultRoot = root
    sotvaultStore.records = records
    sotvaultStore.tick++
  } catch (e) {
    console.warn('[sotvault] refresh:', e)
  }
}

export function canSyncActive(path: string | null): boolean {
  return computeCanSync(path, sotvaultStore.vaultRoot, sotvaultStore.records)
}

export function isTrackedVaultFile(path: string | null): boolean {
  return computeIsTracked(path, sotvaultStore.records)
}

export async function syncCurrentToVault(): Promise<void> {
  const tab = activeTab()
  if (!tab?.filePath) {
    pushToast({ level: 'warn', message: '请先保存文件，再同步到 Vault' })
    return
  }
  try {
    await invoke('sotvault_sync_to_vault', { srcPath: tab.filePath })
    await refreshSotvault()
    pushToast({ level: 'success', message: '✓ 已同步到 Vault' })
  } catch (e) {
    pushToast({ level: 'error', message: '❌ 同步到 Vault 失败', detail: String(e) })
  }
}

export async function maybeCheckVaultUpdate(tab: { filePath: string }): Promise<void> {
  if (!isPluginActive('sotvault')) return
  if (!tab.filePath) return

  let outcome: string
  try {
    outcome = await invoke<string>('sotvault_check_update', { openedPath: tab.filePath })
  } catch (e) {
    console.warn('[sotvault] check_update:', e)
    return
  }

  const action = dialogActionFor(outcome)
  if (action === 'none') return
  if (action === 'source-missing') {
    pushToast({ level: 'warn', message: '⚠️ Vault: 源文件已移动或删除，无法检查更新' })
    return
  }

  const { ask } = await import('@tauri-apps/plugin-dialog')

  if (action === 'confirm-origin') {
    const yes = await ask('源文件已更新，是否同步进 Vault？', { title: 'Sync to Vault' })
    if (yes) await applyVaultUpdate(tab.filePath)
    return
  }

  // action === 'conflict'
  const overwrite = await ask('源文件与 Vault 副本都被修改过（冲突）。用源文件覆盖 Vault 副本？', { title: 'Vault 冲突' })
  if (overwrite) {
    await applyVaultUpdate(tab.filePath)
    return
  }
  const keep = await ask('保留 Vault 当前内容，并停止对此文件的更新提示？', { title: 'Vault 冲突' })
  if (keep) {
    try {
      await invoke('sotvault_accept_current', { vaultPath: tab.filePath })
      await refreshSotvault()
    } catch (e) {
      console.warn('[sotvault] accept_current:', e)
    }
  }
  // else: cancel — leave the record untouched; it will prompt again next open.
}

async function applyVaultUpdate(vaultPath: string): Promise<void> {
  try {
    await invoke<string>('sotvault_apply_update', { vaultPath })
    await reloadTabFromDisk(vaultPath)
    await refreshSotvault()
    pushToast({ level: 'success', message: '✓ 已从源文件更新 Vault 副本' })
  } catch (e) {
    pushToast({ level: 'error', message: '❌ 更新 Vault 副本失败', detail: String(e) })
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- sotvault.test`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/sotvault.svelte.ts src/lib/sotvault.test.ts src/lib/tabs.svelte.ts
git commit -m "feat(sotvault): reactive store, sync + open-time update orchestration"
```

---

## Task 6: Wire into App.svelte, the menu, and `openFile`

**Files:**
- Modify: `src/lib/plugins/types.ts:117-128` (extend `EnabledWhenContext.currentTab`)
- Modify: `src/lib/tabs.svelte.ts` (call the check at the end of `openFile`)
- Modify: `src/App.svelte` (dispatch interception, `enabled_when` context, startup refresh)

- [ ] **Step 1: Extend the `enabled_when` context type**

In `src/lib/plugins/types.ts`, change the `currentTab` shape inside `EnabledWhenContext` (lines 117-127) to add two optional booleans:

```ts
export interface EnabledWhenContext {
  currentTab: {
    path: string | null
    filename: string | null
    extension: string | null
    kind: TabKind | null
    hasContent: boolean
    isDirty: boolean
    isUntitled: boolean
    canSyncToVault?: boolean
    isTrackedVaultFile?: boolean
  } | null
  settings: Record<string, unknown>
}
```

- [ ] **Step 2: Call the open-time check at the end of `openFile`**

In `src/lib/tabs.svelte.ts`, at the very end of `openFile` (right after `await startWatchingTab(tab)` at line 144), add a dynamic import (dynamic to avoid a static import cycle, since `sotvault.svelte.ts` statically imports from this file):

```ts
  // Sync-to-Vault: if this is a tracked vault copy whose source changed, prompt.
  // No-op when the plugin is disabled or the file is untracked.
  try {
    const { maybeCheckVaultUpdate } = await import('./sotvault.svelte')
    await maybeCheckVaultUpdate(tab)
  } catch (e) {
    console.warn('[tabs] sotvault check:', e)
  }
```

- [ ] **Step 3: Intercept the `sotvault` dispatch in App.svelte**

In `src/App.svelte`, add the import near the other lib imports (e.g. by the `vault`/plugin imports):

```ts
  import { syncCurrentToVault, canSyncActive, isTrackedVaultFile, refreshSotvault, sotvaultStore } from './lib/sotvault.svelte'
```

Then at the very top of the `dispatchPlugin = async (pluginId, command) => {` body (line 291, before `const m = manifestById[pluginId]`), add:

```ts
        if (pluginId === 'sotvault') {
          if (command === 'sync-to-vault') await syncCurrentToVault()
          return
        }
```

- [ ] **Step 4: Feed the derived booleans into the `enabled_when` context**

In `src/App.svelte`, inside the `$effect` that rebuilds `ewTab` (starts line 537), do two things.

First, read the store tick so the effect re-runs when records/vault-root change — add near the other `void` reads (after line 542):

```ts
    const _sotvaultTick = sotvaultStore.tick
    void _sotvaultTick
```

Second, extend the `ewTab` object literal (lines 545-553) to include the two booleans:

```ts
      ? {
          path: tab.filePath || null,
          filename: tab.title || null,
          extension: tab.filePath ? (tab.filePath.split('.').pop() ?? null) : null,
          kind: tab.kind === 'image' ? null : tab.kind,
          hasContent: tab.kind === 'image' ? !!tab.filePath : (tab.currentContent ?? '').length > 0,
          isDirty: tab.currentContent !== tab.initialContent,
          isUntitled: !tab.filePath,
          canSyncToVault: canSyncActive(tab.filePath || null),
          isTrackedVaultFile: isTrackedVaultFile(tab.filePath || null),
        }
```

- [ ] **Step 5: Refresh the store at startup**

In `src/App.svelte`, find the init block that calls `setPluginDispatcher(dispatchPlugin)` (line 367) and add right after it:

```ts
      void refreshSotvault()
```

(`refreshSotvault` is a no-op when the plugin is disabled, so this is safe regardless of state.)

- [ ] **Step 6: Verify the build + full test suite**

Run: `pnpm check && pnpm test`
Expected: `svelte-check` reports no new errors; all Vitest suites pass (including `sotvault-logic` and `sotvault.test`).

- [ ] **Step 7: Commit**

```bash
git add src/lib/plugins/types.ts src/lib/tabs.svelte.ts src/App.svelte
git commit -m "feat(sotvault): wire menu dispatch, enabled_when gating, open-time check"
```

---

## Task 7: Manual end-to-end verification

**Files:** none (manual). Requires a configured Vault.

- [ ] **Step 1: Build and run the app**

Run: `pnpm tauri dev`

- [ ] **Step 2: Enable the plugin**

In Settings → Plugins, enable "Sync to Vault", then restart the app (the native File menu is built once at startup, mirroring how `openclaw-chat` enable takes effect).
Expected: a "Sync to Vault…" item appears in the File menu.

- [ ] **Step 3: Verify menu gating**

- Open a file that lives **outside** the Vault and is saved → "Sync to Vault…" is **enabled**.
- Open a file **inside** the Vault → the item is **disabled**.
- A brand-new unsaved tab → the item is **disabled**.

- [ ] **Step 4: Sync to Vault**

With an outside-the-vault file active, click "Sync to Vault…".
Expected: toast "✓ 已同步到 Vault"; the file now exists at `<Vault>/Imported/<name>`; `<app-data>/sotvault-sync.json` contains a record mapping the new vault path to the source path.

- [ ] **Step 5: Open-time check — origin updated**

Edit the **source** file externally (save a change). Open the vault copy (`<Vault>/Imported/<name>`).
Expected: a confirm dialog "源文件已更新，是否同步进 Vault？". Confirm → the open tab content updates to the new source content; toast "✓ 已从源文件更新 Vault 副本".

- [ ] **Step 6: Open-time check — no false prompt**

Reopen the same vault copy without changing the source.
Expected: no dialog.

- [ ] **Step 7: Conflict**

Edit **both** the source and the vault copy (different content) externally, then open the vault copy.
Expected: the overwrite dialog appears; declining it then offers "保留 Vault…"; choosing that stops further prompts on the next open.

- [ ] **Step 8: Final commit (if any tweaks were needed)**

```bash
git add -A
git commit -m "chore(sotvault): manual-verification fixes"
```

(If no changes were needed, skip this step.)

---

## Self-Review Notes

- **Spec coverage:** menu entry + gating (Task 3 manifest, Task 6 Steps 3-4); copy into `Vault/Imported/` with dedup (Task 3 `sotvault_sync_to_vault` + Task 2 `dedup_target`); dedicated JSON store (Task 1); open-time check (Task 5 `maybeCheckVaultUpdate` + Task 6 Step 2); one-directional + conflict-aware decision (Task 2 `decide_update`); reuse existing Vault root (Task 3 `resolve_vault_root`); error-to-toast handling (Task 5). All spec sections map to tasks.
- **Reused infra:** `VaultSyncManager.repo_path` for the vault root; `is_plugin_enabled`/`collect_top_menu_items` for gating; `sha2`/`hex` (already deps); file-watcher auto-reload pattern for `reloadTabFromDisk`.
- **Type consistency:** Rust `Record`/`UpdateOutcome` field + variant names match the front-end `SotRecord` and the `UpdateOutcome` `snake_case` serialization (`up_to_date`, `origin_updated`, `conflict`, `source_missing`, `not_tracked`) consumed by `dialogActionFor`. Command names and camelCase arg keys (`srcPath`, `openedPath`, `vaultPath`) are identical across `mod.rs` and `sotvault.svelte.ts`.
- **Known limitation (acceptable for v1):** enabling/disabling the plugin requires an app restart for the native File menu to rebuild — same behavior as the existing `openclaw-chat` plugin.
