# External File Change Detection — Design

**Status**: Brainstorm complete; pending implementation plan
**Date**: 2026-05-08
**Owner**: bruce@hemory.com

## Goal

Detect when an open tab's underlying file is modified or deleted by another
application. Surface the situation to the user without silently destroying
either side: silently auto-reload clean tabs (no in-memory edits to lose), and
for dirty tabs show a yellow banner above the editor offering three explicit
resolution actions.

## Behaviour

### Modified externally

- **Clean tab** (`currentContent === initialContent`): silently reload from
  disk; preserve cursor line/column where possible. No banner.
- **Dirty tab**: enters `externalState = 'changed'`; an `ExternalChangeBanner`
  renders above the editor with three actions plus a dismiss control:
  - **Reload from disk** — discard local edits, replace buffer with disk
    content. Banner clears.
  - **Overwrite with my changes** — write buffer to disk, accepting the loss
    of external changes. Banner clears.
  - **Save as…** — write buffer to a new path; original file's external
    version remains untouched. Tab rebinds to new path; banner clears.
  - **× dismiss** — hide banner until the next external event (informational
    acknowledgment, no state mutation).

### Deleted externally

Tab enters `externalState = 'deleted'`; banner shows the same yellow body with
a red accent stripe. Buttons:

- **Recreate on Save (⌘S)** — pressing Save writes the buffer to the (now
  non-existent) path, recreating the file. Banner clears.
- **Save as…** — same as above but to a new path.
- **Close tab** — drops the tab; goes through the normal dirty-close
  confirmation if dirty.

## Detection Mechanism

Hybrid push + pull:

- **Push** — `tauri-plugin-fs` `watchImmediate` registered per open tab,
  watching the tab's full path. Underlying macOS uses FSEvents.
- **Pull (fallback)** — a `window.focus` event triggers a stat-and-compare
  pass over all open tabs. Catches edges that the watcher misses (some
  network filesystems, atomic-rename edge cases) and gives the user a
  guaranteed verification when they switch focus to M↓.

Watcher startup failure (e.g., unsupported filesystem) silently degrades to
pure focus-poll.

## State Model

Extend `Tab` (`src/lib/tabs.svelte.ts`):

```ts
externalState: 'fresh' | 'changed' | 'deleted'
externalBannerDismissed: boolean   // user clicked ×; banner hidden until next event
lastKnownMtime: number             // mtime we last accepted as canonical
lastKnownHash: string              // sha256 of disk content matching lastKnownMtime
pendingExternal?: {                // populated when externalState === 'changed'
  mtime: number
  hash: string
  content: string                  // already-read new content, ready for reload
}
```

The banner renders iff `externalState !== 'fresh' && !externalBannerDismissed`.

`externalBannerDismissed` is cleared whenever:
- `externalState` returns to `fresh` (any successful resolution); or
- A *new* external event arrives while `externalState` is already non-fresh
  (so the user always sees the latest disturbance).

State transitions:

```
                save / saveAs / reload completed
                clean auto-reload completed
                          ↓
   fresh ←──────────────────────────────────────────┐
     │                                              │
     │ external change detected                     │
     ↓                                              │
  tab dirty?                                        │
     ├── yes → changed ──── Reload ─────────────────┤
     │              ──── Overwrite ─────────────────┤
     │              ──── Save As (new path) ────────┤
     │              ──── × dismiss (state stays changed; banner hidden)
     └── no  → silent reload → fresh

   external delete detected
     │
     ↓
  deleted ──── Recreate on Save ────────────────────┘
          ──── Save As (new path) ──────────────────┘
          ──── Close tab → tab gone
```

## Architecture

Three new code assets, minimal touch to existing files.

### `src/lib/file-watcher.svelte.ts` (new)

Watcher manager. Public API:

```ts
startWatchingTab(tab: Tab): Promise<void>
stopWatchingTab(tabId: string): Promise<void>
rebindTabPath(tabId: string, newPath: string): Promise<void>
recordOurWrite(tab: Tab, mtime: number, hash: string): void
verifyAllOpen(): Promise<void>           // window-focus poll
```

Internals:

- One `Map<tabId, UnwatchFn>` keyed by tab id.
- One `window.addEventListener('focus', verifyAllOpen)` registered at module init.

### `src/components/ExternalChangeBanner.svelte` (new)

Render-only component, props `{ tab: Tab }`. Branches on `tab.externalState`:

```svelte
{#if tab.externalState === 'changed'}
  <div class="banner changed">
    <span class="msg">"{tab.title}" was modified by another application.</span>
    <button onclick={onReload}>Reload from disk</button>
    <button onclick={onOverwrite}>Overwrite with my changes</button>
    <button onclick={onSaveAs}>Save as…</button>
    <button class="dismiss" onclick={onDismiss}>×</button>
  </div>
{:else if tab.externalState === 'deleted'}
  <div class="banner deleted">
    <span class="msg">"{tab.title}" was deleted on disk.</span>
    <button onclick={onRecreate}>Recreate on Save (⌘S)</button>
    <button onclick={onSaveAs}>Save as…</button>
    <button onclick={onCloseTab}>Close tab</button>
  </div>
{/if}
```

