# Open Recent Menu (with multi-device git sync) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `Open Recent` submenu to the native macOS File menu, backed by the existing recent-files store, with the history synced across devices through the git-backed Vault.

**Architecture:** Pure merge/format logic lives in a standalone testable module. A sync module writes this device's recents to `<vault>/.mdeditor/recents/<deviceId>.json` (auto-committed by the existing Vault watcher) and merges all devices' files into the menu. Rust gains an `Open Recent` submenu handle + an `update_recent_menu` command; the Vault sync loop emits `editor://recents-synced` when a pull touches the recents dir so the menu refreshes immediately.

**Tech Stack:** Tauri v2 (Rust), Svelte 5 runes, TypeScript, Vitest, `@tauri-apps/plugin-fs`, `@tauri-apps/plugin-os`.

**Spec:** `docs/superpowers/specs/2026-06-29-open-recent-menu-design.md`

---

## File Structure

**Create:**
- `src/lib/recent-merge.ts` — pure functions: path classification, entry resolution, merge, label formatting, shared types.
- `src/lib/recent-merge.test.ts` — unit tests for the above.
- `src/lib/recent-sync.svelte.ts` — IO/orchestration: device-file read/write, merge driver, native-menu push, install hook. `mergedRecents` reactive state.

**Modify:**
- `src/lib/settings.svelte.ts` — add `recentOpenedAt`, `recentTombstones`, `deviceId`; `removeRecentFile`; getters; a recents-changed handler hook; persist new keys.
- `src/lib/settings.test.ts` — tests for `removeRecentFile` + tombstone + `recentOpenedAt`.
- `src-tauri/capabilities/default.json` — add `fs:allow-read-dir`.
- `src-tauri/src/lib.rs` — `RecentMenu` state, `Open Recent` submenu in `build_menu`, `update_recent_menu` command, register + manage.
- `src-tauri/src/vault_sync/service.rs` — emit `editor://recents-synced` when a sync touches `.mdeditor/recents/`.
- `src/App.svelte` — `menu-event` branch for `open-recent:`, install the sync on mount.
- `src/components/DrawerNav.svelte` — read merged recents (so iOS/mobile shows synced history).

---

## Task 1: Add `fs:allow-read-dir` capability

**Files:**
- Modify: `src-tauri/capabilities/default.json:54-57`

The frontend needs to list `<vault>/.mdeditor/recents/`. `readDir` is not yet permitted.

- [ ] **Step 1: Add the permission**

In `src-tauri/capabilities/default.json`, immediately after the `fs:allow-mkdir` block (lines 54-57), add:

```json
    {
      "identifier": "fs:allow-read-dir",
      "allow": [{ "path": "**" }, { "path": "/**" }]
    },
```

So the region reads:

```json
    {
      "identifier": "fs:allow-mkdir",
      "allow": [{ "path": "**" }, { "path": "/**" }]
    },
    {
      "identifier": "fs:allow-read-dir",
      "allow": [{ "path": "**" }, { "path": "/**" }]
    },
    "opener:default",
```

- [ ] **Step 2: Verify JSON is valid**

Run: `python3 -m json.tool src-tauri/capabilities/default.json > /dev/null && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/capabilities/default.json
git commit -m "feat(recents): allow fs read-dir for vault recents listing"
```

---

## Task 2: Pure merge/format module (`recent-merge.ts`)

