# External File Change Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a tab's underlying file is modified or deleted by another application, silently auto-reload clean tabs and show a yellow banner with three resolution actions for dirty tabs.

**Architecture:** Pure state-machine module (`external-state.ts`) decides what to do given a tab snapshot and a disk event; `file-watcher.svelte.ts` plumbs Tauri's `tauri-plugin-fs` watch + a `window.focus` poll into the state machine; banner is a thin Svelte component reacting to new `Tab` fields. Self-write suppression by tracking last-known mtime + sha256.

**Tech Stack:** Svelte 5 runes (`$state`), `@tauri-apps/plugin-fs` (`watchImmediate`, `stat`), Web Crypto (`crypto.subtle.digest('SHA-256', …)`), Vitest.

**Spec:** `docs/superpowers/specs/2026-05-08-external-file-change-detection-design.md`

---

## File Structure

**Create:**
- `src/lib/hash.ts` — `sha256Hex(input: string)` Web-Crypto wrapper
- `src/lib/hash.test.ts`
- `src/lib/external-state.ts` — pure state machine `decide(tab, event)`
- `src/lib/external-state.test.ts`
- `src/lib/file-watcher.svelte.ts` — watcher manager + focus-poll, depends on the two above
- `src/lib/file-watcher.test.ts`
- `src/components/ExternalChangeBanner.svelte` — render-only yellow banner

**Modify:**
- `src/lib/fs.ts` — add `statFile(path)` thin wrapper around plugin-fs
- `src/lib/fs.test.ts` — extend for `statFile`
- `src/lib/tabs.svelte.ts` — extend `Tab` interface; integrate watcher calls in `openFile` / `closeTab` / `saveActive` / `saveAs`; add `reloadFromDisk` / `overwriteOnDisk` / `dismissExternalBanner` actions
- `src/lib/tabs.test.ts` — add tests for new actions
- `src/components/EditorPane.svelte` — render banner above editor
- `src/lib/autosave.svelte.ts` — skip tabs whose `externalState !== 'fresh'`
- `src/App.svelte` — start the watcher on mount; stop on unmount
- `src-tauri/capabilities/default.json` — add `fs:allow-watch`, `fs:allow-unwatch`, `fs:allow-stat` permissions

**Convention:** Each task ends with a single commit. Commit messages use conventional-commits style (`feat:` / `test:` / `refactor:` / `chore:`).

---

## Task 1: SHA-256 utility

**Files:**
- Create: `src/lib/hash.ts`
- Create: `src/lib/hash.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/hash.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sha256Hex } from './hash'

describe('sha256Hex', () => {
  it('returns the canonical SHA-256 hex of empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('returns the canonical SHA-256 hex of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('handles utf-8 multi-byte input', async () => {
    expect(await sha256Hex('M↓')).toBe(
      'a8c4d70d70bdcf6a16e7c1f33b58e90fc4316c1c6c5e0027d4ad3127ac8af1f1',
    )
    // (regenerate with: echo -n 'M↓' | shasum -a 256)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s test src/lib/hash.test.ts`
Expected: FAIL with "Cannot find module './hash'".

- [ ] **Step 3: Implement `sha256Hex`**

Create `src/lib/hash.ts`:

```ts
/** SHA-256 hex digest of `input` using Web Crypto. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
```

- [ ] **Step 4: Verify the third test's expected hash is correct**

Before running: regenerate the M↓ hash to confirm:
Run: `printf 'M\xe2\x86\x93' | shasum -a 256`
If the output doesn't match the expected in step 1, update the test's `expect` to the actual value.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -s test src/lib/hash.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/hash.ts src/lib/hash.test.ts
git commit -m "feat(hash): sha256Hex Web-Crypto wrapper"
```

---

## Task 2: `statFile` helper in `fs.ts`

**Files:**
- Modify: `src/lib/fs.ts` (append a new export)
- Modify: `src/lib/fs.test.ts` (extend with mocked plugin-fs)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/fs.test.ts`:

```ts
import { vi } from 'vitest'

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  stat: vi.fn(async () => ({ mtime: new Date(1_700_000_000_000), size: 42 })),
}))

describe('statFile', () => {
  it('returns mtime in ms and size from plugin-fs.stat', async () => {
    const { statFile } = await import('./fs')
    const info = await statFile('/tmp/foo.md')
    expect(info.mtime).toBe(1_700_000_000_000)
    expect(info.size).toBe(42)
  })

  it('returns null when stat throws', async () => {
    const fsPlug = await import('@tauri-apps/plugin-fs')
    ;(fsPlug.stat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ENOENT'))
    const { statFile } = await import('./fs')
    expect(await statFile('/tmp/missing.md')).toBe(null)
  })
})
```

Note: this requires the existing fs.test.ts to **not** import from `'./fs'` at top level — the module must be re-imported inside each test so the mock takes effect. If the existing top-level `import` exists, leave it alone for the tests already there; the new tests `await import('./fs')` inside.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s test src/lib/fs.test.ts -t statFile`
Expected: FAIL with "statFile is not a function" or similar.

- [ ] **Step 3: Implement `statFile`**

Append to `src/lib/fs.ts` (after the existing exports):

```ts
import { stat as fsStat } from '@tauri-apps/plugin-fs'

export interface FileStat {
  /** Last-modification time in milliseconds since epoch. */
  mtime: number
  /** File size in bytes. */
  size: number
}

/**
 * Stat a path. Returns null if the file does not exist or stat throws.
 * Used by external-change detection to compare the on-disk state against
 * what we last accepted.
 */
