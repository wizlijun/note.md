# Mirror-hosted marks — Phase 2 Implementation Plan (open-in-vault → edit source, relink)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When you open a vault mirror whose source is absent on this device (a different machine, or a moved/deleted original), let you **relink** it to a local file — and upgrade `SyncOriginBanner` from "reveal source folder" to "open source for editing / relink". Reading the git-synced `.notemd/mirrors/` metas makes mirrors recognizable even on a device that never synced them.

**Reconciliation with the spec (§④):** The "open mirror → redirect to edit the source" behavior **already exists** in `openFile` (`src/lib/tabs.svelte.ts:172-184`): opening a tracked vault copy recursively re-opens its source when the source exists (via this-device app-support `Record`s), and `mappedVaultCompanion` already points the note panel at the vault mirror. So Phase 2 does NOT re-implement the redirect. It adds the missing pieces: (a) frontend reads `notemd_mirror_metas` so cross-device mirrors are visible; (b) a **relink** path for when the source is missing on this device; (c) the banner rework.

**Architecture:** New backend command `notemd_relink_mirror_source` writes/updates this device's app-support `Record` (so `openFile`'s existing redirect starts working) AND this device's git-synced `.notemd/mirrors/` meta. Frontend loads mirror metas into `sotvaultStore`, adds a `relinkMirrorSource()` flow (file picker → command → refresh → open the new source), and reworks `SyncOriginBanner`.

**Tech Stack:** Rust (serde_json, sha2 via existing `logic::sha256_hex`, tempfile tests), Tauri commands, Svelte 5, `@tauri-apps/plugin-dialog` (file picker), Vitest.

Spec: `docs/superpowers/specs/2026-07-16-mirror-hosted-marks-design.md` §④. Phase 1 plan (context): `docs/superpowers/plans/2026-07-16-mirror-meta-phase1.md`.

---

## File Structure

- Modify: `src-tauri/src/sotvault/store.rs` — add a pure `relink_record()` helper + tests (build/refresh a `Record` for a relinked mirror).
- Modify: `src-tauri/src/sotvault/mod.rs` — add the `notemd_relink_mirror_source` command (thin I/O wrapper over `relink_record` + `mirror_meta::write`).
- Modify: `src-tauri/src/lib.rs` — register the command.
- Modify: `src/lib/sotvault-logic.ts` — add `MirrorMeta` type + pure helpers `mirrorMetaFor()` / `deviceSourceFor()`.
- Modify: `src/lib/sotvault.svelte.ts` — `sotvaultStore.mirrorMetas`, load them in `refreshSotvault`, add `mirrorMetaExistsFor()`, `relinkMirrorSource()`.
- Modify: `src/lib/sotvault.test.ts` — cover meta loading + relink invoke.
- Rewrite: `src/components/SyncOriginBanner.svelte` — open-source / relink UI.
- Modify: `src/lib/i18n/en.ts`, `zh.ts`, `ja.ts`, `de.ts` — new `syncOrigin.*` keys.

---

## Task 1: Backend — `relink_record` helper + `notemd_relink_mirror_source` command

**Files:**
- Modify: `src-tauri/src/sotvault/store.rs` (pure helper + tests)
- Modify: `src-tauri/src/sotvault/mod.rs` (command)
- Modify: `src-tauri/src/lib.rs` (register)

- [ ] **Step 1: Write the failing test for the pure helper**