Buttons dispatch to `tabs.svelte.ts` actions; the banner itself owns no state.

### `src/components/EditorPane.svelte` (modified)

Adds `<ExternalChangeBanner {tab} />` above the editor switch (`{#if tab.kind === 'markdown' …}`).
The banner reserves zero height when `externalState === 'fresh'`.

### `src/lib/tabs.svelte.ts` (modified)

- Extend `Tab` with the four new fields above.
- `openFile`: compute initial mtime/hash, call `startWatchingTab`.
- `closeTab`: call `stopWatchingTab` after splice.
- `saveActive` / `saveAs`: after the write returns, recompute the post-write
  mtime/hash and call `recordOurWrite` to suppress the imminent watcher echo;
  for `saveAs`, also call `rebindTabPath`.
- New action exports for the banner buttons:
  `reloadFromDisk(id)`, `overwriteOnDisk(id)`, `dismissExternalBanner(id)`.
  "Recreate on Save" and "Close tab" reuse the existing `saveActive` and
  `closeTab` flows — no new action required.

## Self-Write Suppression

When we save, we know the post-write content. Immediately after the disk write
returns:

1. `stat(path)` to get the post-write mtime.
2. Hash the buffer (already in memory).
3. Call `recordOurWrite(tab, mtime, hash)` to update `lastKnownMtime/Hash`.

The next watcher event for this path:

1. `stat` returns `mtime_W`; read content; compute `hash_W`.
2. Compare against `lastKnownMtime/Hash`.
3. If `mtime_W === lastKnownMtime && hash_W === lastKnownHash` → ignore (this
   was our own write echoing back).
4. Otherwise → continue with state machine.

mtime equality is the fast path; hash comparison is the safety net.

## Auto-Save Interlock

Auto-save watcher (`src/lib/autosave.svelte.ts`) skips any tab whose
`externalState !== 'fresh'`. Keeps autosave from silently overwriting the
external change while the user is deciding via the banner. State returns to
`fresh` once any banner action completes; autosave resumes naturally.

## Edge Cases Covered

| Scenario | Handled By |
|---|---|
| Atomic-rename writes (temp + rename) | Watcher emits remove+create or rename; the unified "stat-and-compare" path handles both. `verifyAllOpen` is also a safety net. |
| File temporarily missing then recreated | First event triggers `markDeleted`; second event triggers re-stat → falls back to changed/fresh. |
| Multiple external writes while banner is up | `pendingExternal` is overwritten; banner stays mounted (no flicker). |
| Hash on big files | Two-stage compare: mtime+size first; hash only if first stage disagrees. |
| Watcher startup failure | Silent fallback to `window.focus` poll. |
| Cursor preservation on auto-reload (clean) | Convert pre-reload selection to (line, col); reapply post-reload; clamp to end if line/col exceeds new bounds. Rich-mode preserves scroll only — not cursor. |
| User explicitly closes a `deleted` tab | Goes through the normal dirty-close confirmation if dirty. The on-disk file stays gone. |

## Out of Scope (YAGNI)

- Diff view ("show me what changed") — punt to a follow-up.
- Versioned snapshots / Time Machine integration.
- Multi-user collaboration / CRDTs.
- Foreground vs. background tab differentiation — every open tab responds
  immediately, regardless of whether it's the active tab.

## Testing

### Unit (`vitest`)

- `compareAndDispatch` state machine: at least one test per transition —
  fresh→changed, fresh→deleted, changed→fresh after reload,
  changed→fresh after overwrite, self-write suppression, `pendingExternal`
  accumulation, watcher-startup-failure → focus-poll-only path.
- Dismiss / re-show: dismiss flips `externalBannerDismissed`; a subsequent
  external event clears it so the banner resurfaces.
- `recordOurWrite` suppression: simulate "we save → watcher echoes" → no
  state change.
- Hash short-circuit: same content but mtime bumped (`touch`) → no state
  change.
- Cursor preservation: line/col conversion with clamp edge cases.

### Integration (Tauri command layer)

- Mock the Tauri fs-watch event stream; verify `startWatchingTab`
  registration/release lifecycle and that `recordOurWrite` correctly
  suppresses the next echo.

### Manual smoke (extends README checklist)

| # | Step |
|---|---|
| 23 | Open `~/foo.md` in M↓ (clean). Run `echo x >> ~/foo.md` in shell. Editor updates silently within ~1 s. |
| 24 | Edit `~/foo.md` in M↓ (now dirty). Run the same external append. Yellow banner appears with three buttons. |
| 25 | Click **Reload from disk**: editor replaced with disk content; banner gone. |
| 26 | Click **Overwrite with my changes**: disk now matches buffer; banner gone. |
| 27 | `rm ~/foo.md`. Editor enters deleted-state banner (yellow with red accent). |
| 28 | Press ⌘S in deleted state: file recreated on disk; banner gone. |
| 29 | While banner is showing, modify the file again externally. Banner stays. Click Reload — get the LATEST disk content (not stale). |
| 30 | Save in M↓ (Cmd+S). Watcher receives the echo. Banner does NOT appear (self-write suppression). |

## Open Questions

None at this time.