export async function statFile(path: string): Promise<FileStat | null> {
  try {
    const info = await fsStat(path)
    return {
      mtime: info.mtime ? info.mtime.getTime() : 0,
      size: info.size ?? 0,
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -s test src/lib/fs.test.ts`
Expected: PASS — all existing tests + 2 new `statFile` tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fs.ts src/lib/fs.test.ts
git commit -m "feat(fs): add statFile helper for external-change detection"
```

---

## Task 3: Pure state machine — `external-state.ts`

**Files:**
- Create: `src/lib/external-state.ts`
- Create: `src/lib/external-state.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/external-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decide, type ExternalEvent, type TabSnapshot } from './external-state'

const fresh = (overrides: Partial<TabSnapshot> = {}): TabSnapshot => ({
  initialContent: 'A',
  currentContent: 'A',
  lastKnownMtime: 1000,
  lastKnownHash: 'h-A',
  externalState: 'fresh',
  ...overrides,
})

const modifiedEvent = (mtime: number, hash: string, content: string): ExternalEvent =>
  ({ type: 'modified', snapshot: { mtime, hash, content } })

describe('decide', () => {
  it('clean tab + external modify → autoReload', () => {
    const d = decide(fresh(), modifiedEvent(2000, 'h-B', 'B'))
    expect(d).toEqual({ kind: 'autoReload', snapshot: { mtime: 2000, hash: 'h-B', content: 'B' } })
  })

  it('dirty tab + external modify → showChanged', () => {
    const d = decide(fresh({ currentContent: 'A-edited' }), modifiedEvent(2000, 'h-B', 'B'))
    expect(d).toEqual({ kind: 'showChanged', snapshot: { mtime: 2000, hash: 'h-B', content: 'B' } })
  })

  it('matching mtime+hash → ignore (self-write echo)', () => {
    const d = decide(fresh(), modifiedEvent(1000, 'h-A', 'A'))
    expect(d).toEqual({ kind: 'ignore' })
  })

  it('different mtime but identical hash → ignore (touch only)', () => {
    const d = decide(fresh(), modifiedEvent(9999, 'h-A', 'A'))
    expect(d).toEqual({ kind: 'ignore' })
  })

  it('delete event on fresh tab → showDeleted', () => {
    const d = decide(fresh(), { type: 'deleted' })
    expect(d).toEqual({ kind: 'showDeleted' })
  })

  it('delete event on already-deleted tab → ignore', () => {
    const d = decide(fresh({ externalState: 'deleted' }), { type: 'deleted' })
    expect(d).toEqual({ kind: 'ignore' })
  })

  it('modify on already-deleted tab (file was recreated) → showChanged when dirty', () => {
    const d = decide(
      fresh({ externalState: 'deleted', currentContent: 'A-edited' }),
      modifiedEvent(2000, 'h-B', 'B'),
    )
    expect(d).toEqual({ kind: 'showChanged', snapshot: { mtime: 2000, hash: 'h-B', content: 'B' } })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -s test src/lib/external-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the state machine**

Create `src/lib/external-state.ts`:

```ts
/**
 * Pure decision function for external file-change detection.
 *
 * Given the tab's current state and a fresh disk event, returns what the
 * caller should do. Side-effect-free; trivially testable. Lives outside
 * the Svelte runes so we can unit-test without a DOM.
 */

export interface DiskSnapshot {
  /** Last-modification time, ms since epoch. */
  mtime: number
  /** sha256 hex of the disk content. */
  hash: string
  /** The freshly-read content (UTF-8). */
  content: string
}

export type ExternalEvent =
  | { type: 'modified'; snapshot: DiskSnapshot }
  | { type: 'deleted' }

export interface TabSnapshot {
  initialContent: string
  currentContent: string
  lastKnownMtime: number
  lastKnownHash: string
  externalState: 'fresh' | 'changed' | 'deleted'
}

export type Decision =
  | { kind: 'ignore' }
  | { kind: 'autoReload'; snapshot: DiskSnapshot }
  | { kind: 'showChanged'; snapshot: DiskSnapshot }
  | { kind: 'showDeleted' }

export function decide(tab: TabSnapshot, event: ExternalEvent): Decision {
  if (event.type === 'deleted') {
    return tab.externalState === 'deleted' ? { kind: 'ignore' } : { kind: 'showDeleted' }
  }
  // event.type === 'modified'
  const { mtime, hash } = event.snapshot
  // Hash equality alone is enough to ignore: identical content means there's
  // nothing the user could possibly want to know about (covers both "we just
  // saved and it echoed" and "external touch with no content change").
  if (hash === tab.lastKnownHash) return { kind: 'ignore' }
  // mtime equality with hash mismatch is impossible if our recordOurWrite is
  // correct, but treat it as a real change anyway — the hash is authoritative.
  void mtime
  const dirty = tab.currentContent !== tab.initialContent
  return dirty
    ? { kind: 'showChanged', snapshot: event.snapshot }
    : { kind: 'autoReload', snapshot: event.snapshot }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -s test src/lib/external-state.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/external-state.ts src/lib/external-state.test.ts
git commit -m "feat(external-state): pure decision module for file-change events"
```

---

## Task 4: Extend `Tab` interface and initialise on `openFile`

**Files:**
- Modify: `src/lib/tabs.svelte.ts`
- Modify: `src/lib/tabs.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/tabs.test.ts` inside the existing `describe('tabs', …)` block:

```ts
  it('openFile populates externalState/lastKnownMtime/lastKnownHash', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const t = m.tabs[0]
    expect(t.externalState).toBe('fresh')
    expect(t.externalBannerDismissed).toBe(false)
    expect(typeof t.lastKnownMtime).toBe('number')
    expect(t.lastKnownHash).toMatch(/^[0-9a-f]{64}$/)
    expect(t.pendingExternal).toBeUndefined()
  })
```

Update the `vi.mock('./fs', …)` block in `src/lib/tabs.test.ts` to include `statFile`:

```ts
vi.mock('./fs', () => ({
  readMd: vi.fn(async (p: string) => `# content of ${p}`),
  writeMd: vi.fn(async () => {}),
  basename: (p: string) => p.split('/').pop() ?? p,
  classifyPath: (p: string) => {
    const lower = p.toLowerCase()
    if (/\.(md|markdown|mdown|mkd)$/.test(lower)) return { kind: 'markdown' }
    if (/\.html?$/.test(lower)) return { kind: 'html' }
    if (/\.py$/.test(lower)) return { kind: 'code', language: 'python' }
    if (/\.json$/.test(lower)) return { kind: 'code', language: 'json' }
    if (/\.txt$/.test(lower)) return { kind: 'code', language: '' }
    return null
  },
  isSupportedPath: (p: string) => /\.(md|markdown|mdown|mkd|html?|py|json|txt)$/i.test(p),
  looksBinary: (s: string) => s.indexOf('\x00') >= 0,
  modeKeyFor: (p: string) => {
    const base = (p.split('/').pop() ?? p).toLowerCase()
    const dot = base.lastIndexOf('.')
    return dot <= 0 ? base : base.slice(dot + 1)
  },
  statFile: vi.fn(async () => ({ mtime: 1_700_000_000_000, size: 100 })),
}))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s test src/lib/tabs.test.ts -t externalState`
Expected: FAIL — `t.externalState` undefined.

- [ ] **Step 3: Extend the `Tab` interface and update `openFile`**

In `src/lib/tabs.svelte.ts`, change the imports and the `Tab` interface:

```ts
import {
  readMd, writeMd, basename, classifyPath, isSupportedPath, looksBinary,
  modeKeyFor, statFile, type FileKind,
} from './fs'
import { sha256Hex } from './hash'
import { pushRecentFile, getRecentMode, setRecentMode } from './settings.svelte'

export type Mode = 'source' | 'rich'

export interface Tab {
  id: string
  filePath: string
  title: string
  initialContent: string
  currentContent: string
  mode: Mode
  kind: FileKind
  language?: string
  /** External-change state (see external-state.ts). */
  externalState: 'fresh' | 'changed' | 'deleted'
  /** True after the user clicks the banner's × until the next external event. */
  externalBannerDismissed: boolean
  /** mtime (ms) and sha256 of the disk version we last accepted. */
  lastKnownMtime: number
  lastKnownHash: string
  /** Cached new-content snapshot when externalState === 'changed'. */
  pendingExternal?: { mtime: number; hash: string; content: string }
}
```

Update `openFile` to populate the new fields. Replace the body where the tab is constructed:

```ts
export async function openFile(path: string): Promise<void> {
  const cls = classifyPath(path)
  if (!cls) {
    throw new Error(`Unsupported file type: ${path}`)
  }
  const existing = tabs.find((t) => t.filePath === path)
  if (existing) {
    activeId.value = existing.id
    return
  }
  const content = await readMd(path)
  if (looksBinary(content)) {
    throw new Error(`Binary file not supported: ${path}`)
  }
  const mode = getRecentMode(modeKeyFor(path)) ?? defaultModeFor(cls.kind)
  const stat = await statFile(path)
  const hash = await sha256Hex(content)
  const tab: Tab = {
    id: crypto.randomUUID(),
    filePath: path,
    title: basename(path),
    initialContent: content,
    currentContent: content,
    mode,
    kind: cls.kind,
    language: cls.language,
    externalState: 'fresh',
    externalBannerDismissed: false,
    lastKnownMtime: stat?.mtime ?? 0,
    lastKnownHash: hash,
    pendingExternal: undefined,
  }
  tabs.push(tab)
  activeId.value = tab.id
  await pushRecentFile(path)
}
```

- [ ] **Step 4: Run all tabs tests to verify they pass**

Run: `pnpm -s test src/lib/tabs.test.ts`
Expected: PASS — all existing + the new `externalState` test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tabs.svelte.ts src/lib/tabs.test.ts
git commit -m "feat(tabs): extend Tab with external-change tracking fields"
```

---

## Task 5: `recordOurWrite` — wire self-write suppression into save paths

**Files:**
- Modify: `src/lib/tabs.svelte.ts`
- Modify: `src/lib/tabs.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/tabs.test.ts`:

```ts
  it('saveActive updates lastKnownMtime/lastKnownHash to post-write values', async () => {
    const fs = await import('./fs')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      mtime: 9_999_999_999_999, size: 7,
    })
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    m.setContent(id, 'edited')
    await m.saveActive()
    const t = m.tabs.find((x) => x.id === id)!
    expect(t.lastKnownMtime).toBe(9_999_999_999_999)
    expect(t.lastKnownHash).toMatch(/^[0-9a-f]{64}$/)
    // After save, hash must be the hash of "edited"
    const { sha256Hex } = await import('./hash')
    expect(t.lastKnownHash).toBe(await sha256Hex('edited'))
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s test src/lib/tabs.test.ts -t "saveActive updates lastKnownMtime"`
Expected: FAIL — `lastKnownMtime` is still `1_700_000_000_000` (the value from openFile).

- [ ] **Step 3: Update `saveActive` and `saveAs`**

In `src/lib/tabs.svelte.ts`, replace `saveActive`:

```ts
export async function saveActive(): Promise<void> {
  const t = activeTab()
  if (!t) return
  await writeMd(t.filePath, t.currentContent)
  t.initialContent = t.currentContent
  await recordOurWrite(t)
}
```

Replace `saveAs`:

```ts
export async function saveAs(id: string, newPath: string): Promise<void> {
  const t = tabs.find((x) => x.id === id)
  if (!t) return
  await writeMd(newPath, t.currentContent)
  t.filePath = newPath
  t.title = basename(newPath)
  t.initialContent = t.currentContent
  // Re-classify in case user changed extension
  const cls = classifyPath(newPath)
  if (cls) {
    t.kind = cls.kind
    t.language = cls.language
  } else {
    console.warn(`[saveAs] unrecognised extension; retained old kind: ${newPath}`)
  }
  await pushRecentFile(newPath)
  setRecentMode(modeKeyFor(newPath), t.mode).catch((e) => console.warn(e))
  await recordOurWrite(t)
}
```

Add a private helper at the end of the file:

```ts
/**
 * After a write that we initiated, capture the post-write mtime and hash so
 * the imminent watcher echo (or focus-poll re-stat) can be recognised as our
 * own and ignored. Also resets externalState back to 'fresh'.
 */
async function recordOurWrite(t: Tab): Promise<void> {
  const stat = await statFile(t.filePath)
  t.lastKnownMtime = stat?.mtime ?? Date.now()
  t.lastKnownHash = await sha256Hex(t.currentContent)
  t.externalState = 'fresh'
  t.externalBannerDismissed = false
  t.pendingExternal = undefined
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -s test src/lib/tabs.test.ts`
Expected: PASS — including the existing `saveAs` test (which should still work because `recordOurWrite` runs after the existing field updates).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tabs.svelte.ts src/lib/tabs.test.ts
git commit -m "feat(tabs): record post-save mtime+hash to suppress own-write echoes"
```

---

## Task 6: New tab actions — `reloadFromDisk`, `overwriteOnDisk`, `dismissExternalBanner`

**Files:**
- Modify: `src/lib/tabs.svelte.ts`
- Modify: `src/lib/tabs.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/tabs.test.ts`:

```ts
  it('reloadFromDisk replaces buffer with pendingExternal content and clears banner', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const t = m.tabs[0]
    // Simulate banner shown:
    m.setContent(t.id, 'edited')
    t.externalState = 'changed'
    t.pendingExternal = { mtime: 5000, hash: 'h-X', content: 'NEW DISK' }
    await m.reloadFromDisk(t.id)
    expect(t.currentContent).toBe('NEW DISK')
    expect(t.initialContent).toBe('NEW DISK')
    expect(t.externalState).toBe('fresh')
    expect(t.lastKnownMtime).toBe(5000)
    expect(t.lastKnownHash).toBe('h-X')
    expect(t.pendingExternal).toBeUndefined()
  })

  it('overwriteOnDisk writes the local buffer and clears banner', async () => {
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const t = m.tabs[0]
    m.setContent(t.id, 'mine')
    t.externalState = 'changed'
    t.pendingExternal = { mtime: 5000, hash: 'h-X', content: 'theirs' }
    await m.overwriteOnDisk(t.id)
    expect(fs.writeMd).toHaveBeenCalledWith('/tmp/foo.md', 'mine')
    expect(t.externalState).toBe('fresh')
    expect(t.pendingExternal).toBeUndefined()
  })

  it('dismissExternalBanner sets the flag without changing externalState', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const t = m.tabs[0]
    t.externalState = 'changed'
    m.dismissExternalBanner(t.id)
    expect(t.externalBannerDismissed).toBe(true)
    expect(t.externalState).toBe('changed')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -s test src/lib/tabs.test.ts -t reloadFromDisk`
Expected: FAIL — `m.reloadFromDisk` is undefined.

- [ ] **Step 3: Add the three actions**

Append to `src/lib/tabs.svelte.ts`:

```ts
/**
 * Discard local edits and replace the buffer with whatever the watcher last
 * read from disk (`pendingExternal`). Clears banner state.
 *
 * Pre: tab.externalState === 'changed' && tab.pendingExternal != null.
 */
export async function reloadFromDisk(id: string): Promise<void> {
  const t = tabs.find((x) => x.id === id)
  if (!t || !t.pendingExternal) return
  const p = t.pendingExternal
  t.initialContent = p.content
  t.currentContent = p.content
  t.lastKnownMtime = p.mtime
  t.lastKnownHash = p.hash
  t.externalState = 'fresh'
  t.externalBannerDismissed = false
  t.pendingExternal = undefined
}

/**
 * Write the current buffer to disk, accepting the loss of the external
 * change. Clears banner state.
 */
export async function overwriteOnDisk(id: string): Promise<void> {
  const t = tabs.find((x) => x.id === id)
  if (!t) return
  await writeMd(t.filePath, t.currentContent)
  t.initialContent = t.currentContent
  await recordOurWrite(t)
}

/**
 * Hide the banner without resolving the change. State stays non-fresh; the
 * banner reappears on the next external event.
 */
export function dismissExternalBanner(id: string): void {
  const t = tabs.find((x) => x.id === id)
  if (t) t.externalBannerDismissed = true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -s test src/lib/tabs.test.ts`
Expected: PASS — all existing + 3 new.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tabs.svelte.ts src/lib/tabs.test.ts
git commit -m "feat(tabs): banner actions reloadFromDisk / overwriteOnDisk / dismiss"
```

---

## Task 7: `file-watcher.svelte.ts` — verifyAllOpen (pull-mode core)

**Files:**
- Create: `src/lib/file-watcher.svelte.ts`
- Create: `src/lib/file-watcher.test.ts`

> Pull-mode (focus poll) is implemented first because it's testable without a real Tauri runtime; the push-mode subscription is layered on top in the next task.

- [ ] **Step 0: Install happy-dom and pin file-watcher tests to it**

The auto-reload path (Task 13) dispatches a `window.dispatchEvent` call, so
even Task 7's `verifyAllOpen` tests need a DOM. Install once:

```bash
pnpm add -D happy-dom
```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/file-watcher.test.ts` (note the per-file environment directive at top):

```ts
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./fs', () => ({
  readMd: vi.fn(),
  writeMd: vi.fn(),
  basename: (p: string) => p.split('/').pop() ?? p,
  classifyPath: () => ({ kind: 'markdown' }),
  isSupportedPath: () => true,
  looksBinary: () => false,
  modeKeyFor: () => 'md',
  statFile: vi.fn(),
}))

vi.mock('./settings.svelte', () => ({
  pushRecentFile: vi.fn(async () => {}),
  getRecentMode: vi.fn(() => null),
  setRecentMode: vi.fn(async () => {}),
  settings: { autoSave: false },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

describe('verifyAllOpen', () => {
  it('marks a clean tab autoReload when disk content differs', async () => {
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')          // initial open
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })  // open
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('B')          // verify pass
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 2000, size: 1 })  // verify
    const tabs = await import('./tabs.svelte')
    const watcher = await import('./file-watcher.svelte')
    await tabs.openFile('/tmp/foo.md')
    await watcher.verifyAllOpen()
    const t = tabs.tabs[0]
    expect(t.externalState).toBe('fresh')         // clean → auto-reloaded, stays fresh
    expect(t.initialContent).toBe('B')
    expect(t.currentContent).toBe('B')
    expect(t.lastKnownMtime).toBe(2000)
  })

  it('marks a dirty tab as changed when disk content differs', async () => {
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('B')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 2000, size: 1 })
    const tabs = await import('./tabs.svelte')
    const watcher = await import('./file-watcher.svelte')
    await tabs.openFile('/tmp/foo.md')
    tabs.setContent(tabs.tabs[0].id, 'edited')
    await watcher.verifyAllOpen()
    const t = tabs.tabs[0]
    expect(t.externalState).toBe('changed')
    expect(t.pendingExternal?.content).toBe('B')
    expect(t.pendingExternal?.mtime).toBe(2000)
  })

  it('marks a tab as deleted when stat returns null', async () => {
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)        // deleted
    const tabs = await import('./tabs.svelte')
    const watcher = await import('./file-watcher.svelte')
    await tabs.openFile('/tmp/foo.md')
    await watcher.verifyAllOpen()
    expect(tabs.tabs[0].externalState).toBe('deleted')
  })

  it('does nothing when stat returns the same mtime and content (no-op poll)', async () => {
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })
    const tabs = await import('./tabs.svelte')
    const watcher = await import('./file-watcher.svelte')
    await tabs.openFile('/tmp/foo.md')
    await watcher.verifyAllOpen()
    expect(tabs.tabs[0].externalState).toBe('fresh')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -s test src/lib/file-watcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement verifyAllOpen + helpers**

