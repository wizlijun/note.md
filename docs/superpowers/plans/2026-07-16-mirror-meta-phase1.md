# Mirror-hosted marks — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the mirror↔source mapping into a git-synced, per-mirror meta store under `{vault}/.notemd/mirrors/` (partitioned by `deviceId`, like recents/analytics), dual-written alongside the existing app-support record, plus a one-time migration and the product-principle docs.

**Architecture:** New Rust module `sotvault/mirror_meta.rs` owns the `.notemd/mirrors/` JSON files (one per mirror per device: `{stem}.{deviceId8}.json`). `sotvault_sync_to_vault` gains optional `device_id`/`device_name` params and writes a `MirrorMeta` in addition to the app-support `Record` (dual-write; nothing removed this phase). A migration command backfills existing records into the git-synced store. Frontend passes `getDeviceId()` + `hostname()` (same ids recents/analytics use).

**Tech Stack:** Rust (serde_json, std::fs, tempfile tests), Tauri commands, Svelte 5 frontend (`@tauri-apps/api/core` invoke, `@tauri-apps/plugin-os` hostname), Vitest.

Spec: `docs/superpowers/specs/2026-07-16-mirror-hosted-marks-design.md` (§③ meta schema, §⑥ phase 1).

---

## File Structure

- Create: `src-tauri/src/sotvault/mirror_meta.rs` — `MirrorMeta` struct, `.notemd/mirrors/` path derivation, per-mirror write, scan-all read, and the pure `relative_mirror` helper. All logic testable with tempdirs.
- Modify: `src-tauri/src/sotvault/mod.rs` — register module; extend `sotvault_sync_to_vault` to write a `MirrorMeta` when device info is supplied; add `notemd_mirror_metas` (read) and `notemd_migrate_mirror_meta` (backfill) commands.
- Modify: `src-tauri/src/lib.rs` — register the two new commands.
- Modify: `src/lib/sotvault.svelte.ts` — pass `deviceId`/`deviceName` on every `sotvault_sync_to_vault` call; add `migrateMirrorMeta()`.
- Modify: `src/App.svelte` — call `migrateMirrorMeta()` once at startup (after vault root loads).
- Create: `docs/product-principle-mirror-hosted-marks.md` — the 4th conviction, outward-facing.
- Modify: `README.md` — add the 4th conviction to "The idea".

---

## Task 1: `mirror_meta` module — struct, paths, read/write

**Files:**
- Create: `src-tauri/src/sotvault/mirror_meta.rs`
- Modify: `src-tauri/src/sotvault/mod.rs:5` (add `pub mod mirror_meta;`)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/sotvault/mirror_meta.rs` with the tests already present but functions stubbed with `unimplemented!()`:

```rust
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
    unimplemented!()
}

/// Meta file path for a mirror+device: `{dir}/{stem}.{deviceId8}.json`, where
/// `stem` is the mirror md's file stem and `deviceId8` its first 8 chars.
pub fn meta_path(vault_root: &Path, mirror_rel: &str, device_id: &str) -> PathBuf {
    unimplemented!()
}

/// Write one mirror meta, creating `.notemd/mirrors/` as needed.
pub fn write(vault_root: &Path, meta: &MirrorMeta) -> Result<(), String> {
    unimplemented!()
}

/// Read every mirror meta in the vault; corrupt/unparseable files are skipped.
pub fn read_all(vault_root: &Path) -> Vec<MirrorMeta> {
    unimplemented!()
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
    fn two_devices_same_mirror_are_separate_files() {
        let dir = TempDir::new().unwrap();
        write(dir.path(), &meta("sync/foo.md", "aaaaaaaa-1", "/a/foo.md")).unwrap();
        write(dir.path(), &meta("sync/foo.md", "bbbbbbbb-2", "/b/foo.md")).unwrap();
        assert_eq!(read_all(dir.path()).len(), 2);
    }
}
```

Add `pub mod mirror_meta;` after `pub mod vault_settings;` in `src-tauri/src/sotvault/mod.rs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib sotvault::mirror_meta`
Expected: all fail with `not implemented`.

- [ ] **Step 3: Implement the functions**

Replace the four `unimplemented!()` bodies:

```rust
pub fn relative_mirror(vault_root: &Path, vault_path: &Path) -> String {
    match vault_path.strip_prefix(vault_root) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => vault_path.to_string_lossy().to_string(),
    }
}

