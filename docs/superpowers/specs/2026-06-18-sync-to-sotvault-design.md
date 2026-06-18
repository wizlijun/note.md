# Sync to SotVault Plugin — Design

**Date:** 2026-06-18
**Status:** Approved design, pending implementation plan

## Summary

A built-in, toggleable plugin (`sotvault`) that lets the user copy the
currently-open file into the existing git-synced **Vault** directory, tracks the
mapping between each vault copy and its original local file, and — when a tracked
vault copy is reopened — checks whether the original source has changed and
offers to refresh the vault copy. Sync is **one-directional** (source → vault)
and **conflict-aware** (never silently overwrites a vault copy that was also
edited).

"SotVault" = the vault is treated as a snapshot/backup of a *source of truth*
that lives in the user's working directory.

## Goals

- When the plugin is enabled, add a **File menu** entry "Sync to Vault…".
- The entry is enabled only when the current file is saved, the Vault is
  configured, the file is **not** already under the vault root, and the file is
  not already tracked.
- On click: copy the current file into a fixed sub-directory of the vault
  (default `Imported/`), de-duplicating the filename on collision, and record
  the mapping in a dedicated JSON file.
- When the user later opens a tracked vault copy, automatically check whether the
  source changed. If only the source changed, prompt to sync it into the vault.
  If both the source and the vault copy changed, show a conflict dialog and never
  auto-overwrite.

## Non-Goals

- No bidirectional sync (vault copy edits are never pushed back to the source).
- No new vault directory concept — reuse the existing git-synced Vault.
- No iOS support (this is a desktop / `vault_sync` feature; `vault_ios` is out of
  scope).
- No bulk/automatic copying — copying into the vault is always an explicit user
  action.

## Context: existing infrastructure reused

- **Vault root**: the existing `vault_sync` desktop git sync stores the vault
  repository path in `VaultSyncManager.repo_path` (default `~/Documents/Vault`).
  The plugin resolves the vault root from there; if the vault is not configured,
  the menu entry is disabled and sync commands fail gracefully.
- **Plugin gating**: built-in plugins are toggled on/off and gated via
  `plugin_host::is_plugin_enabled("<id>")`, exactly as `openclaw-chat` is. The
  `sotvault` manifest is `kind: "builtin"`, `default_enabled: false`.
- **Sync-record precedent**: the `share` plugin already keeps a per-file record
  map (`settings["share.records"]`) — `sotvault` follows the same idea but with a
  dedicated JSON store rather than plugin settings (records carry sync
  fingerprints and should not be mixed into user settings).
- **Menu dispatch**: plugin menu items are collected from manifests
  (`collectMenuItems`) and dispatched in `App.svelte`'s `dispatchPlugin`, which
  normally spawns an external binary. `sotvault` has **no binary**; dispatch is
  intercepted for `pluginId === 'sotvault'` and routed to Tauri commands.
- **Open hook & fingerprints**: `src/lib/tabs.svelte.ts` `openFile(path)` already
  computes `sha256Hex` and `statFile` (`lastKnownHash` / `lastKnownMtime`). The
  open-time update check hooks in at the end of `openFile`.
- **`enabled_when` evaluation**: rebuilt in `App.svelte`'s `$effect` (~line 537)
  whenever the tab/content/settings change, pushed to the native menu via
  `set_plugin_menu_item_enabled`.

## Architecture / Components

### Rust — new module `src-tauri/src/sotvault/`

- `mod.rs` — Tauri commands + registration:
  - `sotvault_sync_to_vault(app, src_path) -> SyncResult` — copy source into
    `Vault/<subdir>/`, de-duplicate filename, write record.
  - `sotvault_check_update(app, opened_path) -> UpdateCheck` — given a
    just-opened path, if it is a tracked `vault_path`, compare source & vault
    fingerprints and return one of:
    `up_to_date | origin_updated | conflict | source_missing | not_tracked`.
  - `sotvault_apply_update(app, vault_path) -> SyncResult` — overwrite the vault
    copy from the source, refresh the record fingerprints + `synced_at`.
  - `sotvault_records(app) -> Vec<Record>` — list records (for the reactive
    front-end store).
  - `sotvault_forget(app, vault_path)` — remove a record.
- `store.rs` — read/write the dedicated `sotvault-sync.json` in the app data
  directory; corruption-tolerant (back up a corrupt file and start from empty).
- `vault_root.rs` — resolve the vault root from `VaultSyncManager.repo_path`;
  returns `None` when the vault is not configured. Also exposes an
  `is_under_vault(path)` helper (prefix check) used by `canSyncToVault`.
- Register commands + the built-in manifest gating in `lib.rs` (mirroring
  `openclaw-chat`).

### Plugin manifest — `src-tauri/plugins/sotvault/manifest.json`