Create `src/lib/file-watcher.svelte.ts`:

```ts
import { tabs, type Tab } from './tabs.svelte'
import { readMd, statFile } from './fs'
import { sha256Hex } from './hash'
import { decide, type ExternalEvent } from './external-state'

/**
 * Visit every open tab, compare its known state to disk, and apply the
 * resulting decision. Called on window-focus and as a fallback when the
 * push-mode watcher misses an event.
 */
export async function verifyAllOpen(): Promise<void> {
  for (const tab of tabs) {
    await checkTab(tab)
  }
}

async function checkTab(tab: Tab): Promise<void> {
  const stat = await statFile(tab.filePath)
  let event: ExternalEvent
  if (!stat) {
    event = { type: 'deleted' }
  } else {
    // Mtime fast path: equal mtime → assume content equal, skip read.
    if (stat.mtime === tab.lastKnownMtime) return
    let content: string
    try {
      content = await readMd(tab.filePath)
    } catch {
      // Read failure between stat and read → treat as deleted.
      applyDecision(tab, { kind: 'showDeleted' })
      return
    }
    const hash = await sha256Hex(content)
    event = { type: 'modified', snapshot: { mtime: stat.mtime, hash, content } }
  }
  const decision = decide(tab, event)
  applyDecision(tab, decision)
}

function applyDecision(
  tab: Tab,
  decision: ReturnType<typeof decide>,
): void {
  switch (decision.kind) {
    case 'ignore':
      return
    case 'autoReload': {
      const s = decision.snapshot
      tab.initialContent = s.content
      tab.currentContent = s.content
      tab.lastKnownMtime = s.mtime
      tab.lastKnownHash = s.hash
      tab.externalState = 'fresh'
      tab.externalBannerDismissed = false
      tab.pendingExternal = undefined
      return
    }
    case 'showChanged': {
      tab.pendingExternal = decision.snapshot
      tab.externalState = 'changed'
      // Reset dismissed flag so a *new* event resurfaces the banner.
      tab.externalBannerDismissed = false
      return
    }
    case 'showDeleted': {
      tab.externalState = 'deleted'
      tab.externalBannerDismissed = false
      tab.pendingExternal = undefined
      return
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -s test src/lib/file-watcher.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/file-watcher.svelte.ts src/lib/file-watcher.test.ts
git commit -m "feat(file-watcher): verifyAllOpen pull-mode poll over open tabs"
```