In `src-tauri/src/sotvault/store.rs`, add to the `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn relink_updates_existing_record_source_and_hashes() {
        let existing = rec("/v/sync/foo.md", "/old/foo.md");
        let out = relink_record(Some(existing), "/v/sync/foo.md", "/new/foo.md", "sh", "vh", 999);
        assert_eq!(out.vault_path, "/v/sync/foo.md");
        assert_eq!(out.source_path, "/new/foo.md");
        assert_eq!(out.source_hash, "sh");
        assert_eq!(out.vault_hash, "vh");
        assert_eq!(out.synced_at, 999);
        // Relinked mirrors are vault-homed: never write the source-side note.
        assert_eq!(out.note_home, NoteHome::Vault);
    }

    #[test]
    fn relink_builds_fresh_record_when_none_exists() {
        let out = relink_record(None, "/v/sync/bar.md", "/new/bar.md", "sh", "vh", 5);
        assert_eq!(out.source_path, "/new/bar.md");
        assert_eq!(out.vault_path, "/v/sync/bar.md");
        assert_eq!(out.note_home, NoteHome::Vault);
        assert_eq!(out.note_merge_base, None);
    }
```

Add the function signature stub (so tests fail, not error):

```rust
/// Build (or refresh) the app-support Record for relinking a mirror to a new
/// local source on this device. Preserves the existing note_merge_base when
/// refreshing; always vault-homed (the note lives only beside the vault mirror,
/// so a relinked source dir is never written).
pub fn relink_record(
    existing: Option<Record>,
    vault_path: &str,
    new_source: &str,
    source_hash: &str,
    vault_hash: &str,
    now: u64,
) -> Record {
    unimplemented!()
}
```

- [ ] **Step 2: Run tests — expect fail**

Run: `cd src-tauri && cargo test --lib sotvault::store::tests::relink`
Expected: 2 fail with `not implemented`.

- [ ] **Step 3: Implement the helper**

Replace the stub:

```rust
pub fn relink_record(
    existing: Option<Record>,
    vault_path: &str,
    new_source: &str,
    source_hash: &str,
    vault_hash: &str,
    now: u64,
) -> Record {
    Record {
        vault_path: vault_path.to_string(),
        source_path: new_source.to_string(),
        synced_at: now,
        source_hash: source_hash.to_string(),
        vault_hash: vault_hash.to_string(),
        note_merge_base: existing.and_then(|r| r.note_merge_base),
        note_home: NoteHome::Vault,
    }
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd src-tauri && cargo test --lib sotvault::store`
Expected: PASS (all store tests, including the 2 new).

- [ ] **Step 5: Add the command in `mod.rs`**

After `notemd_migrate_mirror_meta`, add:

```rust
/// Relink a vault mirror to a newly-chosen local source on THIS device: update
/// (or create) this device's app-support Record so `openFile` redirects to the
/// new source, and write this device's git-synced mirror meta. Hashes are
/// recomputed from disk so the open-time update check has a fresh baseline.
#[tauri::command]
pub fn notemd_relink_mirror_source(
    app: AppHandle,
    vault_path: String,
    new_source: String,
    device_id: String,
    device_name: String,
) -> Result<Record, String> {
    let vault_root = resolve_vault_root(&app).ok_or("Vault not configured")?;
    let mirror = PathBuf::from(&vault_path);
    let source = PathBuf::from(&new_source);
    if !mirror.is_file() {
        return Err("mirror file does not exist".into());
    }
    if !source.is_file() {
        return Err("source file does not exist".into());
    }
    let source_hash = logic::sha256_hex(&std::fs::read(&source).map_err(|e| e.to_string())?);
    let vault_hash = logic::sha256_hex(&std::fs::read(&mirror).map_err(|e| e.to_string())?);

    let mut s = load_store(&app)?;
    let existing = s.find_by_vault(&vault_path).cloned();
    let rec = store::relink_record(existing, &vault_path, &new_source, &source_hash, &vault_hash, now_secs());
    s.upsert(rec.clone());
    save_store(&app, &s)?;

    let meta = mirror_meta::MirrorMeta {
        mirror: mirror_meta::relative_mirror(&vault_root, &mirror),
        device_id,
        device_name,
        source: new_source,
        synced_at: rec.synced_at,
        checksum: format!("sha256:{}", rec.vault_hash),
    };
    if let Err(e) = mirror_meta::write(&vault_root, &meta) {
        eprintln!("[sotvault] relink write mirror meta failed: {e}");
    }
    Ok(rec)
}
```

