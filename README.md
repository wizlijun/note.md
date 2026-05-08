# M↓ (mdeditor)

[English](README.md) · [简体中文](README.zh-CN.md)

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
- **Image files** (jpg / jpeg / png / gif / webp / svg / bmp / heic / heif / avif)
  open as preview-only tabs (rich mode shows the image; no source view).
  `Cmd+Shift+L` uploads them to Cloudflare R2 and copies the public URL.
- **Finder integration** — double-click a `.md` / `.html` file to open it; drag
  files onto the window or Dock icon
- **Menu-bar tray** — persistent M↓ icon stays in the menu bar; click to bring
  the window forward
- **Auto-save** (opt-in via Preferences) and **Recent files** persisted to
  `~/Library/Application Support/com.bruce.mdeditor/settings.json`
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
    sleeps forever → click → toast `❌ <name>: 未响应（30s）` appears within
    ~30s and editing remains responsive throughout.
48. **Plugin platform — protocol error**: Replace fixture binary with one
    that prints `not json\n` → click → toast `❌ <name>: 协议错误` with
    expandable detail showing the offending stdout fragment.
49. **Plugin: install share** — run `pnpm build:mdshare`, then in `worker/`
    deploy via `wrangler deploy` and copy the URL + API key into M↓
    Preferences → Share. Restart M↓.
50. `Cmd+Shift+L` on a saved markdown file → toast "✅ 分享成功（已复制）：…";
    paste from clipboard → URL works in browser.
51. Same file, edit a paragraph, `Cmd+Shift+L` again → toast "✅ 内容已更新（链接已复制）";
    same URL still in clipboard; recipient page reflects new content.
52. File → Unshare Current File → toast "✅ 已撤销分享"; reload recipient
    page → 410 page shown.
53. Right-click a tab → "Share This Tab..." appears; click → publishes.
54. Open M↓ on iPhone Safari → recipient page is readable, no horizontal
    scroll, code blocks scroll within their container.
55. Switch system to dark mode → recipient page automatically switches.
56. Disconnect network, click `Cmd+Shift+L` → toast "❌ Share: 网络错误";
    M↓ remains responsive throughout.
57. **Share with Mermaid block** — share a markdown file containing a
    ` ```mermaid ` flowchart → recipient page shows the rendered SVG, not
    the raw source.
58. **Open image** — `Cmd+O` → file picker shows image filter; pick a
    `.png` / `.jpg` → opens as a preview tab. Mode toggle is hidden.
    `Cmd+S` is no-op (image is read-only).
59. **Drag image into window** — drag a `.png` from Finder onto M↓'s
    window → opens as a preview tab (no longer rejected with toast).
60. **Share image** — open an image, `Cmd+Shift+L` → toast "✅ 图片分享成功
    （已复制）：https://.../f/<id>.<ext>"; paste from clipboard → URL works
    in browser; image displays at full quality.
61. **External image change** — replace the open image file from a shell
    (e.g. `cp other.png foo.png`). Within ~1 s the preview refreshes to
    the new content (no banner — images can't be dirty).

## Spec & Plan

- Designs: `docs/superpowers/specs/`
- Plans: `docs/superpowers/plans/`

## License

Apache-2.0 (consistent with `@moraya/core`).