**Files:**
- Create: `src/lib/recent-merge.ts`
- Test: `src/lib/recent-merge.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/recent-merge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  isUnder,
  toSyncedEntry,
  resolveEntry,
  mergeRecents,
  formatRecentLabel,
  type DeviceRecents,
  type ResolvedRecent,
} from './recent-merge'

describe('isUnder', () => {
  it('true for path inside root, false otherwise', () => {
    expect(isUnder('/v/notes/a.md', '/v')).toBe(true)
    expect(isUnder('/v', '/v')).toBe(true)
    expect(isUnder('/vault2/a.md', '/v')).toBe(false)
  })
})

describe('toSyncedEntry', () => {
  it('uses rel for vault-internal paths', () => {
    expect(toSyncedEntry('/v/notes/a.md', 100, '/v')).toEqual({ rel: 'notes/a.md', lastOpened: 100 })
  })
  it('uses abs for vault-external paths', () => {
    expect(toSyncedEntry('/other/a.md', 100, '/v')).toEqual({ abs: '/other/a.md', lastOpened: 100 })
  })
  it('uses abs when no vault configured', () => {
    expect(toSyncedEntry('/x/a.md', 100, null)).toEqual({ abs: '/x/a.md', lastOpened: 100 })
  })
})

describe('resolveEntry', () => {
  it('resolves rel against the local vault root', () => {
    expect(resolveEntry({ rel: 'notes/a.md', lastOpened: 5 }, '/local')).toEqual({ path: '/local/notes/a.md', lastOpened: 5 })
  })
  it('drops rel entry when no vault root', () => {
    expect(resolveEntry({ rel: 'notes/a.md', lastOpened: 5 }, null)).toBeNull()
  })
  it('passes abs through unchanged', () => {
    expect(resolveEntry({ abs: '/x/a.md', lastOpened: 5 }, '/local')).toEqual({ path: '/x/a.md', lastOpened: 5 })
  })
})

describe('mergeRecents', () => {
  const local: ResolvedRecent[] = [{ path: '/v/a.md', lastOpened: 50 }]
  it('unions local + device files, dedups by path keeping max lastOpened, sorts desc', () => {
    const devices: DeviceRecents[] = [
      { deviceId: 'd2', deviceName: 'D2', entries: [
        { rel: 'a.md', lastOpened: 80 },     // same file, newer → /v/a.md ts 80
        { rel: 'b.md', lastOpened: 70 },
      ] },
    ]
    expect(mergeRecents(local, devices, '/v', [], 10)).toEqual(['/v/a.md', '/v/b.md'])
  })
  it('filters tombstoned paths', () => {
    const devices: DeviceRecents[] = [
      { deviceId: 'd2', deviceName: 'D2', entries: [{ abs: '/x/gone.md', lastOpened: 99 }] },
    ]
    expect(mergeRecents(local, devices, '/v', ['/x/gone.md'], 10)).toEqual(['/v/a.md'])
  })
  it('caps at limit', () => {
    const many: ResolvedRecent[] = Array.from({ length: 15 }, (_, i) => ({ path: `/v/${i}.md`, lastOpened: i }))
    expect(mergeRecents(many, [], '/v', [], 10)).toHaveLength(10)
  })
})

describe('formatRecentLabel', () => {
  it('abbreviates home and shows filename — dir', () => {
    expect(formatRecentLabel('/Users/b/docs/a.md', '/Users/b')).toBe('a.md — ~/docs')
  })
  it('shows raw dir when not under home', () => {
    expect(formatRecentLabel('/srv/a.md', '/Users/b')).toBe('a.md — /srv')
  })
  it('handles no home', () => {
    expect(formatRecentLabel('/srv/a.md', null)).toBe('a.md — /srv')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/recent-merge.test.ts`
Expected: FAIL — `Cannot find module './recent-merge'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/recent-merge.ts`:

```ts
/** One file's worth of a single device's recent history (synced via git). */
export interface SyncedEntry {
  /** Vault-relative path (set when the file lives inside the Vault). */
  rel?: string
  /** Absolute path (set when the file lives outside the Vault). */
  abs?: string
  /** Last-opened time, ms since epoch. */
  lastOpened: number
}

export interface DeviceRecents {
  deviceId: string
  deviceName: string
  entries: SyncedEntry[]
}

/** A recent resolved to an absolute path on THIS device. */
export interface ResolvedRecent {
  path: string
  lastOpened: number
}

function withTrailingSlash(root: string): string {
  return root.endsWith('/') ? root : root + '/'
}

export function isUnder(path: string, root: string): boolean {
  if (path === root) return true
  return path.startsWith(withTrailingSlash(root))
}

/** Classify a local absolute path for storage in this device's synced file. */
export function toSyncedEntry(absPath: string, lastOpened: number, vaultRoot: string | null): SyncedEntry {
  if (vaultRoot && isUnder(absPath, vaultRoot)) {
    return { rel: absPath.slice(withTrailingSlash(vaultRoot).length), lastOpened }
  }
  return { abs: absPath, lastOpened }
}

/** Resolve a synced entry to an absolute path on this device, or null if unresolvable. */
export function resolveEntry(e: SyncedEntry, vaultRoot: string | null): ResolvedRecent | null {
  if (e.rel != null) {
    if (!vaultRoot) return null
    return { path: withTrailingSlash(vaultRoot) + e.rel, lastOpened: e.lastOpened }
  }
  if (e.abs != null) return { path: e.abs, lastOpened: e.lastOpened }
  return null
}

/**
 * Merge this device's recents with every other device's synced file.
 * Dedups by absolute path (keeping the most-recent lastOpened), drops
 * tombstoned paths, sorts newest-first, and caps at `limit`.
 */
export function mergeRecents(
  local: ResolvedRecent[],
  deviceFiles: DeviceRecents[],
  vaultRoot: string | null,
  tombstones: string[],
  limit = 10,
): string[] {
  const byPath = new Map<string, number>()
  const add = (path: string, ts: number) => {
    const prev = byPath.get(path)
    if (prev === undefined || ts > prev) byPath.set(path, ts)
  }
  for (const r of local) add(r.path, r.lastOpened)
  for (const f of deviceFiles) {
    for (const e of f.entries) {
      const r = resolveEntry(e, vaultRoot)
      if (r) add(r.path, r.lastOpened)
    }
  }
  const tomb = new Set(tombstones)
  return [...byPath.entries()]
    .filter(([p]) => !tomb.has(p))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([p]) => p)
}

/**
 * Native macOS menu items have no tooltip, so the full path lives in the label:
 * `filename — ~/parent/dir` (home-abbreviated).
 */
export function formatRecentLabel(absPath: string, home: string | null): string {
  const i = absPath.lastIndexOf('/')
  const name = i >= 0 ? absPath.slice(i + 1) : absPath
  const dir = i > 0 ? absPath.slice(0, i) : ''
  const h = home ? home.replace(/\/$/, '') : null
  const shownDir = h && (dir === h || dir.startsWith(h + '/')) ? '~' + dir.slice(h.length) : dir
  return shownDir ? `${name} — ${shownDir}` : name
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/recent-merge.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/lib/recent-merge.ts src/lib/recent-merge.test.ts
git commit -m "feat(recents): pure merge/classify/format module"
```

---

## Task 3: Settings — sidecar maps, deviceId, removeRecentFile, change hook

**Files:**
- Modify: `src/lib/settings.svelte.ts` (vars near line 62; `load`/`save` near 158/181; `pushRecentFile` near 193)
- Test: `src/lib/settings.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/settings.test.ts` inside the top-level (after the `settings` describe block, before `theme settings`), a new block:

```ts
describe('recent files: opened-at, tombstones, removal', () => {
  it('pushRecentFile records a lastOpened timestamp for the path', async () => {
    const { pushRecentFile, getRecentOpenedAt } = await import('./settings.svelte')
    const before = Date.now()
    await pushRecentFile('/tmp/a.md')
    const ts = getRecentOpenedAt()['/tmp/a.md']
    expect(ts).toBeGreaterThanOrEqual(before)
  })

  it('removeRecentFile drops the path, clears its timestamp, and tombstones it', async () => {
    const { pushRecentFile, removeRecentFile, getRecentFiles, getRecentOpenedAt, getRecentTombstones } =
      await import('./settings.svelte')
    await pushRecentFile('/tmp/a.md')
    await pushRecentFile('/tmp/b.md')
    await removeRecentFile('/tmp/a.md')
    expect(getRecentFiles()).not.toContain('/tmp/a.md')
    expect(getRecentFiles()).toContain('/tmp/b.md')
    expect(getRecentOpenedAt()['/tmp/a.md']).toBeUndefined()
    expect(getRecentTombstones()).toContain('/tmp/a.md')
  })

  it('loadSettings hydrates recentOpenedAt and recentTombstones', async () => {
    mockGet.mockImplementation(async (key: string) => {
      if (key === 'recentOpenedAt') return { '/tmp/x.md': 123 }
      if (key === 'recentTombstones') return ['/tmp/gone.md']
      return undefined
    })
    const { loadSettings, getRecentOpenedAt, getRecentTombstones } = await import('./settings.svelte')
    await loadSettings()
    expect(getRecentOpenedAt()['/tmp/x.md']).toBe(123)
    expect(getRecentTombstones()).toContain('/tmp/gone.md')
  })

  it('getDeviceId generates and persists an id when absent', async () => {
    mockGet.mockResolvedValue(undefined)
    const { loadSettings, getDeviceId } = await import('./settings.svelte')
    await loadSettings()
    const id = getDeviceId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    expect(mockSet.mock.calls.some((a) => a[0] === 'device.id')).toBe(true)
  })

  it('setRecentsChangedHandler is invoked on pushRecentFile', async () => {
    const { setRecentsChangedHandler, pushRecentFile } = await import('./settings.svelte')
    const fn = vi.fn()
    setRecentsChangedHandler(fn)
    await pushRecentFile('/tmp/z.md')
    expect(fn).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/settings.test.ts`