(`logic::sha256_hex` takes `&[u8]`; confirm its signature in `logic.rs` and adapt the call if it differs — e.g. it may take `&Vec<u8>` or a string.)

- [ ] **Step 6: Register in `lib.rs`**

After `sotvault::notemd_migrate_mirror_meta,` add:

```rust
                sotvault::notemd_relink_mirror_source,
```

- [ ] **Step 7: Verify**

Run: `cd src-tauri && cargo test --lib sotvault::` → PASS. `cargo check --lib` → clean.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/sotvault/store.rs src-tauri/src/sotvault/mod.rs src-tauri/src/lib.rs
git commit -m "feat(mirror): notemd_relink_mirror_source — relink a mirror to a new local source

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Frontend — load mirror metas + relink flow

**Files:**
- Modify: `src/lib/sotvault-logic.ts` (types + pure helpers)
- Modify: `src/lib/sotvault.svelte.ts` (store field, refresh, helpers)
- Test: `src/lib/sotvault.test.ts`

- [ ] **Step 1: Add the `MirrorMeta` type + pure helpers in `sotvault-logic.ts`**

Append:

```ts
/** Mirrors Rust `mirror_meta::MirrorMeta` (camelCase). One per mirror per device. */
export interface MirrorMeta {
  mirror: string        // vault-relative mirror path
  deviceId: string
  deviceName: string
  source: string        // absolute source path on `deviceId`'s machine
  syncedAt: number
  checksum: string
}

/** Any mirror meta (any device) whose mirror maps to this absolute vault path. */
export function mirrorMetaFor(vaultPath: string | null, metas: MirrorMeta[], vaultRoot: string | null): MirrorMeta | null {
  if (!vaultPath || !vaultRoot) return null
  const root = vaultRoot.replace(/\/$/, '')
  const rel = vaultPath.startsWith(root + '/') ? vaultPath.slice(root.length + 1) : vaultPath
  return metas.find((m) => m.mirror === rel) ?? null
}

/** This device's recorded source for a vault mirror, or null. */
export function deviceSourceFor(vaultPath: string | null, metas: MirrorMeta[], vaultRoot: string | null, deviceId: string): string | null {
  if (!vaultPath || !vaultRoot) return null
  const root = vaultRoot.replace(/\/$/, '')
  const rel = vaultPath.startsWith(root + '/') ? vaultPath.slice(root.length + 1) : vaultPath
  return metas.find((m) => m.mirror === rel && m.deviceId === deviceId)?.source ?? null
}
```

- [ ] **Step 2: Write the failing test**

In `src/lib/sotvault.test.ts` add (adapt to the file's existing `invoke` mock + `beforeEach`):

```ts
it('refreshSotvault loads mirror metas into the store', async () => {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'sotvault_vault_root') return Promise.resolve('/v')
    if (cmd === 'sotvault_records') return Promise.resolve([])
    if (cmd === 'notemd_mirror_metas') return Promise.resolve([
      { mirror: 'sync/a.md', deviceId: 'd1', deviceName: 'Mac', source: '/s/a.md', syncedAt: 1, checksum: 'sha256:x' },
    ])
    return Promise.reject(new Error(`unexpected ${cmd}`))
  })
  const { refreshSotvault, sotvaultStore } = await import('./sotvault.svelte')
  await refreshSotvault()
  expect(sotvaultStore.mirrorMetas).toHaveLength(1)
  expect(sotvaultStore.mirrorMetas[0].mirror).toBe('sync/a.md')
})
```

Run: `npx vitest run src/lib/sotvault.test.ts -t "loads mirror metas"` → FAIL (`mirrorMetas` undefined).

- [ ] **Step 3: Implement store field + loading + helpers**

In `src/lib/sotvault.svelte.ts`:

a) Extend the store (`import type { SotRecord, MirrorMeta } from './sotvault-logic'`, and add the field):

