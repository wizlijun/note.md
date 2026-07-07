# Folder View — Design

**Date:** 2026-07-07
**Status:** Approved (design), pending implementation plan

## Summary

Add a **Folder View**: a persistent left-hand tree file browser for the desktop
app. When enabled, it shows the folder/file tree rooted at the currently open
markdown file's directory, highlights the active file, lets the user expand
subfolders and navigate to the parent directory, and opens any clicked file in
the main view. Toggled from the **View** menu; visibility and width persist
across sessions.

## Positioning

This is a **built-in desktop feature**, not a binary command plugin. The
existing plugin system (`src/lib/plugins/`, `src-tauri/src/plugin_host.rs`)
invokes external binaries that return one-shot actions (toast, clipboard,
settings merge). It has no mechanism for a persistent UI panel, so Folder View
is implemented directly in the Svelte frontend plus a native menu toggle.

Desktop only. iOS already has a slide-out `DrawerNav`; this feature does not
touch the iOS path.

## Layout & Components

- In `src/App.svelte`, inside `section.pane` (a flex row), render
  `<FolderView>` to the **left** of `<EditorPane>`. Gated on
  `platformName !== 'ios'` **and** `folderView.visible`.
- The sidebar has a draggable splitter on its right edge to resize width
  (default ~240px, min 160, max 480). Width persists.
- New files:
  - `src/components/FolderView.svelte` — sidebar container: header (current root
    folder name + `↑ parent` button + refresh button) and a scrollable tree
    below.
  - `src/components/FolderTreeNode.svelte` — recursive tree node (Svelte 5
    self-reference); renders a folder or file row. Folders expand/collapse.
  - `src/lib/folder-view.svelte.ts` — reactive state module + logic.

## State Model (`folder-view.svelte.ts`)

```ts
folderView = $state({
  visible: boolean,          // persisted
  width: number,             // persisted
  rootDir: string | null,    // current tree root (absolute dir path)
  expanded: Set<string>,     // expanded folder paths
  entriesCache: Map<string, Entry[]>, // dir path -> read entries
})

interface Entry {
  name: string
  path: string
  isDir: boolean
  kind: FileKind | null      // from fs.ts classifyFile; null = not openable
}
```

## Data & Navigation

- Directory reads use `readDir` from `@tauri-apps/plugin-fs` (full FS scope
  already granted in `capabilities/default.json`).
- **Contents:** show folders **and all files**. Files the editor supports open
  normally; unsupported types still show (opening them shows the editor's
  existing "unsupported" feedback). Sort: **folders first, then by name,
  case-insensitive**. Dotfiles hidden by default.
- **Root = current md's directory, with upward navigation:**
  - When the active tab's file changes: if that file is **not within the current
    root's subtree**, reset `rootDir` to the file's parent directory and
    highlight it. If it **is** within the subtree (e.g. inside an expanded
    subfolder), keep the root and just update the highlight. This is the
    VS Code "reveal in explorer" behavior — it avoids resetting the root on
    every click.
  - `↑ parent` button: `rootDir = parent(rootDir)`.
  - Click a folder row: expand/collapse (lazy read; tracked in `expanded`).
  - Click a file row: `openFile(path)` — opens/switches in the main view. The
    active file is highlighted.
- **Refresh:** re-read on becoming visible, on active-file change, and when a
  folder is expanded. A manual refresh button re-reads the visible tree. v1 does
  **not** do live FS watching (kept lightweight).

## View Menu Toggle

- In `src-tauri/src/lib.rs`, add a **CheckMenuItem** `toggle-folder-view` to the
  View submenu: label "Folder View", accelerator `Cmd+Shift+E` (matches VS Code;
  no current conflict). Its checked state reflects `folderView.visible`.
- Add a Rust command `set_menu_item_checked` (reuse the existing menu `walk`
  pattern used by `set_plugin_menu_item_enabled`) to sync the checkmark when the
  state flips from the frontend.
- In `App.svelte`'s `menu-event` listener, add `case 'toggle-folder-view'` →
  flip `folderView.visible`, persist, and sync the menu checkmark.

## Persistence

- Reuse the `settings.json` Store. Add a `folderView` key holding
  `{ visible, width }`, following the existing `theme` / `mdblock` load/save
  pattern in `src/lib/settings.svelte.ts`. Read on startup; write back when
  `visible` or `width` changes. Default: hidden, width 240.

## UI Style

- Reuse existing color variables (`--drawer-bg`, etc.) and hover rules. Row
  height / font align with `DrawerNav`. Folders/files use a small disclosure
  triangle plus lightweight icons (📁 / 📄 or plain text) — restrained, matching
  the current UI.

## Testing

- Unit tests (vitest) for `folder-view.svelte.ts` pure logic: sort ordering,
  "is file within root subtree" check, root-reset logic, `expanded` add/remove.
  `readDir` mocked (the repo already mocks it in `recent-sync.test.ts`).

## Out of Scope (YAGNI, v1)

- Live file-system watching / auto-refresh on external changes.
- Drag-to-move files, right-click new/rename/delete context menu.
- Multi-root workspaces.
- A toggle to show/hide dotfiles.