Expected: FAIL — `getRecentOpenedAt`/`removeRecentFile`/`getDeviceId`/`setRecentsChangedHandler` are not exported.

- [ ] **Step 3: Add the module state**

In `src/lib/settings.svelte.ts`, after line 63 (`let recentModesByExt: Record<string, Mode> = {}`), add:

```ts
let recentOpenedAt: Record<string, number> = {}
let recentTombstones: string[] = []
let deviceId: string | null = null
let recentsChangedHandler: (() => void) | null = null
const TOMBSTONE_CAP = 200
```

- [ ] **Step 4: Hydrate in loadSettings**

In `src/lib/settings.svelte.ts`, immediately after line 159 (`recentModesByExt = (await s.get<Record<string, Mode>>('recentModesByExt')) ?? {}`), add:

```ts
  recentOpenedAt = (await s.get<Record<string, number>>('recentOpenedAt')) ?? {}
  recentTombstones = (await s.get<string[]>('recentTombstones')) ?? []
  deviceId = (await s.get<string>('device.id')) ?? null
  if (!deviceId) {
    deviceId = crypto.randomUUID()
    await s.set('device.id', deviceId)
    await s.save()
  }
```

- [ ] **Step 5: Persist in saveSettings**

In `src/lib/settings.svelte.ts`, immediately after line 182 (`await s.set('recentModesByExt', recentModesByExt)`), add:

```ts
  await s.set('recentOpenedAt', recentOpenedAt)
  await s.set('recentTombstones', recentTombstones)
```

- [ ] **Step 6: Update pushRecentFile and add new exports**

In `src/lib/settings.svelte.ts`, replace the existing `pushRecentFile` (lines 193-196):

```ts
export async function pushRecentFile(path: string): Promise<void> {
  recentFiles = [path, ...recentFiles.filter((p) => p !== path)].slice(0, 10)
  await saveSettings()
}
```

with:

```ts
export async function pushRecentFile(path: string): Promise<void> {
  recentFiles = [path, ...recentFiles.filter((p) => p !== path)].slice(0, 10)
  recentOpenedAt[path] = Date.now()
  // Drop timestamps for paths no longer in the list.
  for (const k of Object.keys(recentOpenedAt)) {
    if (!recentFiles.includes(k)) delete recentOpenedAt[k]
  }
  // Re-opening a previously-failed file clears its tombstone.
  recentTombstones = recentTombstones.filter((p) => p !== path)
  await saveSettings()
  recentsChangedHandler?.()
}

/** Remove a recent (e.g. it failed to open) and tombstone it so a synced copy won't resurrect it. */
export async function removeRecentFile(path: string): Promise<void> {
  recentFiles = recentFiles.filter((p) => p !== path)
  delete recentOpenedAt[path]
  recentTombstones = [path, ...recentTombstones.filter((p) => p !== path)].slice(0, TOMBSTONE_CAP)
  await saveSettings()
  recentsChangedHandler?.()
}

export function getRecentOpenedAt(): Readonly<Record<string, number>> {
  return recentOpenedAt
}

export function getRecentTombstones(): readonly string[] {
  return recentTombstones
}

export function getDeviceId(): string {
  if (!deviceId) deviceId = crypto.randomUUID()
  return deviceId
}

/** Registered by the recent-sync module; fired after any change to the recents list. */
export function setRecentsChangedHandler(fn: (() => void) | null): void {
  recentsChangedHandler = fn
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/settings.test.ts`
Expected: PASS (all, including the pre-existing tests)

- [ ] **Step 8: Commit**

```bash
git add src/lib/settings.svelte.ts src/lib/settings.test.ts
git commit -m "feat(recents): opened-at + tombstones + deviceId + change hook in settings"
```

---

## Task 4: Sync/orchestration module (`recent-sync.svelte.ts`)

**Files:**
- Create: `src/lib/recent-sync.svelte.ts`

