# Folder View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, toggleable left-hand tree file browser (Folder View) to the desktop app, rooted at the current markdown file's directory, that opens any clicked file in the main view.

**Architecture:** A self-contained reactive state module (`folder-view.svelte.ts`) holds visibility/width/root/expansion state, reads directories via `@tauri-apps/plugin-fs`, and persists visibility+width to the existing `settings.json` store. Two Svelte components render the sidebar (`FolderView.svelte`) and its recursive rows (`FolderTreeNode.svelte`). `App.svelte` renders the sidebar inside `section.pane`, feeds it the active file path, and handles a new native View-menu `CheckMenuItem`. A small Rust command syncs the menu checkmark.

**Tech Stack:** Svelte 5 (runes: `$state`/`$derived`/`$effect`/`$props`), TypeScript, Vitest, Tauri v2 (Rust menu API, `@tauri-apps/plugin-fs`, `@tauri-apps/plugin-store`).

---

## File Structure

- Create: `src/lib/folder-view.svelte.ts` — reactive state + pure logic (parent dir, subtree check, sort, classify) + `readDir`/persistence side-effects.
- Create: `src/lib/folder-view.test.ts` — unit tests for the pure logic and persistence.
- Create: `src/components/FolderView.svelte` — sidebar container (header + tree + resize splitter).
- Create: `src/components/FolderTreeNode.svelte` — recursive row (folder/file).
- Modify: `src/App.svelte` — render `<FolderView>` in `section.pane`; feed active file path; handle `toggle-folder-view` menu event; sync checkmark.
- Modify: `src-tauri/src/lib.rs` — add `toggle-folder-view` `CheckMenuItem` to the View submenu; add `set_menu_item_checked` command; register it.

---

## Task 1: State module — pure logic

**Files:**
- Create: `src/lib/folder-view.svelte.ts`
- Test: `src/lib/folder-view.test.ts`

- [ ] **Step 1: Write the failing test for pure helpers**

Create `src/lib/folder-view.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parentDir, isWithinDir, sortEntries, type FolderEntry } from './folder-view.svelte'

describe('parentDir', () => {
  it('returns parent of a file path', () => {
    expect(parentDir('/a/b/c.md')).toBe('/a/b')
  })
  it('returns parent of a directory path (no trailing slash)', () => {
    expect(parentDir('/a/b')).toBe('/a')
  })
  it('strips a trailing slash before computing', () => {
    expect(parentDir('/a/b/')).toBe('/a')
  })
  it('returns "/" when parent is root', () => {
    expect(parentDir('/a')).toBe('/')
  })
  it('returns "/" for root itself', () => {
    expect(parentDir('/')).toBe('/')
  })
})

describe('isWithinDir', () => {
  it('true for a direct child file', () => {
    expect(isWithinDir('/a/b/c.md', '/a/b')).toBe(true)
  })
  it('true for a nested descendant', () => {
    expect(isWithinDir('/a/b/deep/c.md', '/a/b')).toBe(true)
  })
  it('false for a sibling directory', () => {
    expect(isWithinDir('/a/bb/c.md', '/a/b')).toBe(false)
  })
  it('tolerates a trailing slash on dir', () => {
    expect(isWithinDir('/a/b/c.md', '/a/b/')).toBe(true)
  })
  it('false when file is the dir itself', () => {
    expect(isWithinDir('/a/b', '/a/b')).toBe(false)
  })
})

describe('sortEntries', () => {
  it('puts folders before files, each name-sorted case-insensitively', () => {
    const input: FolderEntry[] = [
      { name: 'zebra.md', path: '/x/zebra.md', isDir: false, kind: 'markdown' },
      { name: 'Apple', path: '/x/Apple', isDir: true, kind: null },
      { name: 'banana.md', path: '/x/banana.md', isDir: false, kind: 'markdown' },
      { name: 'apricot', path: '/x/apricot', isDir: true, kind: null },
    ]
    const out = sortEntries(input).map((e) => e.name)
    expect(out).toEqual(['Apple', 'apricot', 'banana.md', 'zebra.md'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- folder-view`
Expected: FAIL — cannot resolve `./folder-view.svelte` / exports not defined.

- [ ] **Step 3: Write the pure helpers**

Create `src/lib/folder-view.svelte.ts`:

```ts
import { readDir } from '@tauri-apps/plugin-fs'
import { Store } from '@tauri-apps/plugin-store'
import { classifyPath, type FileKind } from './fs'

export interface FolderEntry {
  name: string
  path: string
  isDir: boolean
  kind: FileKind | null // null = directory or unsupported file type
}

/** Parent directory of a file or directory path. Returns '/' at the root. */
export function parentDir(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
  const i = trimmed.lastIndexOf('/')
  if (i <= 0) return '/'
  return trimmed.slice(0, i)
}

/** True when `file` is strictly inside directory `dir` (any depth). */
export function isWithinDir(file: string, dir: string): boolean {
  const d = dir.length > 1 ? dir.replace(/\/+$/, '') : dir
  const prefix = d === '/' ? '/' : d + '/'
  return file !== d && file.startsWith(prefix)
}

/** Folders first, then files; each group sorted by name, case-insensitive. */
export function sortEntries(entries: FolderEntry[]): FolderEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- folder-view`
Expected: PASS (all `parentDir` / `isWithinDir` / `sortEntries` cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/folder-view.svelte.ts src/lib/folder-view.test.ts
git commit -m "feat(folder-view): pure path/sort helpers"
```

---

## Task 2: State module — readDir + reactive state + persistence

**Files:**
- Modify: `src/lib/folder-view.svelte.ts`
- Test: `src/lib/folder-view.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/folder-view.test.ts`:

```ts
import { vi, beforeEach } from 'vitest'

// Mock the Tauri plugins used by the module's side-effects.
const readDirMock = vi.fn()
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: (...args: unknown[]) => readDirMock(...args),
}))
const storeGet = vi.fn()
const storeSet = vi.fn()
const storeSave = vi.fn()
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: vi.fn(async () => ({ get: storeGet, set: storeSet, save: storeSave })) },
}))

import {
  folderView,
  readFolder,
  syncToActiveFile,
  toggleExpanded,
  loadFolderViewState,
  setVisible,
  setWidth,
} from './folder-view.svelte'

beforeEach(() => {
  readDirMock.mockReset()
  storeGet.mockReset(); storeSet.mockReset(); storeSave.mockReset()
  folderView.visible = false
  folderView.width = 240
  folderView.rootDir = null
  folderView.expanded = new Set()
  folderView.entriesCache = new Map()
})

describe('readFolder', () => {
  it('reads, classifies, sorts, and caches directory entries', async () => {
    readDirMock.mockResolvedValue([
      { name: 'note.md', isDirectory: false, isFile: true },
      { name: 'sub', isDirectory: true, isFile: false },
      { name: '.hidden', isDirectory: false, isFile: true },
      { name: 'pic.png', isDirectory: false, isFile: true },
    ])
    const out = await readFolder('/root')
    expect(out.map((e) => e.name)).toEqual(['sub', 'note.md', 'pic.png']) // dotfile filtered, folder first
    expect(out.find((e) => e.name === 'note.md')?.kind).toBe('markdown')
    expect(folderView.entriesCache.get('/root')).toEqual(out) // cached
  })
})

describe('syncToActiveFile', () => {
  it('resets root to the file parent when outside current subtree', async () => {
    readDirMock.mockResolvedValue([])
    folderView.rootDir = '/other'
    await syncToActiveFile('/a/b/c.md')
    expect(folderView.rootDir).toBe('/a/b')
  })
  it('keeps root when the file is within the current subtree', async () => {
    readDirMock.mockResolvedValue([])
    folderView.rootDir = '/a'
    await syncToActiveFile('/a/b/c.md')
    expect(folderView.rootDir).toBe('/a')
  })
  it('ignores null (untitled) files', async () => {
    folderView.rootDir = '/a'
    await syncToActiveFile(null)
    expect(folderView.rootDir).toBe('/a')
  })
})

describe('toggleExpanded', () => {
  it('adds then removes a path', async () => {
    readDirMock.mockResolvedValue([])
    await toggleExpanded('/a/sub')
    expect(folderView.expanded.has('/a/sub')).toBe(true)
    await toggleExpanded('/a/sub')
    expect(folderView.expanded.has('/a/sub')).toBe(false)
  })
})