---

## Task 8: Push-mode — `tauri-plugin-fs` watch lifecycle

**Files:**
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src/lib/file-watcher.svelte.ts`
- Modify: `src/lib/file-watcher.test.ts`
- Modify: `src/lib/tabs.svelte.ts` (call lifecycle hooks from openFile / closeTab / saveAs)

- [ ] **Step 1: Add fs-watch capabilities**

Edit `src-tauri/capabilities/default.json`. After the existing `fs:scope` block (line 32-33), add three new permission entries before the closing `]`:

```json
{
  "identifier": "fs:allow-watch",
  "allow": [{ "path": "**" }]
},
{
  "identifier": "fs:allow-unwatch",
  "allow": [{ "path": "**" }]
},
{
  "identifier": "fs:allow-stat",
  "allow": [{ "path": "**" }]
},
```

The full `permissions` array should now end:

```json
{
  "identifier": "fs:scope",
  "allow": [{ "path": "**" }]
},
{
  "identifier": "fs:allow-watch",
  "allow": [{ "path": "**" }]
},
{
  "identifier": "fs:allow-unwatch",
  "allow": [{ "path": "**" }]
},
{
  "identifier": "fs:allow-stat",
  "allow": [{ "path": "**" }]
},
"opener:default",
"opener:allow-open-path",
...
```

- [ ] **Step 2: Verify tauri's permission schema accepts the change**

Run: `cd src-tauri && cargo check`
Expected: clean compile (cargo runs build.rs which validates capabilities at build time).

- [ ] **Step 3: Add a plugin-fs mock at the top of the test file**

`vi.mock(...)` is hoisted to the top of the file by Vitest, so add this mock alongside the existing `./fs` and `./settings.svelte` mocks at the top of `src/lib/file-watcher.test.ts`:

```ts
vi.mock('@tauri-apps/plugin-fs', () => ({
  watchImmediate: vi.fn(async () => () => {}),
}))
```

- [ ] **Step 4: Write the failing tests for lifecycle hooks**

Append to `src/lib/file-watcher.test.ts` (inside the existing top-level scope, after the `verifyAllOpen` describe block):

```ts
describe('startWatchingTab / stopWatchingTab', () => {
  it('startWatchingTab subscribes via watchImmediate and stop unsubscribes', async () => {
    const unwatch = vi.fn()
    const plug = await import('@tauri-apps/plugin-fs')
    ;(plug.watchImmediate as ReturnType<typeof vi.fn>).mockResolvedValueOnce(unwatch)
    const tabs = await import('./tabs.svelte')
    const watcher = await import('./file-watcher.svelte')
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })
    await tabs.openFile('/tmp/foo.md')
    await watcher.startWatchingTab(tabs.tabs[0])
    expect(plug.watchImmediate).toHaveBeenCalledWith('/tmp/foo.md', expect.any(Function))
    await watcher.stopWatchingTab(tabs.tabs[0].id)
    expect(unwatch).toHaveBeenCalled()
  })

  it('rebindTabPath stops the old subscription and starts a new one', async () => {
    const unwatchOld = vi.fn()
    const unwatchNew = vi.fn()
    const plug = await import('@tauri-apps/plugin-fs')
    ;(plug.watchImmediate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(unwatchOld)
      .mockResolvedValueOnce(unwatchNew)
    const tabs = await import('./tabs.svelte')
    const watcher = await import('./file-watcher.svelte')
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })
    await tabs.openFile('/tmp/foo.md')
    await watcher.startWatchingTab(tabs.tabs[0])
    await watcher.rebindTabPath(tabs.tabs[0].id, '/tmp/bar.md')
    expect(unwatchOld).toHaveBeenCalled()
    expect(plug.watchImmediate).toHaveBeenLastCalledWith('/tmp/bar.md', expect.any(Function))
  })
})
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `pnpm -s test src/lib/file-watcher.test.ts -t startWatchingTab`
Expected: FAIL — these functions are not yet exported.

