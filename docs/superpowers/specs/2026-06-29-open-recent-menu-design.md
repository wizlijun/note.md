# Open Recent Menu (with multi-device git sync)

**Date:** 2026-06-29
**Status:** Approved — ready for implementation plan

## Goal

Surface the file open-history in the native macOS **File** menu as an `Open Recent`
submenu, and make that history **sync across devices** through the existing
git-backed Vault. Latency is acceptable, but the menu must refresh **immediately**
once a git sync brings in changes.

## Background / Current State

The data layer already exists and is reused as-is:

- `src/lib/settings.svelte.ts`: `recentFiles: string[]` (capped at 10), persisted in
  the tauri-plugin-store `settings.json`. `getRecentFiles()`, `pushRecentFile(path)`.
- `openFile()` (`src/lib/tabs.svelte.ts`) and `saveAs` call `pushRecentFile`.
- `DrawerNav.svelte` already shows recents in the mobile/hamburger drawer.

What is missing:

1. No `Open Recent` entry in the native File menu (built once at startup in
   `src-tauri/src/lib.rs::build_menu`).
2. Recents are device-local; nothing syncs across machines.

Existing Vault sync infra that this feature rides on:

- `src-tauri/src/vault_sync/` — a git-backed "Vault" with a recursive file watcher
  (ignores only `.git`, 2s poll debounce) and a `do_sync` loop (watcher-triggered +
  every 30s). `git_ops::sync` does fetch → rebase → `add -A` → commit → push.
- Conflict strategy (`conflict.rs`): on a real merge conflict it takes **theirs** and
  copies the loser aside as `*.conflict.<ts>`. This is **lossy** for a frequently
  written shared file — which is why we use **one file per device** (never conflicts).

## Design Decisions (resolved during brainstorming)

1. **Native submenu kept live** — frontend pushes the current list to Rust on startup
   and after every recents change; the menu always reflects the latest history.
2. **Sync scope** — Vault-internal files sync as **Vault-relative** paths (portable,
   resolved against each device's local Vault root); Vault-external files also sync as
   **absolute** paths (best-effort; may not open on another device).
3. **Per-device file** — each device writes only its own file, so git never conflicts.
4. **Auto-remove on open failure** + a local **tombstone** set to prevent resurrection.
5. **Full path shown in the label** (native menu items have no tooltip): label is
   `filename — ~/parent/dir`.
6. **No extra debounce** beyond the watcher's existing 2s (commit noise accepted).
7. **No stale-device cleanup** (YAGNI for v1).

## Data Storage

### Per-device synced file

Path: `<vaultRoot>/.mdeditor/recents/<deviceId>.json`

```jsonc
{
  "deviceId": "uuid-v4",
  "deviceName": "Bruce-MacBook",        // human-readable, best-effort (os hostname)
  "entries": [
    { "rel": "notes/report.md",       "lastOpened": 1700000000000 }, // Vault-internal
    { "abs": "/Users/bruce/x/foo.md", "lastOpened": 1699999999000 }  // Vault-external
  ]
}
```

- Each entry has exactly one of `rel` / `abs`.
- `deviceId` generated once on first launch, stored locally under settings key
  `device.id`. `deviceName` from the os hostname when available, else
  `Device <short-id>`.
- Capped per device (e.g. 20 entries) before writing.

### Local (this device, in tauri-store `settings.json`)

- `recentFiles: string[]` — **unchanged** (order = recency, source for the menu).
- `recentOpenedAt: Record<string, number>` — **new** sidecar map of absolute path →
  last-opened ms. Written in `pushRecentFile`. Used to (a) write real timestamps into
  the synced file and (b) merge by recency across devices.
- `recentTombstones: string[]` — **new**, not synced. Absolute paths the user tried to
  open and failed; filters them out of the merged result. Capped.

## Flows

### Write flow (this device opens a file → other devices learn)

`pushRecentFile` / `removeRecentFile`, when a Vault is configured:
1. Update local `recentFiles` + `recentOpenedAt` (existing + sidecar).
2. Rewrite this device's `<deviceId>.json`: classify each recent path as Vault-internal
   (store `rel` = path relative to Vault root) or Vault-external (store `abs`), with its
   `lastOpened`.
3. The file lands inside the watched Vault → existing watcher (2s debounce) →
   `do_sync` commits + pushes. **No new git code.**

When no Vault is configured: local-only behaviour (current), no synced file written.

### Read / merge flow (other devices' history → this menu)

Pure, unit-testable merge function:
1. Seed from local `recentFiles` with timestamps from `recentOpenedAt` (fallback:
   synthetic descending by order).
2. Read every **other** device file under `.mdeditor/recents/`. Resolve each entry:
   `rel` → `join(localVaultRoot, rel)`; `abs` → as-is. Attach `lastOpened`.
3. Union by resolved absolute path; keep the max `lastOpened`; drop tombstoned paths;
   sort by `lastOpened` desc; cap at 10.
4. Update in-memory recents → refresh native menu (and the iOS DrawerNav benefits too).

### "Refresh menu immediately after git sync"

In `vault_sync/service.rs::do_sync`, after a successful sync, check whether the sync
touched `.mdeditor/recents/` (e.g. `git diff --name-only <old HEAD>..<new HEAD>`).
If so, `app.emit("editor://recents-synced")`. The frontend listens, re-runs the merge,
and refreshes the menu.

## Native Menu Presentation

- `build_menu` (`src-tauri/src/lib.rs`): insert an `Open Recent` `Submenu` in the File
  menu directly under `Open…`.
- Store the submenu handle in a new managed state (mirroring `TrayRepoItem`), e.g.
  `RecentMenu(Mutex<Option<Submenu<Wry>>>)`.
- New Tauri command `update_recent_menu(items: Vec<RecentMenuItem>)` (label + index):
  clears and rebuilds the submenu. Each item id is `open-recent:<index>`. Empty list →
  a single disabled `No Recent Files` item.
- Item click flows through the existing `menu-event` emit. `App.svelte`'s `menu-event`
  listener adds a branch: id starting with `open-recent:` → `openFile(recents[i])`;
  on failure → `removeRecentFile(path)` (adds tombstone) + `showError` + re-sync menu.
- Label format (no tooltip support): `filename — ~/parent/dir` (home-abbreviated). The
  label is built in the frontend; Rust only renders.

## Platform Notes

- Merge + read/write logic is platform-agnostic. Only "push to native menu" is
  macOS-only. iOS has no menu bar but has `vault_ios` sync; `DrawerNav` reads
  `getRecentFiles()`, so it shows the merged history automatically.

## Error Handling

- Open failure on a recent → auto-remove from local recents + tombstone + toast +
  refresh menu.
- Missing/corrupt device JSON files are skipped during merge (best-effort read).
- No Vault configured → synced layer is inert; pure local behaviour.

## Testing

- **Pure merge function**: dedup, rel/abs resolution against Vault root, recency sort,
  tombstone filtering, 10-cap.
- `removeRecentFile` + tombstone behaviour.
- Label formatting (`filename — ~/dir`, home abbreviation).
- Per-device file (de)serialization + per-device cap.
- Rust menu rebuild + `editor://recents-synced` emit: **manual verification** (two
  clones / two devices: open files on A, confirm they appear in B's File menu after a
  sync; delete a file and confirm click auto-removes it).

## Out of Scope (v1)

- Reducing commit frequency beyond the existing 2s watcher debounce.
- Cleaning up stale per-device files.
- Syncing the per-entry edit mode or other tab metadata.