This module is IO-heavy (fs + tauri invoke), so it is verified manually in Task 7's end-to-end check rather than unit-tested.

- [ ] **Step 1: Write the module**

Create `src/lib/recent-sync.svelte.ts`:

```ts
import { readTextFile, writeTextFile, mkdir, readDir, exists } from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { homeDir } from '@tauri-apps/api/path'
import { hostname } from '@tauri-apps/plugin-os'
import {
  getRecentFiles,
  getRecentOpenedAt,
  getRecentTombstones,
  getDeviceId,
  setRecentsChangedHandler,
} from './settings.svelte'
import { sotvaultStore } from './sotvault.svelte'
import {
  toSyncedEntry,
  mergeRecents,
  formatRecentLabel,
  type DeviceRecents,
  type ResolvedRecent,
} from './recent-merge'

const RECENTS_SUBDIR = '.mdeditor/recents'
const PER_DEVICE_CAP = 20

/** Merged recents (this device + every synced device). Read by the menu and DrawerNav. */
export const mergedRecents = $state<{ paths: string[] }>({ paths: [] })

function recentsDir(vaultRoot: string): string {
  return `${vaultRoot.replace(/\/$/, '')}/${RECENTS_SUBDIR}`
}

function localResolved(): ResolvedRecent[] {
  const openedAt = getRecentOpenedAt()
  const now = Date.now()
  return getRecentFiles().map((p, idx) => ({ path: p, lastOpened: openedAt[p] ?? now - idx }))
}

async function readOtherDeviceFiles(vaultRoot: string | null): Promise<DeviceRecents[]> {
  if (!vaultRoot) return []
  const dir = recentsDir(vaultRoot)
  if (!(await exists(dir).catch(() => false))) return []
  const ownFile = `${getDeviceId()}.json`
  const out: DeviceRecents[] = []
  const entries = await readDir(dir).catch(() => [] as Awaited<ReturnType<typeof readDir>>)
  for (const ent of entries) {
    if (!ent.isFile || !ent.name.endsWith('.json') || ent.name === ownFile) continue
    try {
      const parsed = JSON.parse(await readTextFile(`${dir}/${ent.name}`)) as DeviceRecents
      if (parsed && Array.isArray(parsed.entries)) out.push(parsed)
    } catch {
      // Skip corrupt / partially-written files.
    }
  }
  return out
}

/** Rewrite this device's synced file (no-op when no Vault is configured). */
export async function writeOwnDeviceFile(): Promise<void> {
  const vaultRoot = sotvaultStore.vaultRoot
  if (!vaultRoot) return
  const dir = recentsDir(vaultRoot)
  await mkdir(dir, { recursive: true }).catch(() => {})
  const deviceId = getDeviceId()
  const deviceName = (await hostname().catch(() => null)) ?? `Device-${deviceId.slice(0, 8)}`
  const openedAt = getRecentOpenedAt()
  const entries = getRecentFiles()
    .slice(0, PER_DEVICE_CAP)
    .map((p) => toSyncedEntry(p, openedAt[p] ?? Date.now(), vaultRoot))
  const doc: DeviceRecents = { deviceId, deviceName, entries }
  await writeTextFile(`${dir}/${deviceId}.json`, JSON.stringify(doc, null, 2))
}

/** Recompute the merged list and push it to the native menu. */
export async function refreshRecentMenu(): Promise<void> {
  const vaultRoot = sotvaultStore.vaultRoot
  const devices = await readOtherDeviceFiles(vaultRoot)
  mergedRecents.paths = mergeRecents(localResolved(), devices, vaultRoot, [...getRecentTombstones()])
  const home = await homeDir().catch(() => null)
  const items = mergedRecents.paths.map((p, index) => ({ index, label: formatRecentLabel(p, home) }))
  try {
    await invoke('update_recent_menu', { items })
  } catch {
    // No native menu on this platform (iOS); the DrawerNav still reads mergedRecents.
  }
}

/**
 * Wire everything up. Call once on app mount.
 * Returns a cleanup function.
 */
export async function installRecentsSync(): Promise<() => void> {
  setRecentsChangedHandler(() => {
    void (async () => {
      await writeOwnDeviceFile()
      await refreshRecentMenu()
    })()
  })
  const unlisten = await listen('editor://recents-synced', () => {
    void refreshRecentMenu()
  })
  await refreshRecentMenu()
  return () => {
    setRecentsChangedHandler(null)
    unlisten()
  }
}
```