- [ ] **Step 6: Implement the lifecycle**

Append to `src/lib/file-watcher.svelte.ts`:

```ts
import { watchImmediate } from '@tauri-apps/plugin-fs'

type Unwatch = () => void
const subscriptions = new Map<string /* tab.id */, Unwatch>()

export async function startWatchingTab(tab: Tab): Promise<void> {
  if (subscriptions.has(tab.id)) return
  try {
    const stop = await watchImmediate(tab.filePath, () => {
      // Coalesce: any event triggers a verify pass for this single tab.
      void checkTab(tab)
    })
    subscriptions.set(tab.id, stop)
  } catch (e) {
    // Watcher unavailable on this filesystem (network, sandboxed, etc.) —
    // silently degrade; verifyAllOpen on window-focus is the fallback.
    console.warn('[file-watcher] watch failed for', tab.filePath, e)
  }
}

export async function stopWatchingTab(tabId: string): Promise<void> {
  const stop = subscriptions.get(tabId)
  if (!stop) return
  try { stop() } catch (e) { console.warn('[file-watcher] stop failed:', e) }
  subscriptions.delete(tabId)
}

export async function rebindTabPath(tabId: string, newPath: string): Promise<void> {
  await stopWatchingTab(tabId)
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab) return
  // tab.filePath is updated by saveAs before this is called
  void newPath  // explicit param for callers' clarity; the tab already has the new path
  await startWatchingTab(tab)
}
```

- [ ] **Step 7: Wire lifecycle hooks into `tabs.svelte.ts`**

In `src/lib/tabs.svelte.ts`, import the lifecycle functions:

```ts
import { startWatchingTab, stopWatchingTab, rebindTabPath } from './file-watcher.svelte'
```

(If this creates a cycle — `file-watcher.svelte.ts` imports `tabs.svelte.ts` — the cycle is fine because Svelte/Vite handle ESM cycles, but verify imports use only named exports actually used at module load time. Tabs uses three lifecycle functions; file-watcher uses `tabs` array and `Tab` type. Both lazy through the array reference, no init-time hazard.)

Update `openFile` to start watching after pushing the tab:

```ts
  tabs.push(tab)
  activeId.value = tab.id
  await pushRecentFile(path)
  await startWatchingTab(tab)        // <-- new line, last in the function
}
```

Update `closeTab` to stop watching after splice:

```ts
  tabs.splice(idx, 1)
  await stopWatchingTab(id)          // <-- new line
  if (activeId.value === id) {
    activeId.value = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? null
  }
  return true
}
```