pub fn meta_path(vault_root: &Path, mirror_rel: &str, device_id: &str) -> PathBuf {
    let stem = Path::new(mirror_rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("mirror");
    let dev8: String = device_id.chars().take(8).collect();
    meta_dir(vault_root).join(format!("{stem}.{dev8}.json"))
}

pub fn write(vault_root: &Path, meta: &MirrorMeta) -> Result<(), String> {
    let dir = meta_dir(vault_root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = meta_path(vault_root, &meta.mirror, &meta.device_id);
    let txt = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    std::fs::write(path, txt).map_err(|e| e.to_string())
}

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib sotvault::mirror_meta`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sotvault/mirror_meta.rs src-tauri/src/sotvault/mod.rs
git commit -m "feat(mirror-meta): git-synced per-mirror meta store under .notemd/mirrors/"
```

---

## Task 2: Write a mirror meta on sync

**Files:**
- Modify: `src-tauri/src/sotvault/mod.rs` (`sotvault_sync_to_vault` signature + body, ~line 325)

Context: `sotvault_sync_to_vault` already computes `vault_hash` (sha256 hex of the bytes written to the vault copy) and builds a `Record` with `vault_path`, `synced_at` (via `now_secs()`), `source_path`. We add optional device info and, when present, write a `MirrorMeta` with checksum `sha256:{vault_hash}`.

- [ ] **Step 1: Extend the command signature**

In `sotvault_sync_to_vault`, add two params after `note_home` (keep existing params/order):

```rust
    device_id: Option<String>,
    device_name: Option<String>,
```

- [ ] **Step 2: Write the meta after the record is saved**

Immediately after the existing `s.upsert(rec.clone()); save_store(&app, &s)?;` block (and before the `note.conflict` emit), add:

```rust
    if let (Some(dev_id), Some(dev_name)) = (device_id, device_name) {
        let mirror_rel = mirror_meta::relative_mirror(&vault_root, &target);
        let meta = mirror_meta::MirrorMeta {
            mirror: mirror_rel,
            device_id: dev_id,
            device_name: dev_name,
            source: source.to_string_lossy().to_string(),
            synced_at: rec.synced_at,
            checksum: format!("sha256:{}", rec.vault_hash),
        };
        if let Err(e) = mirror_meta::write(&vault_root, &meta) {
            eprintln!("[sotvault] write mirror meta failed: {e}");
        }
    }
```

(`target` is the mirror's absolute `PathBuf`, `source` the source `PathBuf`, `rec` the `Record` — all already in scope.)

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check --lib`
Expected: no errors (existing frontend callers omit the new args → Tauri passes `None`).

- [ ] **Step 4: Run the full sotvault suite**

Run: `cd src-tauri && cargo test --lib sotvault::`
Expected: PASS (unchanged count; meta write is a no-op without device info).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sotvault/mod.rs
git commit -m "feat(mirror-meta): write mirror meta on sync when device info is supplied"
```

---

## Task 3: Migration + read commands

**Files:**
- Modify: `src-tauri/src/sotvault/mod.rs` (add `notemd_mirror_metas`, `notemd_migrate_mirror_meta`)
- Modify: `src-tauri/src/lib.rs:874` area (register both)

- [ ] **Step 1: Add the read command**

After `notemd_vault_settings_set` in `mod.rs`:

```rust
/// All git-synced mirror metas in the current vault (across every device).
#[tauri::command]
pub fn notemd_mirror_metas(app: AppHandle) -> Result<Vec<mirror_meta::MirrorMeta>, String> {
    let vault_root = resolve_vault_root(&app).ok_or("Vault not configured")?;
    Ok(mirror_meta::read_all(&vault_root))
}
```

- [ ] **Step 2: Add the migration command**

Backfills existing app-support records into `.notemd/mirrors/` for records whose `vault_path` is under the current vault and that have no meta yet for this device. Returns how many were written.

```rust
/// One-time backfill: mirror the app-support `Record`s of THIS device into the
/// git-synced `.notemd/mirrors/` store, stamping the caller's device id/name.
/// Idempotent: skips a record whose per-device meta file already exists.
#[tauri::command]
pub fn notemd_migrate_mirror_meta(
    app: AppHandle,
    device_id: String,
    device_name: String,
) -> Result<usize, String> {
    let vault_root = resolve_vault_root(&app).ok_or("Vault not configured")?;
    let store = load_store(&app)?;
    let mut written = 0usize;
    for rec in &store.records {
        let vault_path = PathBuf::from(&rec.vault_path);
        if vault_path.strip_prefix(&vault_root).is_err() {
            continue; // record belongs to a different vault
        }
        let mirror_rel = mirror_meta::relative_mirror(&vault_root, &vault_path);
        if mirror_meta::meta_path(&vault_root, &mirror_rel, &device_id).exists() {
            continue; // already migrated
        }
        let meta = mirror_meta::MirrorMeta {
            mirror: mirror_rel,
            device_id: device_id.clone(),
            device_name: device_name.clone(),
            source: rec.source_path.clone(),
            synced_at: rec.synced_at,
            checksum: format!("sha256:{}", rec.vault_hash),
        };
        if mirror_meta::write(&vault_root, &meta).is_ok() {
            written += 1;
        }
    }
    Ok(written)
}
```

- [ ] **Step 3: Register both commands**

In `src-tauri/src/lib.rs`, after `sotvault::notemd_vault_settings_set,`:

```rust
                sotvault::notemd_mirror_metas,
                sotvault::notemd_migrate_mirror_meta,
```

- [ ] **Step 4: Verify compile + tests**

Run: `cd src-tauri && cargo test --lib sotvault::`
Expected: PASS (compiles with the new commands; no behavior change to existing tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sotvault/mod.rs src-tauri/src/lib.rs
git commit -m "feat(mirror-meta): notemd_mirror_metas read + notemd_migrate_mirror_meta backfill commands"
```

---

## Task 4: Frontend — pass device info on sync

**Files:**
- Modify: `src/lib/sotvault.svelte.ts` (the three `sotvault_sync_to_vault` invoke sites + a small helper)
- Test: `src/lib/sotvault.test.ts` (assert device args are passed)

Context: `getDeviceId()` is in `src/lib/settings.svelte.ts`; `hostname()` from `@tauri-apps/plugin-os` (fallback `Device-${id.slice(0,8)}`, mirroring `recent-sync.svelte.ts:63`).

- [ ] **Step 1: Write the failing test**

Add to `src/lib/sotvault.test.ts`:

```ts
import { getDeviceId } from './settings.svelte'
vi.mock('@tauri-apps/plugin-os', () => ({ hostname: async () => 'Test-Mac' }))

it('passes deviceId and deviceName to sotvault_sync_to_vault', async () => {
  invoke.mockResolvedValue({ vaultPath: '/v/sync/a.md', sourcePath: '/src/a.md' })
  const { syncCurrentToVault } = await import('./sotvault.svelte')
  sotvaultStore.vaultRoot = '/v'
  await syncCurrentToVault()
  const call = invoke.mock.calls.find((c) => c[0] === 'sotvault_sync_to_vault')
  expect(call?.[1]).toMatchObject({ deviceId: getDeviceId(), deviceName: 'Test-Mac' })
})
```

(Adapt the trigger to however `syncCurrentToVault` reads the active tab in existing tests — reuse the file's existing `activeTab` mock; the assertion is only about the invoke args.)

- [ ] **Step 2: Run it — expect fail**

Run: `npx vitest run src/lib/sotvault.test.ts -t "passes deviceId"`
Expected: FAIL (deviceId/deviceName absent from the call).

- [ ] **Step 3: Add a device-info helper and thread it through**

In `src/lib/sotvault.svelte.ts`, add near the top imports:

```ts
import { hostname } from '@tauri-apps/plugin-os'
import { getDeviceId } from './settings.svelte'

async function deviceInfo(): Promise<{ deviceId: string; deviceName: string }> {
  const deviceId = getDeviceId()
  const deviceName = (await hostname().catch(() => null)) ?? `Device-${deviceId.slice(0, 8)}`
  return { deviceId, deviceName }
}
```

Then at each of the three `invoke('sotvault_sync_to_vault', {...})` sites, spread `...(await deviceInfo())` into the args object, e.g.:

```ts
const dev = await deviceInfo()
await invoke('sotvault_sync_to_vault', { srcPath: tab.filePath, datePrefix, ...dev })
```
```ts
return invoke<SotRecord>('sotvault_sync_to_vault', { srcPath, datePrefix, noteHome: 'vault', ...(await deviceInfo()) })
```
(and the third call at ~line 121 the same way).

- [ ] **Step 4: Run test + full sotvault suite**

Run: `npx vitest run src/lib/sotvault.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sotvault.svelte.ts src/lib/sotvault.test.ts
git commit -m "feat(mirror-meta): frontend passes deviceId/deviceName on sync"
```

---

## Task 5: Frontend — run migration once at startup

**Files:**
- Modify: `src/lib/sotvault.svelte.ts` (add `migrateMirrorMeta`)
- Modify: `src/App.svelte` (call it after the vault root loads, near `loadOutlineDirs()`)

- [ ] **Step 1: Add the migration wrapper**

In `src/lib/sotvault.svelte.ts`:

```ts
/** One-time backfill of app-support records into the git-synced .notemd/mirrors/
 *  store. Idempotent + best-effort; no-op without a configured vault. */
export async function migrateMirrorMeta(): Promise<void> {
  if (!sotvaultStore.vaultRoot) return
  const { deviceId, deviceName } = await deviceInfo()
  try {
    const n = await invoke<number>('notemd_migrate_mirror_meta', { deviceId, deviceName })
    if (n > 0) console.info(`[sotvault] migrated ${n} mirror meta records`)
  } catch (e) {
    console.warn('[sotvault] mirror meta migration:', e)
  }
}
```

- [ ] **Step 2: Call it at startup**

In `src/App.svelte`, in the boot async block right after `await loadOutlineDirs()`:

```ts
      const { migrateMirrorMeta } = await import('./lib/sotvault.svelte')
      void migrateMirrorMeta()
```

- [ ] **Step 3: Verify typecheck + tests**

Run: `pnpm check 2>&1 | grep -E "ERRORS"` → expect `0 ERRORS`.
Run: `npx vitest run src/lib/sotvault.test.ts` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/sotvault.svelte.ts src/App.svelte
git commit -m "feat(mirror-meta): backfill migration on startup"
```

---

## Task 6: Product-principle docs

**Files:**
- Create: `docs/product-principle-mirror-hosted-marks.md`
- Modify: `README.md` ("The idea" numbered list — add a 4th item)

- [ ] **Step 1: Write the principle doc**

Create `docs/product-principle-mirror-hosted-marks.md`:

```markdown
# Product principle: your marks belong to the vault, not to a path

Reading happens everywhere — Downloads, external drives, other tools' folders.
The moment you annotate, those marks are the most valuable signal you own, and
they must not be orphaned when a path changes: a different machine, a moved or
deleted original, a tool that reorganizes its folders.

So note.md **mirrors** the source into your vault at annotation time. The mirror
is a git-versioned, stable host for your marks; the original stays where it is,
and note.md keeps the mirror consistent with it. Your notes live in the vault —
durable, syncable, greppable — attached to a mirror that remembers where the
original came from, even when the original moves or you switch machines.

The mirror's mapping (which device, which original path, last sync, checksum)
is recorded in `{vault}/.notemd/mirrors/`, so it travels with the vault via git
instead of living on one machine. See
`docs/superpowers/specs/2026-07-16-mirror-hosted-marks-design.md`.
```

- [ ] **Step 2: Add the 4th conviction to README**

In `README.md`, under "## The idea", after the 3rd numbered conviction, add:

```markdown
4. **Your marks belong to the vault, not to a path.** You read files that live
   outside your vault, and paths are fragile across devices and tools. When you
   annotate, note.md mirrors the source into your vault so your marks get a
   stable, git-versioned host — the original stays put, the mirror stays in
   sync, and your notes never lose their home.
```

- [ ] **Step 3: Commit**

```bash
git add docs/product-principle-mirror-hosted-marks.md README.md
git commit -m "docs: product principle — marks belong to the vault, not to a path"
```

---

## Definition of Done (Phase 1)

- `cd src-tauri && cargo test --lib` all pass; `pnpm check` reports 0 errors; `pnpm test` all pass.
- A sync (share or manual "Sync to Vault") writes `{vault}/.notemd/mirrors/{stem}.{deviceId8}.json` with device id/name/source/syncedAt/checksum, in addition to the existing app-support record.
- Startup backfills pre-existing records for the current vault into `.notemd/mirrors/` once, idempotently.
- `notemd_mirror_metas` returns all metas across devices (consumed by Phase 2+).
- README + principle doc state the 4th conviction.

Out of scope (later phases): open-in-vault → edit-source redirect (Phase 2), session-time source↔mirror consistency (Phase 3), multi-device note merge (Phase 4), retiring the app-support store, GUI to view/relink mirrors.