describe('persistence', () => {
  it('hydrates visible+width from the store', async () => {
    storeGet.mockImplementation(async (k: string) =>
      k === 'folderView.visible' ? true : k === 'folderView.width' ? 300 : undefined)
    await loadFolderViewState()
    expect(folderView.visible).toBe(true)
    expect(folderView.width).toBe(300)
  })
  it('setVisible writes through to the store', async () => {
    await setVisible(true)
    expect(folderView.visible).toBe(true)
    expect(storeSet).toHaveBeenCalledWith('folderView.visible', true)
    expect(storeSave).toHaveBeenCalled()
  })
  it('setWidth clamps to [160, 480] and persists', async () => {
    await setWidth(9999)
    expect(folderView.width).toBe(480)
    expect(storeSet).toHaveBeenCalledWith('folderView.width', 480)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- folder-view`
Expected: FAIL — `readFolder`/`folderView`/etc. not exported.

- [ ] **Step 3: Implement state, readDir, sync, persistence**

Append to `src/lib/folder-view.svelte.ts`:

```ts
export interface FolderViewState {
  visible: boolean
  width: number
  rootDir: string | null
  expanded: Set<string>
  entriesCache: Map<string, FolderEntry[]>
}

export const DEFAULT_WIDTH = 240
export const MIN_WIDTH = 160
export const MAX_WIDTH = 480

export const folderView = $state<FolderViewState>({
  visible: false,
  width: DEFAULT_WIDTH,
  rootDir: null,
  expanded: new Set(),
  entriesCache: new Map(),
})

function joinPath(dir: string, name: string): string {
  return (dir.endsWith('/') ? dir.slice(0, -1) : dir) + '/' + name
}

/** Read a directory, classify + sort entries, hide dotfiles, and cache. */
export async function readFolder(dir: string): Promise<FolderEntry[]> {
  const raw = await readDir(dir)
  const entries: FolderEntry[] = raw
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const path = joinPath(dir, e.name)
      return {
        name: e.name,
        path,
        isDir: !!e.isDirectory,
        kind: e.isDirectory ? null : (classifyPath(path)?.kind ?? null),
      }
    })
  const sorted = sortEntries(entries)
  folderView.entriesCache.set(dir, sorted)
  return sorted
}

/** Set the tree root and eagerly read it. */
export async function setRootDir(dir: string): Promise<void> {
  folderView.rootDir = dir
  folderView.expanded = new Set()
  await readFolder(dir).catch(() => {})
}

/**
 * React to the active file changing. Reset the root to the file's parent only
 * when the file is outside the current root's subtree (VS Code "reveal"
 * behavior); otherwise keep the root so browsing position is preserved.
 */
export async function syncToActiveFile(filePath: string | null): Promise<void> {
  if (!filePath) return
  const parent = parentDir(filePath)
  if (folderView.rootDir && (folderView.rootDir === parent || isWithinDir(filePath, folderView.rootDir))) {
    return
  }
  await setRootDir(parent)
}

/** Expand/collapse a folder; read its children on first expand. */
export async function toggleExpanded(dir: string): Promise<void> {
  const next = new Set(folderView.expanded)
  if (next.has(dir)) {
    next.delete(dir)
  } else {
    next.add(dir)
    if (!folderView.entriesCache.has(dir)) await readFolder(dir).catch(() => {})
  }
  folderView.expanded = next
}

/** Re-read every directory currently cached (manual refresh). */
export async function refreshAll(): Promise<void> {
  const dirs = [...folderView.entriesCache.keys()]
  await Promise.all(dirs.map((d) => readFolder(d).catch(() => {})))
}

// ---- persistence (settings.json store; shared with settings.svelte.ts) ----

let store: Awaited<ReturnType<typeof Store.load>> | null = null
async function getStore() {
  if (!store) store = await Store.load('settings.json')
  return store
}

export async function loadFolderViewState(): Promise<void> {
  const s = await getStore()
  folderView.visible = (await s.get<boolean>('folderView.visible')) ?? false
  folderView.width = (await s.get<number>('folderView.width')) ?? DEFAULT_WIDTH
}

export async function setVisible(v: boolean): Promise<void> {
  folderView.visible = v
  const s = await getStore()
  await s.set('folderView.visible', v)
  await s.save()
}

export async function setWidth(w: number): Promise<void> {
  const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)))
  folderView.width = clamped
  const s = await getStore()
  await s.set('folderView.width', clamped)
  await s.save()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- folder-view`
Expected: PASS (all Task 1 + Task 2 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/folder-view.svelte.ts src/lib/folder-view.test.ts
git commit -m "feat(folder-view): state, readDir, active-file sync, persistence"
```