```ts
export const sotvaultStore = $state<{ vaultRoot: string | null; records: SotRecord[]; mirrorMetas: MirrorMeta[]; tick: number }>({
  vaultRoot: null,
  records: [],
  mirrorMetas: [],
  tick: 0,
})
```

b) In `refreshSotvault`, after loading `records`, load metas (best-effort; empty when unavailable):

```ts
    const mirrorMetas = root
      ? await invoke<MirrorMeta[]>('notemd_mirror_metas').catch(() => [] as MirrorMeta[])
      : []
    sotvaultStore.vaultRoot = root
    sotvaultStore.records = records
    sotvaultStore.mirrorMetas = mirrorMetas
    sotvaultStore.tick++
```

c) Add helpers (import `mirrorMetaFor`, `deviceSourceFor` from `./sotvault-logic`, `getDeviceId` already imported):

```ts
/** True when the given vault path is a mirror recorded by ANY device. */
export function isMirrorPath(path: string | null): boolean {
  return mirrorMetaFor(path, sotvaultStore.mirrorMetas, sotvaultStore.vaultRoot) !== null
}

/** This device's recorded source for a vault mirror (from git-synced metas). */
export function deviceSourceForVaultPath(path: string | null): string | null {
  return deviceSourceFor(path, sotvaultStore.mirrorMetas, sotvaultStore.vaultRoot, getDeviceId())
}

/** Relink a vault mirror to a locally-picked source, then open that source.
 *  Returns true when a relink happened. */
export async function relinkMirrorSource(vaultPath: string): Promise<boolean> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ multiple: false, directory: false, filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] })
  const newSource = typeof picked === 'string' ? picked : null
  if (!newSource) return false
  const { deviceId, deviceName } = await deviceInfo()
  await invoke('notemd_relink_mirror_source', { vaultPath, newSource, deviceId, deviceName })
  await refreshSotvault()
  const { openFile } = await import('./tabs.svelte')
  await openFile(newSource)
  return true
}
```

- [ ] **Step 4: Verify**

Run: `npx vitest run src/lib/sotvault.test.ts` → PASS.
Run: `pnpm check 2>&1 | grep ERRORS` → `0 ERRORS`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sotvault-logic.ts src/lib/sotvault.svelte.ts src/lib/sotvault.test.ts
git commit -m "feat(mirror): frontend loads mirror metas + relink flow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: SyncOriginBanner rework + i18n

**Files:**
- Rewrite: `src/components/SyncOriginBanner.svelte`
- Modify: `src/lib/i18n/en.ts`, `zh.ts`, `ja.ts`, `de.ts`

No automated test (Svelte component) — verify via typecheck + the manual steps below.

- [ ] **Step 1: Add i18n keys (all 4 files)**

In `en.ts`, replace the three existing `syncOrigin.*` lines (`syncOrigin.synced`, `syncOrigin.revealTitle`, `syncOrigin.openSourceDir`) — keep them and ADD:

```ts
  'syncOrigin.editSource': 'Edit source',
  'syncOrigin.sourceMissing': '📎 Mirror — source not on this device',
  'syncOrigin.relink': 'Relink local source…',
```

In `zh.ts` add:
```ts
  'syncOrigin.editSource': '编辑源文件',
  'syncOrigin.sourceMissing': '📎 镜像 — 源不在本设备',
  'syncOrigin.relink': '重新关联本地源…',
```
In `ja.ts` add:
```ts
  'syncOrigin.editSource': 'ソースを編集',
  'syncOrigin.sourceMissing': '📎 ミラー — ソースがこの端末にありません',
  'syncOrigin.relink': 'ローカルソースを再リンク…',
```
In `de.ts` add:
```ts
  'syncOrigin.editSource': 'Quelle bearbeiten',
  'syncOrigin.sourceMissing': '📎 Spiegel — Quelle nicht auf diesem Gerät',
  'syncOrigin.relink': 'Lokale Quelle neu verknüpfen…',
```