Update `saveAs` to rebind:

```ts
  await pushRecentFile(newPath)
  setRecentMode(modeKeyFor(newPath), t.mode).catch((e) => console.warn(e))
  await recordOurWrite(t)
  await rebindTabPath(id, newPath)   // <-- new line, last
}
```

Mock the new function in `src/lib/tabs.test.ts`'s mock block (so existing tests don't try to call real Tauri):

```ts
vi.mock('./file-watcher.svelte', () => ({
  startWatchingTab: vi.fn(async () => {}),
  stopWatchingTab: vi.fn(async () => {}),
  rebindTabPath: vi.fn(async () => {}),
  verifyAllOpen: vi.fn(async () => {}),
}))
```

- [ ] **Step 8: Run all tests**

Run: `pnpm -s test`
Expected: PASS — all existing + 2 new lifecycle tests.

- [ ] **Step 9: Commit**

```bash
git add src/lib/file-watcher.svelte.ts src/lib/file-watcher.test.ts \
        src/lib/tabs.svelte.ts src/lib/tabs.test.ts \
        src-tauri/capabilities/default.json
git commit -m "feat(file-watcher): tauri fs watch lifecycle wired into tab open/close/saveAs"
```

---

## Task 9: window.focus pull-mode trigger

**Files:**
- Modify: `src/lib/file-watcher.svelte.ts` (export `installFocusPoll` / `uninstallFocusPoll`)
- Modify: `src/lib/file-watcher.test.ts` (one test for the listener wiring)
- Modify: `src/App.svelte` (call install on mount, uninstall on unmount)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/file-watcher.test.ts`:

```ts
describe('installFocusPoll', () => {
  it('attaches a window focus listener that calls verifyAllOpen', async () => {
    const watcher = await import('./file-watcher.svelte')
    const spy = vi.spyOn(watcher, 'verifyAllOpen')
      .mockImplementation(async () => {})
    const uninstall = watcher.installFocusPoll()
    window.dispatchEvent(new Event('focus'))
    expect(spy).toHaveBeenCalledTimes(1)
    uninstall()
    window.dispatchEvent(new Event('focus'))
    expect(spy).toHaveBeenCalledTimes(1)  // not called after uninstall
  })
})
```

(Vitest runs in jsdom by default so `window` exists; if the project's vitest.config doesn't set the environment, set it: `// @vitest-environment jsdom` at the top of the file.)

- [ ] **Step 2: Verify the DOM environment is in place**

The `@vitest-environment happy-dom` directive at the top of
`src/lib/file-watcher.test.ts` was added in Task 7 Step 0. No further action
needed here — `window`/`addEventListener` are available.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -s test src/lib/file-watcher.test.ts -t installFocusPoll`
Expected: FAIL — `installFocusPoll` not exported.

- [ ] **Step 4: Implement install/uninstall**

Append to `src/lib/file-watcher.svelte.ts`:

```ts
/**
 * Attach a window-focus listener that triggers `verifyAllOpen`. Returns an
 * uninstall function. Idempotent: calling install twice is safe (the second
 * call replaces the first).
 */
export function installFocusPoll(): () => void {
  const handler = () => { void verifyAllOpen() }
  window.addEventListener('focus', handler)
  return () => window.removeEventListener('focus', handler)
}
```

- [ ] **Step 5: Wire into `App.svelte`**

In `src/App.svelte`, add an import:

```ts
import { installFocusPoll } from './lib/file-watcher.svelte'
```

Inside the existing `onMount` body (after `loadSettings` block, before the `addEventListener('keydown', …)` call), add:

```ts
    const uninstallFocus = installFocusPoll()
```

Add to the cleanup return:

```ts
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      uninstallFocus()                                  // <-- new
      unlistenClose.then((fn) => fn())
      unlistenMenu.then((fn) => fn())
      unlistenDrop.then((fn) => fn())
      unlistenOpenFile.then((fn) => fn())
      unlistenDeepLink.then((fn) => fn())
      stopAutoSave?.()
    }
```

- [ ] **Step 6: Run tests + frontend check**

Run: `pnpm -s test && pnpm -s check`
Expected: tests PASS; svelte-check 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/file-watcher.svelte.ts src/lib/file-watcher.test.ts \
        src/App.svelte vitest.config.ts package.json pnpm-lock.yaml
git commit -m "feat(file-watcher): window-focus poll trigger"
```

(Omit `package.json` / `pnpm-lock.yaml` from the add list if jsdom was already a dep.)

---

## Task 10: `ExternalChangeBanner.svelte`

**Files:**
- Create: `src/components/ExternalChangeBanner.svelte`

- [ ] **Step 1: Implement the component**

Create `src/components/ExternalChangeBanner.svelte`:

```svelte
<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import {
    reloadFromDisk, overwriteOnDisk, dismissExternalBanner,
    saveActive, closeTab, activate,
  } from '../lib/tabs.svelte'
  import { pickSaveFile, confirmDirtyClose } from '../lib/dialogs'
  import { saveAs } from '../lib/tabs.svelte'

  let { tab }: { tab: Tab } = $props()

  async function onSaveAs() {
    const path = await pickSaveFile(tab.filePath)
    if (path) await saveAs(tab.id, path)
  }

  async function onRecreate() {
    activate(tab.id)
    await saveActive()
  }

  async function onCloseTab() {
    await closeTab(tab.id, confirmDirtyClose)
  }
</script>

{#if !tab.externalBannerDismissed}
  {#if tab.externalState === 'changed'}
    <div class="banner changed" role="status" aria-live="polite">
      <span class="msg">"{tab.title}" was modified by another application.</span>
      <button class="action" onclick={() => reloadFromDisk(tab.id)}>Reload from disk</button>
      <button class="action" onclick={() => overwriteOnDisk(tab.id)}>Overwrite with my changes</button>
      <button class="action" onclick={onSaveAs}>Save as…</button>
      <button class="dismiss" aria-label="Dismiss"
              onclick={() => dismissExternalBanner(tab.id)}>×</button>
    </div>
  {:else if tab.externalState === 'deleted'}
    <div class="banner deleted" role="status" aria-live="polite">
      <span class="msg">"{tab.title}" was deleted on disk.</span>
      <button class="action" onclick={onRecreate}>Recreate on Save (⌘S)</button>
      <button class="action" onclick={onSaveAs}>Save as…</button>
      <button class="action" onclick={onCloseTab}>Close tab</button>
      <button class="dismiss" aria-label="Dismiss"
              onclick={() => dismissExternalBanner(tab.id)}>×</button>
    </div>
  {/if}
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    font-size: 12px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
  }
  .banner.changed {
    background: #fff3cd;
    color: #664d03;
  }
  .banner.deleted {
    background: #fff3cd;
    color: #842029;
    border-left: 3px solid #d33;
  }
  .msg { flex: 1; }
  .action {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    background: rgba(255,255,255,0.5);
    color: inherit;
    cursor: pointer;
    font-size: 11px;
  }
  .action:hover { background: rgba(255,255,255,0.85); }
  .dismiss {
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    font-size: 16px;
    padding: 0 4px;
    opacity: 0.6;
  }
  .dismiss:hover { opacity: 1; }
</style>
```

