# M↓ (mdeditor)

[English](README.md) · [简体中文](README.zh-CN.md)

A minimal text editor for macOS — Markdown, HTML, and source code, with both
**source** and **rich** (WYSIWYG) modes, a tabbed window, a folder-tree sidebar,
and a persistent menu-bar tray. The whole interface — including the native macOS
menu bar and tray — speaks **English, 简体中文, and 日本語**.

The product name is **M↓** (an *M* with a downward arrow, hinting at *markdown*);
the underlying repo, crate, and bundle identifier remain `mdeditor` /
`com.laobu.mdeditor`.

Built with [Tauri](https://tauri.app) on
[`@moraya/core`](https://www.npmjs.com/package/@moraya/core): a code-signed,
notarized native `.app` — a native Rust binary with native menus, window, and
menu-bar tray — whose editor UI is web technology (HTML/CSS/JS) rendered in the
macOS system WebView (WebKit / WKWebView). There's no bundled browser, unlike
Electron. So it's a *native macOS app powered by the system WebView*, not a
native-UI (AppKit/SwiftUI) app.

## Features

- **New file** (`Cmd+N`) — creates an untitled markdown with a random creative
  writing prompt; inherits the current tab's mode (source or rich); body text
  is pre-selected so you can start typing immediately. Double-click the empty
  state to create a new file as well.
- **Find & Replace** (`Cmd+F` / `Cmd+H`) — inline search bar below the tab
  strip with case-sensitive, whole-word, and regex options; match highlighting
  and navigation in both source and rich modes; Enter in the replace field
  executes replace-and-advance. Also accessible from Edit menu.
- **Zoom** (`Cmd+=` / `Cmd+-` / `Cmd+0`) — scale the entire UI up or down;
  reset to default with Cmd+0. Available in the Window menu.
- **Notification bar** — all messages (errors, success, info) now appear in a
  Typora-style bar below the tab strip instead of native OS dialogs; includes
  an optional auto-dismiss checkbox.
- **Trilingual UI (i18n)** — the entire interface ships in **English, Simplified
  Chinese (简体中文), and Japanese (日本語)**, switchable live in **Preferences →
  Core → Language** (default English; no restart). Coverage is complete: every
  component and dialog, the **native macOS menu bar**, the standard system items
  (Undo / Copy / Paste / Quit / Services …, localized via text overrides so they
  follow the in-app language rather than the OS language), the **menu-bar tray**
  dropdown, and each plugin's menu / settings / name-and-description labels.
  Strings run through a lightweight in-house layer (`t()` over a flat-keyed,
  type-checked English base catalog with per-key fallback); the Chinese and
  Japanese packs are complete and enforced at compile time. Adding a language is
  dropping in one catalog object — no code changes.
- **Folder View** — a resizable left sidebar showing the current file's directory
  as a live tree; click to open files, expand folders, and it auto-refreshes as
  files change on disk. A **Find** button filters the tree by a case-insensitive
  **regex**, searching recursively into every subfolder and revealing matches
  along with their parent folders. Right-click any node → **Reveal in Finder**.
  Toggle it from the **View** menu.
- **Tabs** with dirty indicator, drag-to-reorder, and confirm-on-close
- **Source / rich toggle** (`Cmd+/`) — textarea ↔ WYSIWYG
- **Markdown rendering** with KaTeX math, Mermaid diagrams, and highlight.js code
- **Skins** for rich mode (Preferences → Core): GitHub-style **default**;
  and **effie**, an Effie-inspired mint-paper aesthetic in
  LXGW WenKai (霞鹜文楷) with paired light + dark palettes — the kai-style
  webfont streams on demand from jsDelivr only when the skin is selected, then
  is cached by the system webview
- **HTML files** open in a sandboxed iframe preview by default
- **Code files** (~36 plain-text extensions, plus exact matches like `Dockerfile`)
  render as syntax-highlighted code blocks in rich mode
- **Image files** (jpg / jpeg / png / gif / webp / svg / bmp / heic / heif / avif)
  open as preview-only tabs (rich mode shows the image; no source view).
  `Cmd+Shift+L` uploads them to Cloudflare R2 and copies the public URL.
- **Finder integration** — double-click a `.md` / `.html` file to open it; drag
  files onto the window or Dock icon
- **Menu-bar tray** — persistent M↓ icon stays in the menu bar; click to bring
  the window forward
- **Auto-save** (opt-in via Preferences) and **Recent files** persisted to
  `~/Library/Application Support/com.laobu.mdeditor/settings.json`
- **PDF export** (`Cmd+Shift+E`) — typographically-clean A4 PDF of the current
  Markdown / HTML tab, with KaTeX, Mermaid, and syntax-highlighted code rendered
  inline (offscreen WKWebView; macOS-native, no headless Chromium)
- **Plugin system** — out-of-process plugins via stdin/stdout JSON, declarative
  manifests for menu items, context menus, settings panels, and capability-gated
  host actions (toast / clipboard / settings.merge / dialog). Plugins stay
  dormant until invoked; startup cost is bounded to one tiny manifest read each
- **Share plugin (built-in)** — `Cmd+Shift+L` to publish the current file as a
  self-contained web page on your own Cloudflare Worker. Recipients open the
  URL and see the document rendered exactly as M↓ shows it (KaTeX, Mermaid /
  Graphviz SVG, syntax highlighting, light + dark themes via
  `prefers-color-scheme`, mobile-optimized viewport). Image-heavy documents
  spill to Cloudflare R2; the Worker also exposes an MCP endpoint so LLM
  agents can publish on your behalf
- **Sync to Vault plugin (built-in)** — enable in **Preferences → Plugins** to
  add a **File → Sync to Vault…** action that copies the current file into your
  git-synced Vault (`~/Documents/Vault/Sync/`, de-duplicating on name collision)
  and records the copy ↔ source mapping in a dedicated JSON. Markdown filenames
  without a `yyyy-MM-dd-` prefix get the source file's creation date prepended
  (e.g. `notes.md` → `2024-03-12-notes.md`). Reopening a vault copy whose source
  changed prompts a conflict-aware refresh (overwrite from source / keep vault /
  cancel — never silent; when both sides changed it's flagged as a conflict). A
  blue banner on a vault copy shows its source path and reveals it in Finder; a
  green banner on any out-of-vault file offers a one-click sync and explains the
  benefit, hiding itself once the file is already synced
- **Block IDs (mdblock)** — Settings → Block → enable to assign each top-level
  Markdown unit (paragraph, heading, code block, list, table, …) a stable
  `b-xxxxxx` id. Cite a specific block from anywhere via
  `((path/to/file.md#b-xxxxxx))` so agents and humans can quote passages with
  sub-page granularity. Boundaries auto-load when a `.md` opens, recompute
  live (~250 ms debounce) as you type in either source or rich mode, and
  persist on `Cmd+S`. The yaml lives in a centralized path-hashed cache
  (`~/Library/Application Support/com.laobu.mdeditor/blocks/<hash>.yaml`),
  never sibling-of-source — working trees stay clean. Identity is
  edit-resilient via content MinHash + a five-pass merge: light edits keep
  ids, heavy rewrites retire them with full history. Click a marker in the
  gutter to copy `((file#blockid))`; `Cmd+Enter` on a citation in source
  mode opens the target doc at that block.
- **Paste images & attachments** — screenshots (clipboard image blobs) are saved to
  `{docname}_files/` beside the document and inserted as `![](relative/path.png)`;
  untitled documents use a per-session temp directory and the paths are migrated
  automatically on first save. Drag-drop image files insert an absolute-path
  reference without copying. Pasting non-image binary files inserts an attachment
  link `[filename](path)`. Both source and rich modes support all paste paths.
- **Attachment link cards** — links to documents (`.pdf`, `.docx`, `.zip`, …),
  audio, and video files render as styled chips (inline) or full-width cards
  (standalone line) in rich mode, with per-category emoji icons. Pure CSS —
  no schema changes.
- **Video link cards** — paste a YouTube or Bilibili URL; the title is fetched
  from the YouTube oEmbed API (no key required) or the Bilibili Web API, and the
  link is inserted as `[Video Title](url)`. In rich mode the link renders as a
  branded card with a coloured ▶ icon (red for YouTube, blue for Bilibili);
  single-clicking opens the video in the default browser.
- **Image resize toolbar** — click any image in rich mode to show a floating
  25 % / 50 % / 75 % / 100 % / Original toolbar above it. The selected width is
  stored in the `title` attribute (`![alt](src "width=50%")`), which the editor
  renders as `img.style.width`. Clicking the image toolbar backdrop or anywhere
  outside dismisses it; right-click on an image with a link mark opens the linked
  URL in the browser instead.
- **CSV spreadsheet editor** — `.csv` files open as a live spreadsheet grid
  (RevoGrid) with editable cells, formula support (`=SUM(A1:A3)`, `=AVG(...)`,
  `=COUNT(...)`, and A1-style cross-cell references), row numbers, and a
  bold first-row visual header. The grid swaps between Material / Material-Dark
  themes with the system color scheme. Right-click a cell for a context menu —
  insert / delete rows or columns around the focused cell, or clear the
  selected range (`Delete` clears too). Source mode still available via
  `Cmd+/`. A `/spreadsheet` slash command inserts an inline spreadsheet block
  inside Markdown (typing inside an embedded grid no longer gets stolen by
  the outer ProseMirror editor).
- **Rich mode block shortcuts** — keyboard shortcuts to insert or convert blocks
  without typing Markdown syntax: `Cmd+1–6` headings; `Cmd+0` paragraph;
  `Cmd+Shift+K` code block; `Cmd+Shift+M` math block; `Cmd+Shift+T` table;
  `Cmd+Shift+Q` blockquote; `Cmd+Opt+U/O/X` bullet / ordered / task list.
- **Slash command menu** (`/` at start of line in rich mode) — type `/` on an
  empty paragraph to open a filterable block-insert menu: headings H1–H3, quote,
  code block, Mermaid diagram, math formula, table, bullet/ordered/task list,
  divider, and file-picker entries for images and documents. Arrow keys navigate;
  Enter or Tab inserts.
- **Highlight mark** (`^^text^^` or `==text==`) — renders yellow highlighted text
  in both source (syntax decoration) and rich modes. `Cmd+H` in source view wraps
  the current selection; rich mode renders and serialises the mark transparently.
- **Task list checkboxes** — in rich mode, click a `- [ ]` / `- [x]` checkbox to
  toggle it; the change round-trips to the Markdown source (`[ ]` ↔ `[x]`). The
  marker shows a pointer cursor on hover.
- **Wikilinks** (`[[note]]`) — in rich mode a `[[target]]` renders as a link;
  click it to open `target.md` resolved next to the current file, creating an
  empty note if it doesn't exist yet. `[[target|alias]]` displays the alias.
  Typing `[[` auto-closes to `[[]]`, and the brackets are preserved literally in
  the saved Markdown.
- **Bare URL autolink** — `http(s)://…` URLs written as plain text render as
  clickable links in rich mode: a plain click opens them in the system browser,
  Cmd/Ctrl-click places the caret to edit. URLs inside code or existing links
  stay literal.
- **Literal inline markers** — typing `**`, `__`, `*`, `_`, `` ` ``, `~~`, `^^`,
  `==` in rich mode leaves the delimiters as source text instead of
  auto-collapsing them into a mark, so formatting stays user-driven. Marks
  already present in an opened file still render, and reveal their source
  delimiters on the caret's line (Live-Preview style), re-rendering once the
  caret leaves.
- **YAML frontmatter** — a leading `--- … ---` block renders in rich mode as a
  **collapsible metadata panel**, collapsed by default so it doesn't crowd the
  document (the summary shows the top-level keys; click to expand). Inside, the
  frontmatter is segmented: contiguous `key: value` runs become a table with
  **inline-editable scalar values** — edits write back to the YAML on blur,
  preserving comments and key order; lists, nested maps, and block scalars
  render read-only in their key's row; and non-`key: value` lines in between
  render as read-only Markdown.
- **Line-break fidelity** — multi-line blockquotes and in-block (Shift-Enter)
  breaks keep their line breaks in rich mode, and in exported / previewed /
  shared HTML (md2pdf, share), instead of collapsing onto one line.
- **Apple Silicon & Intel builds** — shipped as two independent per-arch `.dmg`s
  (`aarch64` and `x86_64`); auto-update picks the matching architecture

## Develop

```bash
pnpm install
pnpm tauri dev
```

## Build

For the current Mac architecture only:

```bash
pnpm tauri build
```

For both architectures (each produces its own `.app` — universal mode is retired):

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm tauri build --target aarch64-apple-darwin
pnpm tauri build --target x86_64-apple-darwin
```

Output:
- current-arch: `src-tauri/target/release/bundle/macos/M↓.app`
- per-arch: `src-tauri/target/<arch>-apple-darwin/release/bundle/macos/M↓.app`

## Release (maintainers)

```bash
scripts/release.sh <x.y.z>
```

Runs, in order: tests → version bump → signed per-arch build (`aarch64` +
`x86_64`) → notarize → tag → push → GitHub Release. Each release ships two
`.dmg`s, two updater tarballs + signatures, and a `latest.json` manifest whose
per-arch entries drive auto-update. Requires `APPLE_ID`, `APPLE_PASSWORD`, and
`APPLE_TEAM_ID` in `.env.release`, plus the Tauri updater signing key at
`~/.tauri/mdeditor.key`.

## CLI

M↓ ships a `mdedit` command that lets other applications drive plugin
features without opening the GUI. Install it from **Help → Install 'mdedit'
Command in PATH...** (you'll be prompted for admin if installing into
`/usr/local/bin`), or from **Preferences → CLI**.

```bash
mdedit -s draft.md                         # publish via Share plugin, prints URL
mdedit share draft.md --json               # structured output
mdedit share draft.md --copy-link          # re-fetch existing URL
mdedit share draft.md --unshare            # remove the share
mdedit help                                # full reference
mdedit plugin list                         # see all plugins and their status
```

The CLI only exposes commands contributed by *enabled* plugins. Disable a
plugin in **Preferences → Plugins** to remove its subcommand from `mdedit`.

### Reading Insights report (`scripts/insights-report.mjs`)

When the **Reading Insights** plugin is enabled, your per-document reading /
editing engagement is stored in the Vault under `.mdeditor/analytics/`. A
dependency-free Node script turns any date range into a markdown digest written
to `<vault>/stat/`, so external tools / cron can generate it headlessly:

```bash
node scripts/insights-report.mjs --vault ~/Vault --date yesterday      # default: yesterday
node scripts/insights-report.mjs --vault ~/Vault --date 7d             # today|yesterday|7d|30d|month
node scripts/insights-report.mjs --vault ~/Vault --from 2026-07-01 --to 2026-07-07
node scripts/insights-report.mjs --vault ~/Vault --date yesterday --stdout   # print instead of writing
```

The CLI digest covers your own (owner) engagement only; audience reading stats
for shared links appear in the in-app **Settings → Insights** panel (which also
has a one-click *Generate report* button that includes the value score).

## Manual Smoke Test (run before each release)

1. **Launch via Finder double-click** of any `.md` file → app opens with that file in a tab
2. **Cmd+O** → file dialog → select a `.md` → opens as new tab
3. **Drag a `.md` from Finder** into the window → opens as new tab
4. **Drag onto Dock icon** while app is running → opens as new tab in same window
5. **Edit content** → tab title shows dirty dot
6. **Cmd+S** → file is saved (timestamp changes); dirty dot disappears
7. **Cmd+Shift+S** → save dialog → save to new path → tab title updates to new filename
8. **Close dirty tab (× or Cmd+W)** → confirm dialog appears (Save / Discard / Cancel)
9. **Cmd+/** → toggles between source mode (textarea) and rich mode (WYSIWYG)
10. **Re-launch app** — **File → Open Recent** lists recently opened files (also mirrored across devices through the Vault when the Sync-to-Vault plugin is on); recent list persists in `~/Library/Application Support/com.laobu.mdeditor/settings.json`
11. **Toggle Preferences → Enable auto-save** (Cmd+,), edit, wait 1s, verify file saved silently
12. **Open a md with KaTeX, mermaid, code block** → all render in rich mode
13. **Cmd+W to close last tab** → empty state appears (window does not close)
14. **Close window with one dirty tab → Cancel** → window stays open
15. Open a `.py` file → source view shows raw content; switch to rich → renders as Python-highlighted code block (hljs colors)
16. Open a `.html` file → opens in **rich mode by default** (sandboxed iframe preview); switch to source → edit raw HTML
17. Open `Dockerfile` (no extension, exact filename match) → classified as code with `dockerfile` language
18. Drag an unsupported binary (e.g. `.zip` or `.exe`) into the window → toast: `Unsupported: <ext>`, no tab opened. (Image files are now supported — see item 59.)
19. Open a 6 MB log file → confirm dialog: `File is large (6 MB). Continue?` (manual: prepare such a file with `dd if=/dev/zero of=/tmp/big.log bs=1M count=6`); cancel → no tab; confirm → opens with potential lag
20. Open `.json` file, switch to rich → edit a value inside the rendered code block, switch back to source → see edit; Cmd+S → reopen → contents persist (round-trip byte-stable when fence intact)
21. **Menu-bar tray** — confirm M↓ glyph is visible in the macOS menu bar; click → window comes to front
22. **Close window (red traffic-light)** → app quits (no orphaned dock icon)
23. **External change — clean tab auto-reload**: open `~/foo.md` in M↓ (no edits), run `echo x >> ~/foo.md` from a shell. Within ~1 s (or after focusing M↓) editor content updates silently.
24. **External change — dirty tab banner**: edit `~/foo.md` in M↓ (dirty), run the same external append. Yellow banner appears with three buttons.
25. **Banner — Reload from disk**: clicking it replaces the editor with disk content; banner clears.
26. **Banner — Overwrite with my changes**: clicking it writes the buffer to disk; banner clears; `cat ~/foo.md` shows the buffer content.
27. **External delete**: `rm ~/foo.md` while open. Banner switches to "deleted" variant (red accent).
28. **Recreate on Save**: ⌘S in deleted state writes the buffer to the (now non-existent) path, recreating the file. Banner clears.
29. **Stale banner refresh**: while the changed-banner is showing, modify the file again externally. Banner stays. Clicking Reload pulls the LATEST content (not stale).
30. **Self-write suppression**: Cmd+S inside M↓. Watcher receives the echo. Banner does NOT appear.
31. **Export markdown to PDF**: open a `.md` file → File → Export to PDF… (or Cmd+Shift+E) → default filename = `<basename>.pdf` → save → PDF appears at chosen path within ~2 s.
32. **Export markdown with KaTeX**: doc with `$E=mc^2$` and `$$\int_0^1 x dx$$` → math renders correctly in the PDF (not raw `$...$`).
33. **Export markdown with Mermaid** (DEFERRED — see plan): doc with a ` ```mermaid ` block → in v1 the diagram source renders as a plain code block; v1.1 follow-up integrates rendered SVG.
34. **Export markdown with code blocks**: monospace font, light-grey background, long lines wrap (no horizontal overflow off the page).
35. **Export HTML tab**: content preserved; no script side-effects.
36. **Export dirty tab**: edit but don't save → export → PDF reflects buffer, not on-disk content.
37. **Export long markdown** (>200 lines): page breaks fall on safe boundaries — headings not orphaned at page bottom; code blocks not split across pages.
38. **Export markdown with relative-path images** (`![alt](./assets/foo.png)`): image appears in the PDF (the offscreen WKWebView resolves relative paths via the source file's directory).
39. **Try Export to PDF on a code tab** (e.g., `.py`): info dialog says "PDF export only supports Markdown and HTML files."
40. **Plugin platform — manifest discovery**: Place a fixture manifest under
    `src-tauri/plugins/test/manifest.json` (with `binary: "bin"` and
    `bin-aarch64-apple-darwin` plus `bin-x86_64-apple-darwin` shell scripts);
    `pnpm tauri dev` → verify the plugin's File-menu items appear with their
    shortcuts shown.
41. **Plugin platform — enabled_when**: Same fixture, with
    `enabled_when: "currentTab.hasContent"` on one item. Open M↓ with no tabs
    → menu item is disabled. Open a markdown file → menu item enables.
42. **Plugin platform — context menu**: Right-click a tab → fixture's
    context-menu item appears.
43. **Plugin platform — Preferences tab**: Open Preferences → fixture's tab
    label appears in the strip; click it → form fields render correctly for
    each `string`/`secret`/`select`/`boolean` schema entry; edit a value and
    re-open Preferences → value persists.
44. **Plugin platform — happy path**: Click the fixture's File-menu item →
    fixture echoes a `toast` action → toast appears bottom-right with the
    expected message and auto-dismisses.
45. **Plugin platform — clipboard.write**: Fixture returns
    `clipboard.write` action → after the click, paste anywhere → expected
    text is in the clipboard.
46. **Plugin platform — settings.merge persistence**: Fixture returns a
    `settings.merge` action → re-launch M↓ → fixture's command sees the
    merged value back in the next request's `settings` field.
47. **Plugin platform — timeout**: Replace fixture binary with one that
    sleeps forever → click → toast `❌ <name>: no response (30s)` appears within
    ~30s and editing remains responsive throughout.
48. **Plugin platform — protocol error**: Replace fixture binary with one
    that prints `not json\n` → click → toast `❌ <name>: protocol error` with
    expandable detail showing the offending stdout fragment.
49. **Plugin: install share** — run `pnpm build:mdshare`, then in `worker/`
    deploy via `wrangler deploy` and copy the URL + API key into M↓
    Preferences → Share. Restart M↓.
50. `Cmd+Shift+L` on a saved markdown file → toast "✅ Shared (copied)";
    paste from clipboard → URL works in browser.
51. Same file, edit a paragraph, `Cmd+Shift+L` again → toast "✅ Content updated (link copied)";
    same URL still in clipboard; recipient page reflects new content.
52. File → Unshare Current File → toast "✅ Share revoked"; reload recipient
    page → 410 page shown.
53. Right-click a tab → "Share This Tab..." appears; click → publishes.
54. Open M↓ on iPhone Safari → recipient page is readable, no horizontal
    scroll, code blocks scroll within their container.
55. Switch system to dark mode → recipient page automatically switches.
56. Disconnect network, click `Cmd+Shift+L` → toast "❌ Share: Network error, please check your connection";
    M↓ remains responsive throughout.
57. **Share with Mermaid block** — share a markdown file containing a
    ` ```mermaid ` flowchart → recipient page shows the rendered SVG, not
    the raw source.
58. **Open image** — `Cmd+O` → file picker shows image filter; pick a
    `.png` / `.jpg` → opens as a preview tab. Mode toggle is hidden.
    `Cmd+S` is no-op (image is read-only).
59. **Drag image into window** — drag a `.png` from Finder onto M↓'s
    window → opens as a preview tab (no longer rejected with toast).
60. **Share image** — open an image, `Cmd+Shift+L` → toast "✅ Image shared
    (copied)" and the URL `https://.../f/<id>.<ext>` in the clipboard; paste →
    URL works in browser; image displays at full quality.
61. **External image change** — replace the open image file from a shell
    (e.g. `cp other.png foo.png`). Within ~1 s the preview refreshes to
    the new content (no banner — images can't be dirty).
62. **Disable md2pdf** — Preferences → Plugins → uncheck "Export to PDF"
    → restart M↓ → File menu has no "Export to PDF…", `Cmd+Shift+E` does
    not respond.
63. **Re-enable md2pdf** — re-check → restart → menu item returns,
    `Cmd+Shift+E` works.
64. **Disable share** — same flow on the share row (uncheck → restart →
    no Share items in the File menu; `Cmd+Shift+L` un-bound).
65. **Default-on for new plugin** — delete the `plugins.enabled` segment
    from `~/Library/Application Support/com.laobu.mdeditor/settings.json`
    → restart → both `share` and `md2pdf` are still active (default-on
    rule).
66. **md2pdf timeout** — temporarily edit
    `src-tauri/plugins/md2pdf/manifest.json` `timeout_seconds: 1`, export
    a sizable doc → toast `❌ md2pdf: no response (1s)`, M↓ stays responsive.
    Restore the manifest after the smoke test.
67. **md2pdf write failure** — try saving a PDF into a read-only directory
    → an `❌ md2pdf: …` failure toast (render/write, from the plugin);
    M↓ stays responsive.
68. **Theme switch (Light)** — open a markdown file with H1/H2/H3,
    blockquote, bullet list, table, hr → Preferences (Cmd+,) → Themes →
    switch *Light theme* to "Effie". Editor immediately updates to
    Effie's mint-paper palette. Switch back to "Default" → reverts.
69. **Theme persistence** — set Light=Effie, Dark=Default, quit M↓,
    relaunch. Preferences shows Effie/Default in the dropdowns; editor
    is styled by Effie in light mode.
70. **Light/Dark auto-switch** — with Light=Default, Dark=Effie, toggle
    macOS Appearance between Light and Dark; editor flips themes
    instantly with no flash.
71. **Always use light theme** — check the box, toggle macOS Appearance
    → editor stays on the light theme regardless.
72. **Import Typora zip via drag** — drag a Typora theme `.zip` onto
    the window. Confirmation dialog lists detected themes with their
    appearances. Click Import → toast "Imported N themes." → dropdowns
    now include them.
73. **Import via Preferences button** — Preferences → "Import Typora
    theme…" → pick a zip → import works the same. Re-importing the
    same zip prompts for an overwrite confirmation; cancel keeps
    existing themes.
74. **Apply imported theme** — pick a freshly imported theme in the
    Light dropdown; editor turns into that theme's palette.
75. **Reveal themes folder** — click "Reveal themes folder" → Finder
    opens `~/Library/Application Support/com.laobu.mdeditor/themes/`
    with source CSS, asset folders, and a `.compiled/` subfolder.
76. **Manual delete via Finder** — delete a theme's `.css` in Finder,
    click "Reload themes" → dropdown updates, that theme is gone.
77. **Restore built-in themes** — delete `default.css` in Finder, then
    "Restore built-in themes" → file reappears, theme works.
78. **Theme + share plugin** — with Effie active, share via
    `Cmd+Shift+L`. Shared HTML uses Effie's compiled palette.
79. **Malformed zip** — drag a `.zip` containing no CSS → dialog shows
    "No Typora themes found in this zip." Close → no files written.
80. **Zip size cap** — drag a `.zip` with a > 5 MB single CSS entry →
    dialog refuses with "entry too large".
81. **mdblock — auto-load on open** — Settings → Block → check
    "Enable Block IDs" → open any `.md` file. Markers appear
    immediately in both source (left gutter) and rich (left gutter
    overlay) without any explicit compute step. Behind the scenes
    a yaml is computed in-memory.
82. **mdblock — live update on type** — start typing in source
    mode (or rich mode). Within ~250 ms of pausing, marker
    positions and ids re-flow to match the new structure (new
    blocks appear, removed blocks vanish, line offsets shift).
83. **mdblock — persist on save** — with the yaml from #81-82 in
    memory, press `Cmd+S`. The yaml is written atomically to
    `~/Library/Application Support/com.laobu.mdeditor/blocks/<sha256-of-abs-path>.yaml`
    — *not* next to the source file. `meta.generation` increments
    each save; `active[]` lists `b-xxxxxx` entries with line/pos
    extents and MinHash fingerprints.
84. **mdblock — light edit preserves ids** — edit the document
    lightly (fix a typo) → `Cmd+S` → reopen the cached yaml. Ids
    for untouched blocks are unchanged; the touched block keeps
    its id with status `edited` (parents unchanged).
85. **mdblock — heavy edit retires ids** — delete a paragraph
    entirely → `Cmd+S` → yaml `history[]` grows by one entry; the
    deleted id has `replaced_by: []` and a `last_fingerprint`.
86. **mdblock — copy citation** — click any block marker in the
    source-mode gutter or the rich-mode overlay. A toast confirms
    `((<basename>#b-xxxxxx))` was copied to the clipboard. Paste
    elsewhere to verify.
87. **mdblock — follow citation** — in another `.md` paste
    `((<other-doc-basename>.md#b-xxxxxx))` (use a real id from
    #71) → place cursor inside `((..))` → `Cmd+Enter` → other doc
    opens, jumps to the right line. If the target id has been
    retired, M↓ walks the lineage chain via `replaced_by` and lands
    on the successor (or surfaces a "deleted" toast if none).
88. **mdblock — citation pill in share output** — share a doc that
    contains `((other.md#b-xxxxxx))` via the share plugin → the
    generated HTML renders a `.block-citation` pill, not raw
    parens.
89. **mdblock — yaml stays out of working tree** — confirm the
    source directory contains *no* `<basename>.block.yaml`. The
    only block file that ever lands sibling-of-source is the
    optional `<basename>.block.md` (only when "Generate
    .block.md" is explicitly invoked).
90. **Paste screenshot in rich mode (named doc)** — open a saved `.md`,
    switch to rich mode, take a screenshot (`Cmd+Ctrl+Shift+4`), paste
    → image appears in the editor; source mode shows
    `![](docname_files/image-<ts>.png)`; the file exists at
    `{docDir}/docname_files/image-<ts>.png`.
91. **Paste screenshot in source mode** — same flow in source mode →
    `![](docname_files/image-<ts>.png)` inserted at cursor; switch to
    rich → image renders.
92. **Paste screenshot in untitled doc** — new file (unsaved), paste
    screenshot → absolute temp path in source; save as `notes.md` →
    path auto-updates to `notes_files/image-<ts>.png`; file moved.
93. **Drag image file (rich mode)** — drag a `.png`/`.jpg` from Finder
    onto the rich editor → `![](/absolute/path/photo.jpg)` inserted at
    drop point; image renders.
94. **Drag non-image file (rich mode)** — drag a `.pdf` from Finder →
    `[filename.pdf](/absolute/path)` inserted; renders as a 📄 card.
95. **Paste attachment URL** — copy `https://example.com/report.pdf`,
    paste in rich or source mode → `[report.pdf](url)` link; renders
    as a 📄 chip/card in rich mode.
96. **Image resize toolbar** — click an image in rich mode → toolbar
    appears above it with 25%/50%/75%/100%/Original buttons; click 50% →
    image shrinks; source shows `"width=50%"` in title attr; click Original
    → title cleared.
97. **YouTube card** — copy `https://www.youtube.com/watch?v=dQw4w9WgXcQ`,
    paste in rich mode → red ▶ card appears; title updates from oEmbed
    within ~1 s; click card → browser opens video; source shows
    `[Never Gonna Give You Up](url)`.
98. **Bilibili card** — paste a `bilibili.com/video/BV…` URL → blue ▶
    card; title from Bilibili API; click → browser opens.
99. **Video card chip vs full-width** — paste a YouTube URL inline
    (within a sentence) → small chip with red ▶ icon; paste on its
    own line → full-width card.
100. **Folder View** — View → Folder View (or `Cmd+Shift+E`) opens the left
     sidebar tree of the current file's folder; click a file → opens in a tab;
     click the **Find** icon, type a regex (e.g. `\.md$`) → the tree filters
     recursively, showing matches under their parent folders; the ✕ clears it.
     Right-click any node → **Reveal in Finder** selects it in Finder. Create a
     file in that folder from a shell → the tree refreshes within ~1 s.
101. **Language switch** — Preferences → Core → **Language** → pick 简体中文 →
     the whole UI (dialogs, banners, toasts, slash menu), the **macOS menu bar**
     and its system items (Undo/Copy/Quit…), and the **menu-bar tray** dropdown
     all switch to Chinese immediately; pick 日本語 → switches to Japanese;
     back to English → reverts. Quit and relaunch → the choice persists and the
     menu bar comes up already localized.

### iOS smoke (run on simulator + real device for v1 release)

> Note: items 79, 84 (system Share Sheet popup) and 78 (Cmd+S/O/W keyboard
> shortcuts) depend on the Swift bridge that was deferred to post-v1. On
> v1 the share toast still shows the URL and clipboard still works; iPad
> keyboard shortcuts use the menu bar instead.

71. iPad simulator: Files App pick a `.md` → "Open With M↓" → editor
    opens, top toolbar visible.
72. Edit content → toolbar Save → file written in place (verify timestamp
    in Files App).
73. Quit M↓ → relaunch → Recent drawer shows the previous file → tap →
    re-opens (security-scoped bookmark renewed).
74. Delete the original file in Files App → return to M↓ → red "deleted"
    banner.
75. iPhone real device: single document fullscreen; tap ☰ → drawer slides
    in; pick Settings → switch skin to "shuyuan" → editor updates
    immediately.
76. iPhone: open three different `.md` files via Drawer → `tabs.svelte`
    store should hold 3 tabs but UI only renders the active one;
    switching between Recent items preserves edit history (verify
    `tabs.length === 3` in dev console).
77. iPhone: long-press a Recent item → Delete-from-Recent option appears.
78. **DEFERRED:** iPad with external keyboard → Cmd+O / Cmd+S / Cmd+/ /
    Cmd+Shift+S — requires Swift `UIKeyCommand` bridge (post-v1).
79. **DEFERRED:** Cmd+Shift+L → share publish + system Share Sheet popup
    — requires Swift `UIActivityViewController` bridge (post-v1). On v1,
    use the toolbar Share button; URL is copied to clipboard, share
    manually.
80. iOS: share a Mermaid-containing document → open share URL in Safari
    → flowchart renders as SVG (matches macOS).
81. iOS: share a KaTeX-containing document → recipient page renders
    formulas correctly.
82. iOS: edit shared document → toolbar Share → toast "✅ Content updated (link copied)"
    with same URL.
83. iOS: toolbar Unshare → recipient page returns 410.
84. iOS: pick a `.png` from Files App → preview tab → toolbar Share →
    URL copied to clipboard. (System Share Sheet popup deferred — see 79.)
85. iOS: airplane mode + toolbar Share → toast "❌ Share: Network error, please check your connection".
86. iOS: `share.apiKey` not configured → Share → toast pointing to
    Settings → Share.
87. iOS: 25+ MB markdown → Share → toast "❌ Share: Document too large (25 MB limit)".
88. iOS: Mail attachment "Open in M↓" a `.md` → editor opens; rich mode
    renders KaTeX.
89. iOS: dark mode toggle → editor + skins (incl. effie) re-render.
90. iOS: rotate iPad portrait↔landscape → toolbar + editor reflow, no
    overlap.
91. iPad Split View (M↓ on half-screen) → drawer + toolbar shrink but
    don't break.
92. iOS: enable autosave → edit → 1s after pause, file written in place
    (Files App timestamp updates).
93. iOS: open `.py` in source mode → switch to rich mode → syntax
    highlight renders (verify dockerfile / py / ts).
94. iOS: open `.html` → defaults to rich mode → sandboxed iframe
    preview works.
95. iOS: Settings → Plugins tab and "Default App for Extensions"
    section are **completely absent**.
96. iOS: vault not configured → the drawer's Vault section shows "go to Settings
    to configure a repo"; tapping it jumps to SettingsDialog → Vault tab.
97. Enter remote URL + PAT + Save → clone runs → on completion the drawer shows
    the vault root's files.
98. Vault configured, kill the process and reopen → vault state auto-restores,
    file list intact.
99. Tap a `.md` file in the drawer → mdeditor opens it; edit + save → working
    tree goes dirty.
100. Tap the [↻] sync button in the Vault section → spinner → on completion
     toast "✓ Vault sync complete"; a new commit `vault: auto-sync <ts>` is
     visible on GitHub Web.
101. Change a file on another device and push → bring the iOS app to the
     foreground → within ~5 s it auto-pulls → that file's mtime updates in the
     drawer; opening it shows the new content.
102. Two-way conflict: edit A locally + A also changed remotely → sync → toast
     "⚠️ Vault: sync complete; some local edits kept as .conflict copies" →
     `A.conflict.<ts>.md` appears in the same folder in the drawer; the GitHub
     repo receives both files.
103. PAT invalidated (GitHub revoke) → sync → toast "❌ Vault: authentication
     failed — update your PAT in Vault settings".
104. Airplane mode → sync → toast "❌ Vault: network error".
105. "Disconnect Vault" → confirm → local `Documents/Vault/` deleted, the
     Keychain item cleared, the drawer's Vault section returns to "Not
     configured"; the remote repo is unaffected.
106. On iPad the ☰ button shows and opens the drawer; vault file browsing
     behaves the same as on iPhone.
107. A `.png` in the vault repo → tap it in the drawer → opens an mdeditor image
     preview tab.
108. The vault repo's `.git` directory is not visible in the drawer.
109. Files App → `Documents/Vault/` → the user sees the full working tree (incl.
     `.git`) → no iCloud icon at the top (`NSURLIsExcludedFromBackupKey` in
     effect).
110. IPA size increment < 10 MB (vs the v0.6.0 baseline); total IPA < 30 MB.

## Spec & Plan

- Designs: `docs/superpowers/specs/`
- Plans: `docs/superpowers/plans/`

## License

Apache-2.0 (consistent with `@moraya/core`).