```jsonc
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

No external binary. The menu item flows through the normal manifest →
`collectMenuItems` → `enabled_when` path; only the click dispatch is intercepted.

### Front-end

- `src/lib/sotvault.svelte.ts` — reactive store + thin wrappers:
  - Caches the vault root + records; exposes derived booleans for the active tab:
    `canSyncToVault` and `isTrackedVaultFile`. Refreshes on tab change and after
    any sync/apply/forget.
  - `syncCurrentToVault()` — calls `sotvault_sync_to_vault`, toasts result.
  - `maybeCheckVaultUpdate(tab)` — calls `sotvault_check_update`; dispatches the
    confirm/conflict dialogs and refreshes the open tab content on apply.
- `src/lib/tabs.svelte.ts` — at the end of `openFile`, call
  `await maybeCheckVaultUpdate(tab)` guarded by `isPluginActive('sotvault')`.
- `src/App.svelte`:
  - `dispatchPlugin`: intercept `pluginId === 'sotvault'` → call
    `syncCurrentToVault()` and return before the `invokePlugin` binary path.
  - `$effect` (~line 537): extend the built `ewTab` with `canSyncToVault` /
    `isTrackedVaultFile` read from the `sotvault` store (read a store tick so the
    effect re-runs when records/vault-root change).
- `src/lib/plugins/types.ts` — extend `EnabledWhenContext.currentTab` with
  optional `canSyncToVault?: boolean` and `isTrackedVaultFile?: boolean`.

## Data Model — `sotvault-sync.json`

Stored in the app data directory.

```jsonc
{
  "version": 1,
  "records": [
    {
      "vault_path": "/Users/bruce/Documents/Vault/Imported/notes.md", // absolute, primary key
      "source_path": "/Users/bruce/work/proj/notes.md",               // absolute source path
      "synced_at": 1718700000,                                         // last sync, epoch seconds
      "source_hash": "<sha256>",  // source content fingerprint at last sync
      "vault_hash":  "<sha256>"   // vault copy fingerprint at last sync (== written content)
    }
  ]
}
```

- Primary key is `vault_path`. A single source may be copied to multiple vault
  locations, but each vault copy maps to exactly one source.
- Both fingerprints are SHA-256 of file content. `mtime` is used only as a cheap
  pre-filter; the hash is authoritative for "did it actually change".

## Flows

### A. Sync to Vault (menu click)

1. Read the active tab's `filePath`. If empty/unsaved → toast "save the file
   first".
2. Resolve the vault root. If not configured → toast "configure the Vault first".
3. Compute target = `<vaultRoot>/<subdir (default "Imported")>/<basename>`. If a
   file already exists there and it is not this source's own record, append
   `-2` / `-3` … until free.
4. Copy the file. Compute `source_hash` (equal to `vault_hash` since the copy is
   identical). Write the record with `synced_at = now`.
5. Toast success.

### B. Open-time check (hook in `openFile`, plugin enabled only)

1. Only proceed if the opened `path` matches some record's `vault_path`;
   otherwise return at zero cost (`not_tracked`).
2. Read the record's `source_path`. If the source no longer exists →
   `source_missing` → toast "source file moved/deleted"; no action.
3. Compute `source_now_hash` and `vault_now_hash` (the just-opened content).
4. Decide:
   - `source_now == record.source_hash` → source unchanged → **silent** (no
     interruption), regardless of vault side.
   - source changed **and** `vault_now == record.vault_hash` (vault side
     untouched) → `origin_updated` → **confirm dialog**: "The source file has
     updates. Sync into the Vault?" On confirm → `apply_update` (source
     overwrites vault, refresh both hashes + `synced_at`) and refresh the open
     tab's content.
   - source changed **and** vault side also changed → `conflict` → **conflict
     dialog**: overwrite from source / keep vault / cancel. Default = cancel
     (never auto-overwrite).

## Error Handling

- Vault not configured → menu disabled; commands return a friendly error → toast.
- Source or vault file missing → toast, no mutation.
- Copy / IO failure → toast with detail, record not written/changed.
- `sotvault-sync.json` corrupt → back up the corrupt file, start from an empty
  store, continue.
- All failures degrade to a toast; never crash the app.

## Testing

- **Rust unit tests** (temp dirs + constructed content/hashes):
  - store read/write + round-trip; corruption recovery.
  - target-path de-duplication (collision → `-2`/`-3`).
  - all `check_update` outcomes: `up_to_date`, `origin_updated`, `conflict`,
    `source_missing`, `not_tracked`.
  - `apply_update` refreshes both fingerprints and `synced_at`.
- **Front-end vitest**:
  - `UpdateCheck` outcome → dialog branch mapping (confirm vs conflict vs
    silent).
  - derived `canSyncToVault` / `isTrackedVaultFile` logic (under-vault detection,
    tracked detection, unsaved/unconfigured cases).
- Desktop / macOS only; `vault_ios` is untouched.

## Open Implementation Notes (for the plan)

- Confirm the built-in manifest loader accepts a `kind: "builtin"` manifest that
  declares `menus` but no `binary` (openclaw-chat's built-in manifest has no
  menus — verify menu contribution flows through `get_plugin_manifests` →
  `collectMenuItems`).
- Decide the sub-directory name default (`Imported/`) and whether to expose it as
  a plugin setting (YAGNI: hard-code `Imported/` for v1).