- [ ] **Step 2: Type-check the module**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors referencing `recent-sync.svelte.ts`. (Pre-existing unrelated errors, if any, are acceptable — confirm none mention this file.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/recent-sync.svelte.ts
git commit -m "feat(recents): device-file sync + merged-menu orchestration"
```

---

## Task 5: Rust — `Open Recent` submenu + `update_recent_menu` command

**Files:**
- Modify: `src-tauri/src/lib.rs` (state near line 39; `build_menu` 928-1067; command list 639-682; manage near 572; setup near 730)

- [ ] **Step 1: Add the managed state struct**

In `src-tauri/src/lib.rs`, immediately after line 39 (`pub struct TrayRepoItem(Mutex<Option<MenuItem<tauri::Wry>>>);`), add:

```rust
pub struct RecentMenu(pub Mutex<Option<Submenu<tauri::Wry>>>);
```

- [ ] **Step 2: Add the command and its payload type**

In `src-tauri/src/lib.rs`, immediately before `fn build_menu` (line 928), add:

```rust
#[derive(serde::Deserialize)]
struct RecentMenuItem {
    index: usize,
    label: String,
}

/// Rebuild the File ▸ Open Recent submenu from the frontend's merged list.
/// Item ids are `open-recent:<index>`; clicks flow through the normal menu-event.
#[tauri::command]
fn update_recent_menu(app: tauri::AppHandle, items: Vec<RecentMenuItem>) -> Result<(), String> {
    let state = app.state::<RecentMenu>();
    let guard = state.0.lock().unwrap();
    let submenu = guard.as_ref().ok_or("recent menu not initialized")?;

    // Clear existing items.
    loop {
        match submenu.remove_at(0) {
            Ok(Some(_)) => continue,
            _ => break,
        }
    }

    if items.is_empty() {
        let placeholder = MenuItemBuilder::with_id("recent-none", "No Recent Files")
            .enabled(false)
            .build(&app)
            .map_err(|e| e.to_string())?;
        submenu.append(&placeholder).map_err(|e| e.to_string())?;
    } else {
        for it in items {
            let mi = MenuItemBuilder::with_id(format!("open-recent:{}", it.index), it.label)
                .build(&app)
                .map_err(|e| e.to_string())?;
            submenu.append(&mi).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
```

- [ ] **Step 3: Build the submenu inside build_menu and return it**

In `src-tauri/src/lib.rs`, change the `build_menu` signature (line 928-931) return type from `tauri::Result<Menu<R>>` to `tauri::Result<(Menu<R>, Submenu<R>)>`:

```rust
fn build_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    plugin_items: &[plugin_host::LocatedMenuItem],
) -> tauri::Result<(Menu<R>, Submenu<R>)> {
```

Then, inside `build_menu`, replace the File-menu construction (lines 960-987) so the `Open Recent` submenu is created and inserted after `Open…`:

```rust
    let recent_menu: Submenu<R> = SubmenuBuilder::new(app, "Open Recent")
        .item(
            &MenuItemBuilder::with_id("recent-none", "No Recent Files")
                .enabled(false)
                .build(app)?,
        )
        .build()?;

    let mut file_b = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("new", "New").accelerator("Cmd+N").build(app)?)
        .item(&MenuItemBuilder::with_id("open", "Open…").accelerator("Cmd+O").build(app)?)
        .item(&recent_menu)
        .separator()
        .item(
            &MenuItemBuilder::with_id("close-tab", "Close Tab")
                .accelerator("Cmd+W")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("save", "Save").accelerator("Cmd+S").build(app)?)
        .item(
            &MenuItemBuilder::with_id("save-as", "Save As…")
                .accelerator("Cmd+Shift+S")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("print", "Print…")
                .accelerator("Cmd+P")
                .build(app)?,
        );
    for it in plugin_items.iter().filter(|p| p.location == "file") {
        let mut b = MenuItemBuilder::with_id(&it.id, &it.label);
        if let Some(s) = &it.shortcut { b = b.accelerator(s); }
        file_b = file_b.item(&b.build(app)?);
    }
    let file_menu: Submenu<R> = file_b.build()?;
```

Finally, change the last line of `build_menu` (line 1066) from:

```rust
    top.items(&[&window_menu, &help_menu]).build()
```

to:

```rust
    let menu = top.items(&[&window_menu, &help_menu]).build()?;
    Ok((menu, recent_menu))
```

- [ ] **Step 4: Manage the state and store the submenu at setup**

In `src-tauri/src/lib.rs`, find the existing manage call (line 572, `let builder = builder.manage(TrayRepoItem(Mutex::new(None)));`) and add right after it:

```rust
    let builder = builder.manage(RecentMenu(Mutex::new(None)));
```

Then update the build_menu call site (line 730, `let menu = build_menu(&app.handle(), &plugin_items)?;`) to capture and store the submenu:

```rust
                let (menu, recent_submenu) = build_menu(&app.handle(), &plugin_items)?;
                *app.state::<RecentMenu>().0.lock().unwrap() = Some(recent_submenu);
```

- [ ] **Step 5: Register the command in both invoke handlers**

In `src-tauri/src/lib.rs`, add `update_recent_menu,` to BOTH `tauri::generate_handler!` lists. The first list ends near line 651 (`editor_show_and_open_path, editor_open_remote_buffer,`); the second near line 682. After the `editor_open_remote_buffer,` line in each list, add:

```rust
                update_recent_menu,
```

- [ ] **Step 6: Build the Rust app to verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | tail -30`
Expected: `Finished` (no errors). Watch for: borrow/move errors on `recent_submenu`, missing `Submenu` import (already imported at line 11), or `enabled` method availability.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(recents): native Open Recent submenu + update_recent_menu command"
```

---

## Task 6: Rust — emit `editor://recents-synced` after a relevant sync

**Files:**
- Modify: `src-tauri/src/vault_sync/service.rs:116-144` (`do_sync`)

- [ ] **Step 1: Capture HEAD before sync and emit on recents change**

In `src-tauri/src/vault_sync/service.rs`, replace the body of `do_sync` (lines 116-144) with:

```rust
fn do_sync(app: &AppHandle, repo: &PathBuf, remote: &str, branch: &str) {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    set_state(app, SyncState::Syncing);
    mgr.logs.push("INFO", "Syncing...");

    let head_before = git_ops::run_git(repo, &["rev-parse", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string());

    match git_ops::sync(repo, remote, branch) {
        Ok(()) => {
            let ts = format!("{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default().as_secs());
            *mgr.last_sync.lock().unwrap() = Some(ts);
            *mgr.error_msg.lock().unwrap() = None;
            set_state(app, SyncState::Running);
            mgr.logs.push("INFO", "Sync completed");

            // If this sync changed any per-device recents file, tell the UI to refresh the menu.
            let head_after = git_ops::run_git(repo, &["rev-parse", "HEAD"])
                .ok()
                .map(|s| s.trim().to_string());
            if let (Some(before), Some(after)) = (head_before.as_ref(), head_after.as_ref()) {
                if before != after {
                    if let Ok(diff) = git_ops::run_git(repo, &["diff", "--name-only", before, after]) {
                        if diff.lines().any(|l| l.trim().starts_with(".mdeditor/recents/")) {
                            let _ = app.emit("editor://recents-synced", ());
                        }
                    }
                }
            }
        }
        Err(e) => {
            if e.contains("conflict") || e.contains("Conflict") {
                set_state(app, SyncState::Conflict);
                mgr.logs.push("WARN", &format!("Conflict: {e}"));
            } else {
                *mgr.error_msg.lock().unwrap() = Some(e.clone());
                set_state(app, SyncState::Error);
                mgr.logs.push("ERROR", &e);
            }
        }
    }

    let _ = app.emit("vault-sync-log", ());
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | tail -20`
Expected: `Finished` (no errors). `Emitter` is already imported (line 5).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/vault_sync/service.rs
git commit -m "feat(recents): emit editor://recents-synced when a sync touches recents"
```

---

## Task 7: Frontend wiring — App.svelte + DrawerNav

**Files:**
- Modify: `src/App.svelte` (imports near 15-17; `menu-event` listener 392-477; onMount cleanup near 497-511)
- Modify: `src/components/DrawerNav.svelte:3,9`

- [ ] **Step 1: Import the new pieces in App.svelte**

In `src/App.svelte`, change line 16 from:

```ts
  import { loadSettings, settings } from './lib/settings.svelte'
```

to:

```ts
  import { loadSettings, settings, removeRecentFile } from './lib/settings.svelte'
```

Then add a new import after line 48 (`import { syncCurrentToVault, ... } from './lib/sotvault.svelte'`):

```ts
  import { installRecentsSync, mergedRecents } from './lib/recent-sync.svelte'
```

- [ ] **Step 2: Handle `open-recent:` menu clicks**

In `src/App.svelte`, inside the `menu-event` listener, immediately after the plugin branch (after line 398, the closing `}` of `if (plugin) { ... return }`), add:

```ts
      if (id.startsWith('open-recent:')) {
        const idx = parseInt(id.slice('open-recent:'.length), 10)
        const path = mergedRecents.paths[idx]
        if (path) {
          try {
            await openFile(path)
          } catch (e) {
            await removeRecentFile(path)
            await showError(String(e))
          }
        }
        return
      }
```

- [ ] **Step 3: Install the sync on mount**

In `src/App.svelte`, declare a holder near the other `unlisten*` variables (after line 390, the close of the `onCloseRequested` IIFE). Add:

```ts
    let cleanupRecents: (() => void) | null = null
    installRecentsSync().then((fn) => { cleanupRecents = fn })
```

Then, in the cleanup return (lines 497-511), add a line before `stopAutoSave?.()`:

```ts
      cleanupRecents?.()
```

- [ ] **Step 4: DrawerNav reads merged recents**

In `src/components/DrawerNav.svelte`, change line 3 from:

```ts
  import { getRecentFiles } from '../lib/settings.svelte'
```

to:

```ts
  import { getRecentFiles } from '../lib/settings.svelte'
  import { mergedRecents } from '../lib/recent-sync.svelte'
```

and change line 9 from:

```ts
  let recents = $derived(getRecentFiles())
```

to:

```ts
  let recents = $derived(mergedRecents.paths.length ? mergedRecents.paths : getRecentFiles())
```

- [ ] **Step 5: Type-check + unit tests**

Run: `pnpm exec tsc --noEmit -p tsconfig.json && pnpm vitest run src/lib/recent-merge.test.ts src/lib/settings.test.ts`
Expected: no new type errors; all listed tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/App.svelte src/components/DrawerNav.svelte
git commit -m "feat(recents): wire Open Recent into App menu handling + DrawerNav"
```

---

## Task 8: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the app**

Run: `pnpm tauri dev`
Expected: app launches, no console errors mentioning `recent`/`update_recent_menu`.

- [ ] **Step 2: Verify the menu populates**

Open 2-3 files (Cmd+O). Click **File ▸ Open Recent**.
Expected: submenu lists the opened files as `filename — ~/dir`, newest first. Clicking one re-focuses/opens it.

- [ ] **Step 3: Verify auto-remove on missing file**

In a terminal, move/delete one of the recent files. In the app, click that item under Open Recent.
Expected: an error toast/dialog appears AND the item disappears from Open Recent (re-open the submenu to confirm).

- [ ] **Step 4: Verify empty state**

With a fresh profile (or after clearing recents), open Open Recent.
Expected: a single disabled `No Recent Files` entry.

- [ ] **Step 5: Verify multi-device sync (two clones)**

With a Vault configured and sync running, in clone/device A open a file inside the Vault. Wait for the auto-sync commit/push (watch the sync log). On device B (same Vault, synced), within ~30s of its next sync:
Expected: the file appears under device B's File ▸ Open Recent without restarting B. Confirm `<vault>/.mdeditor/recents/<deviceId>.json` exists for each device and contains `rel` entries for vault-internal files.

- [ ] **Step 6: Final lint/build sanity**

Run: `pnpm build && cd src-tauri && cargo build`
Expected: both succeed.

---

## Notes for the implementer

- **No circular imports:** `settings.svelte.ts` never imports `recent-sync`; the sync module registers a callback via `setRecentsChangedHandler`. Keep it that way.
- **Vitest command:** the repo uses `pnpm vitest run <file>`. Confirm with `pnpm vitest --version` if unsure.
- **Don't refactor** the existing menu/sync code beyond the edits described.
- **iOS:** `update_recent_menu` will error on iOS (no menu); this is caught in `refreshRecentMenu`. DrawerNav still shows `mergedRecents`. Live refresh on an iOS git pull is out of scope for v1.