- [ ] **Step 2: Verify the component compiles**

Run: `pnpm -s check`
Expected: 0 errors. (Banner is not yet rendered anywhere; check just confirms it parses and types resolve.)

- [ ] **Step 3: Commit**

```bash
git add src/components/ExternalChangeBanner.svelte
git commit -m "feat(banner): ExternalChangeBanner component for changed/deleted states"
```

---

## Task 11: Render the banner in `EditorPane.svelte`

**Files:**
- Modify: `src/components/EditorPane.svelte`

- [ ] **Step 1: Read the current EditorPane structure**

Run: `cat src/components/EditorPane.svelte`
Note where the editor content starts so the banner sits above it.

- [ ] **Step 2: Add the banner**

At the top of the `<script>` block, add:

```ts
import ExternalChangeBanner from './ExternalChangeBanner.svelte'
```

In the template, wrap the editor in a vertical stack and put the banner first:

Replace the existing markup (the block that branches on `tab.kind`) with:

```svelte
<div class="editor-stack">
  <ExternalChangeBanner {tab} />
  <!-- existing editor switch unchanged below -->
  {#if tab.kind === 'markdown'}
    <!-- … -->
  {:else if tab.kind === 'html'}
    <!-- … -->
  {:else}
    <!-- … -->
  {/if}
</div>
```

(Preserve the existing branches verbatim — only add the wrapping `<div class="editor-stack">` and the `<ExternalChangeBanner>` line.)

Add to the `<style>` block:

```css
  .editor-stack {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
```

- [ ] **Step 3: Verify type-check**

Run: `pnpm -s check`
Expected: 0 errors.

- [ ] **Step 4: Manual smoke (light)**

Run: `pnpm tauri dev`
- Open any `.md` file.
- Run `echo x >> /path/to/that.md` from a separate terminal.
- Within ~1 s without focusing M↓: nothing visible (clean tab → silent reload happens on watcher event; if it doesn't fire, focus M↓ to trigger the focus poll).
- Focus M↓: file content updates silently.
- Edit something so tab is dirty, then run `echo y >> /path/to/that.md`. Yellow banner with three buttons appears.

- [ ] **Step 5: Commit**

```bash
git add src/components/EditorPane.svelte
git commit -m "feat(editor-pane): render ExternalChangeBanner above editor"
```

---

## Task 12: Auto-save interlock — skip non-fresh tabs

**Files:**
- Modify: `src/lib/autosave.svelte.ts`
- Test: smoke via existing test pattern (no new unit test added; the change is small)

- [ ] **Step 1: Modify the auto-save loop**

In `src/lib/autosave.svelte.ts`, locate the inner loop (line 16-35):

```ts
      for (const tab of tabs) {
        const content = tab.currentContent
        const id = tab.id
        const path = tab.filePath
        const dirty = isDirty(id)
```

Add the externalState skip condition right after the `for (const tab of tabs)` line:

```ts
      for (const tab of tabs) {
        // Auto-save is on hold while the user reconciles an external change;
        // resuming would silently overwrite either the disk or the buffer.
        if (tab.externalState !== 'fresh') {
          const t = timers.get(tab.id)
          if (t) { clearTimeout(t); timers.delete(tab.id) }
          continue
        }
        const content = tab.currentContent
        // … rest unchanged
```

- [ ] **Step 2: Type-check**

Run: `pnpm -s check`
Expected: 0 errors.

- [ ] **Step 3: Manual smoke**

Run: `pnpm tauri dev`
- Enable auto-save in Preferences.
- Open `~/foo.md`, edit it → dirty dot appears, after ~800 ms file is saved (existing behaviour).
- Edit again → wait. Then before 800 ms passes, run `echo X >> ~/foo.md` externally. Yellow banner appears. Wait 5 s with banner shown — file on disk should NOT be overwritten by auto-save (verify with `cat ~/foo.md` showing the external `X`). Click "Reload from disk" to clear banner. Auto-save resumes.

- [ ] **Step 4: Commit**

```bash
git add src/lib/autosave.svelte.ts
git commit -m "feat(autosave): pause for tabs with non-fresh externalState"
```

---

## Task 13: Cursor preservation on clean auto-reload

**Files:**
- Modify: `src/lib/file-watcher.svelte.ts` (compute selection hint before reload)
- Modify: `src/lib/external-state.ts` (extend Decision type with optional cursor hint? — see below)
- Modify: `src/components/EditorPane.svelte` (consume the hint after content swap; source-mode only)
- Create: `src/lib/cursor-preserve.ts` + test

> **Scope note:** rich (WYSIWYG) mode preserves only scroll, not cursor — its DOM is fully re-rendered on content swap and accurate cursor mapping is a separate, larger task. Source mode (textarea) is straightforward.

- [ ] **Step 1: Write the failing test for line/col conversion**

Create `src/lib/cursor-preserve.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { offsetToLineCol, lineColToOffset } from './cursor-preserve'

describe('offsetToLineCol', () => {
  it('start of file', () => {
    expect(offsetToLineCol('abc\ndef', 0)).toEqual({ line: 0, col: 0 })
  })
  it('middle of first line', () => {
    expect(offsetToLineCol('abc\ndef', 2)).toEqual({ line: 0, col: 2 })
  })
  it('start of second line', () => {
    expect(offsetToLineCol('abc\ndef', 4)).toEqual({ line: 1, col: 0 })
  })
  it('past end clamps', () => {
    expect(offsetToLineCol('abc', 999)).toEqual({ line: 0, col: 3 })
  })
})

describe('lineColToOffset', () => {
  it('round-trip with offsetToLineCol', () => {
    const text = 'one\ntwo\nthree'
    for (let off = 0; off <= text.length; off++) {
      const lc = offsetToLineCol(text, off)
      expect(lineColToOffset(text, lc.line, lc.col)).toBe(off)
    }
  })
  it('line beyond eof clamps to last line end', () => {
    expect(lineColToOffset('abc\ndef', 99, 99)).toBe(7)
  })
  it('col beyond line end clamps to line length', () => {
    expect(lineColToOffset('abc\ndef', 0, 99)).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s test src/lib/cursor-preserve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement cursor-preserve helpers**

Create `src/lib/cursor-preserve.ts`:

```ts
/** Convert a UTF-16 character offset into 0-indexed (line, col). */
export function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  const o = Math.min(Math.max(offset, 0), text.length)
  let line = 0
  let lineStart = 0
  for (let i = 0; i < o; i++) {
    if (text.charCodeAt(i) === 0x0a /* \n */) {
      line++
      lineStart = i + 1
    }
  }
  return { line, col: o - lineStart }
}