---

## Task 3: FolderTreeNode component (recursive row)

**Files:**
- Create: `src/components/FolderTreeNode.svelte`

- [ ] **Step 1: Implement the recursive node**

Create `src/components/FolderTreeNode.svelte`:

```svelte
<script lang="ts">
  import { folderView, toggleExpanded, type FolderEntry } from '../lib/folder-view.svelte'
  import FolderTreeNode from './FolderTreeNode.svelte'

  let {
    entry,
    depth,
    activePath,
    onOpen,
  }: {
    entry: FolderEntry
    depth: number
    activePath: string | null
    onOpen: (path: string) => void
  } = $props()

  let expanded = $derived(folderView.expanded.has(entry.path))
  let children = $derived(folderView.entriesCache.get(entry.path) ?? [])
  let isActive = $derived(!entry.isDir && entry.path === activePath)

  function onRowClick() {
    if (entry.isDir) toggleExpanded(entry.path)
    else onOpen(entry.path)
  }
</script>

<button
  class="node"
  class:active={isActive}
  style="padding-left: {8 + depth * 14}px"
  onclick={onRowClick}
  title={entry.name}
>
  {#if entry.isDir}
    <span class="twisty" class:open={expanded}>▸</span>
    <span class="icon">📁</span>
  {:else}
    <span class="twisty spacer"></span>
    <span class="icon">📄</span>
  {/if}
  <span class="label">{entry.name}</span>
</button>

{#if entry.isDir && expanded}
  {#each children as child (child.path)}
    <FolderTreeNode entry={child} depth={depth + 1} {activePath} {onOpen} />
  {/each}
{/if}

<style>
  .node {
    display: flex; align-items: center; gap: 4px;
    width: 100%; box-sizing: border-box;
    text-align: left; padding: 3px 8px; border: 0; background: transparent;
    font: inherit; font-size: 13px; line-height: 1.4; cursor: pointer;
    white-space: nowrap; overflow: hidden;
  }
  .node:hover { background: rgba(0,0,0,0.05); }
  .node.active { background: rgba(0,0,0,0.1); font-weight: 500; }
  .twisty { display: inline-block; width: 12px; font-size: 10px; opacity: 0.6; transition: transform 0.1s; }
  .twisty.open { transform: rotate(90deg); }
  .twisty.spacer { visibility: hidden; }
  .icon { flex: 0 0 auto; font-size: 12px; }
  .label { overflow: hidden; text-overflow: ellipsis; }
  @media (prefers-color-scheme: dark) {
    .node:hover { background: rgba(255,255,255,0.07); }
    .node.active { background: rgba(255,255,255,0.13); }
  }
</style>
```

- [ ] **Step 2: Verify it type-checks / builds**

Run: `pnpm check`
Expected: No new errors referencing `FolderTreeNode.svelte`.

- [ ] **Step 3: Commit**

```bash
git add src/components/FolderTreeNode.svelte
git commit -m "feat(folder-view): recursive tree node component"
```

---

## Task 4: FolderView sidebar container

**Files:**
- Create: `src/components/FolderView.svelte`

- [ ] **Step 1: Implement the sidebar**

Create `src/components/FolderView.svelte`:

```svelte
<script lang="ts">
  import {
    folderView, setRootDir, setWidth, refreshAll, syncToActiveFile,
    parentDir, type FolderEntry,
  } from '../lib/folder-view.svelte'
  import { openFile } from '../lib/tabs.svelte'
  import { showError } from '../lib/dialogs'

  let { activePath }: { activePath: string | null } = $props()

  // Keep the tree root in step with the active markdown file.
  $effect(() => { void syncToActiveFile(activePath) })

  let rootEntries = $derived<FolderEntry[]>(
    folderView.rootDir ? (folderView.entriesCache.get(folderView.rootDir) ?? []) : []
  )
  let rootName = $derived(
    folderView.rootDir ? (folderView.rootDir.split('/').filter(Boolean).pop() ?? '/') : ''
  )
  let canGoUp = $derived(!!folderView.rootDir && folderView.rootDir !== '/')

  async function open(path: string) {
    try { await openFile(path) } catch (e) { showError(String(e)) }
  }
  function goUp() {
    if (folderView.rootDir) setRootDir(parentDir(folderView.rootDir))
  }

  // Drag-to-resize the sidebar width.
  let dragging = false
  function startDrag(e: PointerEvent) {
    dragging = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onDrag(e: PointerEvent) {
    if (dragging) setWidth(e.clientX)
  }
  function endDrag(e: PointerEvent) {
    dragging = false
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }
</script>

<aside class="folder-view" style="width: {folderView.width}px">
  <div class="header">
    <button class="hbtn" onclick={goUp} disabled={!canGoUp} title="Parent folder">↑</button>
    <span class="root-name" title={folderView.rootDir ?? ''}>{rootName || 'No folder'}</span>
    <button class="hbtn" onclick={() => refreshAll()} title="Refresh">⟳</button>
  </div>
  <div class="tree">
    {#if rootEntries.length === 0}
      <div class="empty">Empty folder</div>
    {:else}
      {#each rootEntries as entry (entry.path)}
        {#await import('./FolderTreeNode.svelte') then { default: FolderTreeNode }}
          <FolderTreeNode {entry} depth={0} {activePath} onOpen={open} />
        {/await}
      {/each}
    {/if}
  </div>
  <div
    class="splitter"
    role="separator"
    aria-orientation="vertical"
    onpointerdown={startDrag}
    onpointermove={onDrag}
    onpointerup={endDrag}
  ></div>
</aside>

<style>
  .folder-view {
    position: relative;
    flex: 0 0 auto;
    height: 100%;
    display: flex; flex-direction: column;
    background: var(--drawer-bg, #f6f6f6);
    border-right: 1px solid rgba(0,0,0,0.08);
    overflow: hidden;
  }
  .header {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 8px; border-bottom: 1px solid rgba(0,0,0,0.06);
    font-size: 12px;
  }
  .root-name {
    flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 600; text-transform: none; opacity: 0.8;
  }
  .hbtn {
    border: 0; background: transparent; cursor: pointer;
    font-size: 14px; padding: 2px 4px; border-radius: 4px; opacity: 0.7;
  }
  .hbtn:hover:not(:disabled) { background: rgba(0,0,0,0.08); opacity: 1; }
  .hbtn:disabled { opacity: 0.25; cursor: default; }
  .tree { flex: 1; overflow: auto; padding: 4px 0; }
  .empty { padding: 12px 10px; opacity: 0.5; font-size: 13px; }
  .splitter {
    position: absolute; top: 0; right: 0; width: 5px; height: 100%;
    cursor: col-resize; touch-action: none;
  }
  .splitter:hover { background: rgba(0,0,0,0.08); }
  @media (prefers-color-scheme: dark) {
    .folder-view { background: var(--drawer-bg, #1c1c1e); border-right-color: rgba(255,255,255,0.08); }
    .header { border-bottom-color: rgba(255,255,255,0.06); }
    .hbtn:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
    .splitter:hover { background: rgba(255,255,255,0.1); }
  }
</style>
```

Note: the inline `{#await import(...)}` avoids a static circular-import concern and keeps the recursive node lazy. `FolderTreeNode.svelte` itself imports `FolderView`? No — it self-imports only, so a plain static import here is also fine; if `pnpm check` prefers static, replace the `{#await}` block with a top-level `import FolderTreeNode from './FolderTreeNode.svelte'` and render `<FolderTreeNode {entry} depth={0} {activePath} onOpen={open} />` directly.

- [ ] **Step 2: Prefer the static import (simpler)**

Replace the `{#await import('./FolderTreeNode.svelte') then ...}` wrapper with a static import. At the top of `<script>` add:

```svelte
  import FolderTreeNode from './FolderTreeNode.svelte'
```

and in the `{#each}` body use directly:

```svelte
      {#each rootEntries as entry (entry.path)}
        <FolderTreeNode {entry} depth={0} {activePath} onOpen={open} />
      {/each}
```

- [ ] **Step 3: Verify it type-checks**

Run: `pnpm check`
Expected: No new errors referencing `FolderView.svelte`.