- [ ] **Step 2: Rewrite the banner**

Replace `src/components/SyncOriginBanner.svelte`'s `<script>` and markup (keep the `<style>` block; add a `.action.warn` variant is optional):

```svelte
<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { deviceSourceForVaultPath, isMirrorPath, relinkMirrorSource, revealVaultSource } from '../lib/sotvault.svelte'
  import { openFile } from '../lib/tabs.svelte'
  import { t } from '../lib/i18n/store.svelte'

  let { tab }: { tab: Tab } = $props()

  // This device's recorded source (from git-synced mirror metas), and whether
  // this vault file is a mirror recorded by ANY device.
  const source = $derived(deviceSourceForVaultPath(tab.filePath || null))
  const mirror = $derived(isMirrorPath(tab.filePath || null))

  // Does this device's source still exist on disk? null = unknown/checking.
  let sourceExists = $state<boolean | null>(null)
  $effect(() => {
    const s = source
    sourceExists = null
    if (!s) return
    import('@tauri-apps/plugin-fs').then(({ exists }) => exists(s).catch(() => false)).then((ok) => { sourceExists = ok })
  })

  let busy = $state(false)
  async function onRelink() {
    if (!tab.filePath) return
    busy = true
    try { await relinkMirrorSource(tab.filePath) } finally { busy = false }
  }
</script>

{#if source && sourceExists}
  <div class="banner sync-origin" role="status" aria-live="polite">
    <span class="label">{t('syncOrigin.synced')}</span>
    <button class="origin-link" title={t('syncOrigin.revealTitle')} onclick={() => revealVaultSource(source)}>{source}</button>
    <button class="action" onclick={() => openFile(source)}>{t('syncOrigin.editSource')}</button>
  </div>
{:else if mirror || source}
  <div class="banner sync-origin" role="status" aria-live="polite">
    <span class="label">{t('syncOrigin.sourceMissing')}</span>
    <button class="action" onclick={onRelink} disabled={busy}>{t('syncOrigin.relink')}</button>
  </div>
{/if}

<style>
  /* keep the existing <style> block from the current file verbatim */
</style>
```

(Preserve the existing CSS in the `<style>` block — do not delete it.)

- [ ] **Step 3: Verify typecheck**

Run: `pnpm check 2>&1 | grep -E "COMPLETED|ERRORS"` → `0 ERRORS`.
Run: `npx vitest run` 2>&1 | tail -3 → all pass (unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/components/SyncOriginBanner.svelte src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/ja.ts src/lib/i18n/de.ts
git commit -m "feat(mirror): SyncOriginBanner — edit source / relink when source is absent

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Manual verification (GUI — user runs, no automation)

1. Sync an outside-vault `foo.md` into the vault (share or "Sync to Vault"). Open the mirror from Folder View → it auto-redirects to editing `foo.md` (existing behavior); no banner on the source tab.
2. Move/rename the original `foo.md` on disk, then open the mirror in the vault → banner shows "Mirror — source not on this device" + "Relink local source…". Click it, pick the moved file → it relinks and opens the moved file; `{vault}/.notemd/mirrors/*.json` now points at the new path.
3. On a *second* device (pull the vault): open the same mirror → banner shows relink (this device has no source) → pick the local copy → relinks under this device's deviceId (a new `{stem}.{deviceId8}.json`, the other device's meta untouched).

## Definition of Done (Phase 2)

- `cargo test --lib` pass; `pnpm check` 0 errors; `pnpm test` pass.
- `notemd_relink_mirror_source` updates this device's Record + writes this device's mirror meta; hashes recomputed.
- Frontend loads `notemd_mirror_metas`; banner offers "Edit source" when the source exists and "Relink local source…" when it's absent or this device never linked it.

Out of scope (later phases): session-time source↔mirror consistency (Phase 3), multi-device note merge (Phase 4), concurrent same-note editing. Retiring the app-support `Record` store is NOT done here (dual model remains).