/**
 * Convert (line, col) back to a UTF-16 offset, clamping if `line` exceeds the
 * total line count or `col` exceeds the matching line's length.
 */
export function lineColToOffset(text: string, line: number, col: number): number {
  const lines = text.split('\n')
  const targetLine = Math.min(Math.max(line, 0), lines.length - 1)
  let offset = 0
  for (let i = 0; i < targetLine; i++) offset += lines[i].length + 1 // +1 for \n
  const colMax = lines[targetLine].length
  return offset + Math.min(Math.max(col, 0), colMax)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -s test src/lib/cursor-preserve.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Wire into auto-reload (source-mode only, best-effort)**

In `src/lib/file-watcher.svelte.ts`, change the `applyDecision` `autoReload` branch to dispatch a CustomEvent the editor pane can listen for:

```ts
    case 'autoReload': {
      const s = decision.snapshot
      const oldContent = tab.initialContent
      tab.initialContent = s.content
      tab.currentContent = s.content
      tab.lastKnownMtime = s.mtime
      tab.lastKnownHash = s.hash
      tab.externalState = 'fresh'
      tab.externalBannerDismissed = false
      tab.pendingExternal = undefined
      // Hint for source-mode editor: try to keep the user near where they were.
      window.dispatchEvent(new CustomEvent('mdeditor:auto-reloaded', {
        detail: { tabId: tab.id, oldContent, newContent: s.content },
      }))
      return
    }
```

In `src/components/EditorPane.svelte` (or in the source-mode subcomponent that owns the textarea), listen for the event and reapply cursor in source mode:

```svelte
<script lang="ts">
  // … existing imports
  import { offsetToLineCol, lineColToOffset } from '../lib/cursor-preserve'
  // … inside onMount or existing setup:
  $effect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { tabId: string; oldContent: string; newContent: string }
        | undefined
      if (!detail || detail.tabId !== tab.id || tab.kind !== 'markdown') return
      // Find the source-mode textarea (markdown source mode)
      const ta = document.querySelector<HTMLTextAreaElement>(
        `[data-tab-id="${tab.id}"] textarea.src-textarea`,
      )
      if (!ta) return
      const lc = offsetToLineCol(detail.oldContent, ta.selectionStart)
      const off = lineColToOffset(detail.newContent, lc.line, lc.col)
      // Wait one tick for the bound textarea value to refresh
      queueMicrotask(() => { ta.selectionStart = ta.selectionEnd = off })
    }
    window.addEventListener('mdeditor:auto-reloaded', handler)
    return () => window.removeEventListener('mdeditor:auto-reloaded', handler)
  })
</script>
```

> The selector relies on a `data-tab-id` attribute and a `.src-textarea` class. If those don't exist in the source-mode pane, add them as part of this task. Inspect the file first; if the selectors don't match, prefer extending the source-mode component to expose its textarea via a shared store rather than DOM querying. (DOM-querying is simpler; only fall back to a store if the source pane isn't unique on the page.)

- [ ] **Step 6: Verify type-check + tests**

Run: `pnpm -s check && pnpm -s test`
Expected: 0 errors, all tests pass.

- [ ] **Step 7: Manual smoke**

Run: `pnpm tauri dev`
- Open `~/notes.md` (clean), put cursor at line 5 col 10.
- External `echo x >> ~/notes.md`. Tab auto-reloads silently. Cursor stays near line 5 col 10 (one line earlier or same line; clamps if file shrunk).

- [ ] **Step 8: Commit**

```bash
git add src/lib/cursor-preserve.ts src/lib/cursor-preserve.test.ts \
        src/lib/file-watcher.svelte.ts src/components/EditorPane.svelte
git commit -m "feat(file-watcher): preserve source-mode cursor on auto-reload"
```

---

## Task 14: README smoke checklist additions

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append items 23-30 to the smoke checklist**

In `README.md`, find the "Manual Smoke Test" section. After item 22, add:

```markdown
23. **External change — clean tab auto-reload**: open `~/foo.md` in M↓ (no edits), run `echo x >> ~/foo.md` from a shell. Within ~1 s (or after focusing M↓) editor content updates silently.
24. **External change — dirty tab banner**: edit `~/foo.md` in M↓ (dirty), run the same external append. Yellow banner appears with three buttons.
25. **Banner — Reload from disk**: clicking it replaces the editor with disk content; banner clears.
26. **Banner — Overwrite with my changes**: clicking it writes the buffer to disk; banner clears; `cat ~/foo.md` shows the buffer content.
27. **External delete**: `rm ~/foo.md` while open. Banner switches to "deleted" variant (red accent).
28. **Recreate on Save**: ⌘S in deleted state writes the buffer to the (now non-existent) path, recreating the file. Banner clears.
29. **Stale banner refresh**: while the changed-banner is showing, modify the file again externally. Banner stays. Clicking Reload pulls the LATEST content (not stale).
30. **Self-write suppression**: Cmd+S inside M↓. Watcher receives the echo. Banner does NOT appear.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): smoke checklist items 23-30 for external-change feature"
```

---

## Final verification

- [ ] **Run the full suite:**

```bash
pnpm -s test
pnpm -s check
cd src-tauri && cargo check --release
```

Expected: tests PASS (≥ 70 total — added at minimum: 3 hash + 2 statFile + 7 external-state + 2 tab fields + 1 saveActive + 3 banner actions + 4 verifyAllOpen + 2 watch lifecycle + 1 focus poll + 6 cursor-preserve = 31 new); 0 type errors; release compiles.

- [ ] **End-to-end smoke (manual):** run items 23-30 from README.

- [ ] **Push and tag:**

```bash
git push origin main
```

(Do NOT call `scripts/release.sh 0.1.1` from this plan — that's a separate decision the user makes after the feature is verified end-to-end.)

---

## Notes for the implementer

- **Cycle between `file-watcher.svelte.ts` and `tabs.svelte.ts`:** ESM cycles are supported; both modules do all imports at module-load and access cross-module references only inside function bodies, so init order doesn't matter.
- **Vitest jsdom:** Task 9 may require adding `jsdom` if it isn't already a dev-dep. Check `package.json` first.
- **Tauri capabilities:** changes to `default.json` only take effect after `cargo check`/`tauri dev` rebuilds the capability schema. Restart `pnpm tauri dev` after Task 8.
- **DOM querying for cursor preservation (Task 13)**: the selector strategy assumes the source-mode textarea exposes `data-tab-id` and a `.src-textarea` class. If the existing pane uses different attributes, adapt the selector or add the attributes when modifying the source pane.
- **Don't over-engineer the banner styling**: the spec accepts the visual treatment described in Task 10; resist the urge to add motion, icons, or polish unless the user requests it after seeing it run.