- [ ] **Step 4: Commit**

```bash
git add src/components/FolderView.svelte
git commit -m "feat(folder-view): sidebar container with header + resize"
```

---

## Task 5: Wire FolderView into App.svelte

**Files:**
- Modify: `src/App.svelte` (imports; `section.pane` render; `menu-event` handler; startup load)

- [ ] **Step 1: Add imports**

In `src/App.svelte`, near the other component imports (e.g. after `import DrawerNav from './components/DrawerNav.svelte'`), add:

```ts
  import FolderView from './components/FolderView.svelte'
  import { folderView, loadFolderViewState, setVisible } from './lib/folder-view.svelte'
```

- [ ] **Step 2: Load persisted state on startup**

Find the existing startup effect/`onMount` that runs `loadSettings()` (search `loadSettings(` in `App.svelte`). Immediately after that call, add:

```ts
      await loadFolderViewState()
```

If `loadSettings` is awaited inside an async IIFE/`onMount`, place this on the next line within the same block. If no such block exists, add an `onMount(() => { void loadFolderViewState() })`.

- [ ] **Step 3: Render the sidebar in `section.pane`**

In `src/App.svelte`, change the pane block (currently around line 622):

```svelte
  <section class="pane">
    {#if current}
```

to:

```svelte
  <section class="pane">
    {#if platformName !== 'ios' && folderView.visible}
      <FolderView activePath={current?.filePath ?? null} />
    {/if}
    {#if current}
```

- [ ] **Step 4: Handle the menu event**

In the `menu-event` listener `switch (id)` (around line 419-432), add a case alongside `toggle-mode`:

```ts
        case 'toggle-folder-view': {
          const next = !folderView.visible
          await setVisible(next)
          try {
            await invoke('set_menu_item_checked', { id: 'toggle-folder-view', checked: next })
          } catch (e) { console.warn('[App] set_menu_item_checked:', e) }
          break
        }
```

(`invoke` is already imported in App.svelte — it is used by the `set_plugin_menu_item_enabled` effect.)

- [ ] **Step 5: Verify type-check + build**

Run: `pnpm check`
Expected: No new errors. (`current` is the existing active-tab derived; `current?.filePath` is a `string | null`.)

- [ ] **Step 6: Commit**

```bash
git add src/App.svelte
git commit -m "feat(folder-view): render sidebar and wire View-menu toggle"
```

---

## Task 6: Native View-menu CheckMenuItem + set_menu_item_checked command

**Files:**
- Modify: `src-tauri/src/lib.rs` (imports; View submenu; new command; handler registration)

- [ ] **Step 1: Import CheckMenuItem builder + kind**

In `src-tauri/src/lib.rs`, extend the `tauri::menu` import (currently lines 10-11) to include `CheckMenuItem` and `CheckMenuItemBuilder`:

```rust
    AboutMetadata, CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem,
    MenuItemBuilder, MenuItemKind, PredefinedMenuItem, Submenu, SubmenuBuilder,
```

- [ ] **Step 2: Add the CheckMenuItem to the View submenu**

In the `build_menu` function, change the View submenu (currently lines 1063-1069):

```rust
    let mut view_b = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("toggle-mode", "Toggle Source / Rich")
                .accelerator("Cmd+/")
                .build(app)?,
        )
        .item(&PredefinedMenuItem::fullscreen(app, None)?);
```

to:

```rust
    let mut view_b = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("toggle-mode", "Toggle Source / Rich")
                .accelerator("Cmd+/")
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("toggle-folder-view", "Folder View")
                .accelerator("Cmd+Shift+E")
                .checked(false)
                .build(app)?,
        )
        .item(&PredefinedMenuItem::fullscreen(app, None)?);
```

- [ ] **Step 3: Add the `set_menu_item_checked` command**

After the `set_plugin_menu_item_enabled` function (ends line 225), add:

```rust
/// Set the checked state of a `CheckMenuItem` by id. Walks the whole menu tree.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn set_menu_item_checked(app: tauri::AppHandle, id: String, checked: bool) -> Result<(), String> {
    fn walk<R: tauri::Runtime>(items: Vec<MenuItemKind<R>>, id: &str, checked: bool) -> bool {
        for item in items {
            match item {
                MenuItemKind::Check(ci) => {
                    if ci.id().0.as_str() == id {
                        let _ = ci.set_checked(checked);
                        return true;
                    }
                }
                MenuItemKind::Submenu(sm) => {
                    if let Ok(child) = sm.items() {
                        if walk(child, id, checked) {
                            return true;
                        }
                    }
                }
                _ => {}
            }
        }
        false
    }
    let menu = app.menu().ok_or_else(|| "no menu set".to_string())?;
    let items = menu.items().map_err(|e| e.to_string())?;
    if walk(items, &id, checked) {
        Ok(())
    } else {
        Err(format!("check menu item not found: {id}"))
    }
}
```

(The unused-import warning for `CheckMenuItem` is silenced because `MenuItemKind::Check(ci)` yields a `CheckMenuItem`; if `CheckMenuItem` remains unused as a bare type, drop it from the import and keep only `CheckMenuItemBuilder`.)

- [ ] **Step 4: Register the command**

In the non-iOS `generate_handler!` block (line 605-660), add `set_menu_item_checked,` right after `set_plugin_menu_item_enabled,`:

```rust
                set_plugin_menu_item_enabled,
                set_menu_item_checked,
```

- [ ] **Step 5: Sync the initial checkmark on startup**

The menu is built with `.checked(false)`. When persisted `folderView.visible` is `true`, App must set the checkmark after load. In `src/App.svelte`, in the same startup block from Task 5 Step 2, after `await loadFolderViewState()` add:

```ts
      if (folderView.visible) {
        try { await invoke('set_menu_item_checked', { id: 'toggle-folder-view', checked: true }) }
        catch (e) { console.warn('[App] init folder-view check:', e) }
      }
```

- [ ] **Step 6: Verify Rust compiles**

Run: `cd src-tauri && cargo check` (or `pnpm tauri build --no-bundle` for a fuller check; `cargo check` is faster)
Expected: Compiles with no errors. Warnings about unused `CheckMenuItem` import → remove it from the import list if present.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src/App.svelte
git commit -m "feat(folder-view): native View-menu checkable toggle"
```

---

## Task 7: Manual verification

**Files:** none (manual run)

- [ ] **Step 1: Run the desktop app**

Run: `pnpm tauri dev`

- [ ] **Step 2: Verify behavior**

Check each:
1. **View menu** shows "Folder View" with `⇧⌘E`; toggling shows/hides the sidebar and the checkmark tracks state.
2. Open a markdown file → sidebar root becomes that file's folder, the file row is highlighted.
3. Expand a subfolder (▸ rotates); click a markdown/other file inside → it opens in the main view.
4. Click ↑ → root moves to the parent directory.
5. Drag the right splitter → width changes and stays within 160–480px.
6. Quit and relaunch → sidebar visibility and width are restored; checkmark matches.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`
Expected: All pass, including the new `folder-view` tests.

- [ ] **Step 4: Final commit (if any manual fixes were needed)**

```bash
git add -A
git commit -m "fix(folder-view): manual verification adjustments"
```

---

## Self-Review Notes

- **Spec coverage:** built-in (not binary plugin) ✓ Task 1-6; left sidebar in `section.pane` ✓ Task 5; all-files tree with folders-first sort + dotfile hiding ✓ Task 2; root = active md dir with reveal-vs-keep + ↑ parent ✓ Tasks 2,4; click file opens in main view ✓ Task 4; active highlight ✓ Task 3; View-menu checkable toggle + `Cmd+Shift+E` ✓ Task 6; default hidden + persist visible/width ✓ Task 2,5; desktop only (`platformName !== 'ios'`) ✓ Task 5; UI reuses `--drawer-bg`/hover ✓ Tasks 3,4; unit tests ✓ Tasks 1,2. Out-of-scope items (no live watch, no context menu) intentionally omitted.
- **Type consistency:** `FolderEntry`, `folderView`, `parentDir`, `isWithinDir`, `sortEntries`, `readFolder`, `setRootDir`, `syncToActiveFile`, `toggleExpanded`, `refreshAll`, `setVisible`, `setWidth`, `loadFolderViewState` used consistently across module, components, and App. Menu id `toggle-folder-view` and command `set_menu_item_checked` consistent between Rust and TS.
- **No placeholders:** every code step contains full code and exact commands.
