# M↓ (mdeditor)

A minimal native text editor for macOS — Markdown, HTML, and source code, with both
**source** and **rich** (WYSIWYG) modes, a tabbed window, and a persistent menu-bar tray.

The product name is **M↓** (an *M* with a downward arrow, hinting at *markdown*);
the underlying repo, crate, and bundle identifier remain `mdeditor` /
`com.bruce.mdeditor`.

Built on [`@moraya/core`](https://www.npmjs.com/package/@moraya/core).

## Features

- **Tabs** with dirty indicator, drag-to-reorder, and confirm-on-close
- **Source / rich toggle** (`Cmd+/`) — textarea ↔ WYSIWYG
- **Markdown rendering** with KaTeX math, Mermaid diagrams, and highlight.js code
- **HTML files** open in a sandboxed iframe preview by default
- **Code files** (~36 plain-text extensions, plus exact matches like `Dockerfile`)
  render as syntax-highlighted code blocks in rich mode
- **Finder integration** — double-click a `.md` / `.html` file to open it; drag
  files onto the window or Dock icon
- **Menu-bar tray** — persistent M↓ icon stays in the menu bar; click to bring
  the window forward
- **Auto-save** (opt-in via Preferences) and **Recent files** persisted to
  `~/Library/Application Support/com.bruce.mdeditor/settings.json`
- **Universal binary** support (Intel + Apple Silicon)

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

For a universal (Intel + Apple Silicon) `.app`:

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
pnpm tauri build --target universal-apple-darwin
```

Output:
- single-arch: `src-tauri/target/release/bundle/macos/M↓.app`
- universal: `src-tauri/target/universal-apple-darwin/release/bundle/macos/M↓.app`

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
10. **Re-launch app** — Open Recent submenu is not yet implemented in v0.1; recent list is stored in `~/Library/Application Support/com.bruce.mdeditor/settings.json`
11. **Toggle Preferences → Enable auto-save** (Cmd+,), edit, wait 1s, verify file saved silently
12. **Open a md with KaTeX, mermaid, code block** → all render in rich mode
13. **Cmd+W to close last tab** → empty state appears (window does not close)
14. **Close window with one dirty tab → Cancel** → window stays open
15. Open a `.py` file → source view shows raw content; switch to rich → renders as Python-highlighted code block (hljs colors)
16. Open a `.html` file → opens in **rich mode by default** (sandboxed iframe preview); switch to source → edit raw HTML
17. Open `Dockerfile` (no extension, exact filename match) → classified as code with `dockerfile` language
18. Drag a `.png` into the window → toast: `Unsupported: png`, no tab opened
19. Open a 6 MB log file → confirm dialog: `File is large (6 MB). Continue?` (manual: prepare such a file with `dd if=/dev/zero of=/tmp/big.log bs=1M count=6`); cancel → no tab; confirm → opens with potential lag
20. Open `.json` file, switch to rich → edit a value inside the rendered code block, switch back to source → see edit; Cmd+S → reopen → contents persist (round-trip byte-stable when fence intact)
21. **Menu-bar tray** — confirm M↓ glyph is visible in the macOS menu bar; click → window comes to front
22. **Close window (red traffic-light)** → app quits (no orphaned dock icon)

## Spec & Plan

- Designs: `docs/superpowers/specs/`
- Plans: `docs/superpowers/plans/`

## License

Apache-2.0 (consistent with `@moraya/core`).
