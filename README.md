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
- **Skins** for rich mode (Preferences → Core): GitHub-style **default**;
  **shuyuan**, modern Chinese book typography (思源宋体 body, Kaiti blockquote,
  first-line indent); and **effie**, an Effie-inspired mint-paper aesthetic in
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
62. **Disable md2pdf** — Preferences → Plugins → uncheck "Export to PDF"
    → restart M↓ → File menu has no "Export to PDF…", `Cmd+Shift+E` does
    not respond.
63. **Re-enable md2pdf** — re-check → restart → menu item returns,
    `Cmd+Shift+E` works.
64. **Disable share** — same flow on the share row (uncheck → restart →
    no Share items in the File menu; `Cmd+Shift+L` un-bound).
65. **Default-on for new plugin** — delete the `plugins.enabled` segment
    from `~/Library/Application Support/com.bruce.mdeditor/settings.json`
    → restart → both `share` and `md2pdf` are still active (default-on
    rule).
66. **md2pdf timeout** — temporarily edit
    `src-tauri/plugins/md2pdf/manifest.json` `timeout_seconds: 1`, export
    a sizable doc → toast `❌ md2pdf: 未响应（1s）`, M↓ stays responsive.
    Restore the manifest after the smoke test.
67. **md2pdf write failure** — try saving a PDF into a read-only directory
    → toast `❌ md2pdf: 渲染失败` (or `写入失败` depending on which step
    failed); M↓ stays responsive.
68. **Skin switch** — open a markdown file with H1/H2/H3, blockquote,
    bullet list, table, hr → Preferences (Cmd+,) → Core → switch Skin
    to "书苑（中文优化）". Editor visually updates immediately:
    Songti/思源宋体 body, sans-serif headings, first-line paragraph
    indent, Kaiti blockquote, middle-dot bullets, horizontal-only
    table borders, three-asterisk hr. No flash, no scroll jump. Switch
    back to "Default" → look reverts to GitHub-ish style.
69. **Skin persistence** — set Skin to "书苑", quit M↓, relaunch.
    Editor opens with 书苑 still applied; Preferences dropdown still
    shows "书苑（中文优化）".
70. **Skin + dark mode** — with 书苑 active, toggle macOS Appearance
    between Light and Dark. Text/background invert via system
    colors; skin decoration (heading rules, blockquote borders, table
    horizontals, hr asterisks) all stay legible in both modes.

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
82. iOS: edit shared document → toolbar Share → toast "✅ 内容已更新（链接已复制）"
    with same URL.
83. iOS: toolbar Unshare → recipient page returns 410.
84. iOS: pick a `.png` from Files App → preview tab → toolbar Share →
    URL copied to clipboard. (System Share Sheet popup deferred — see 79.)
85. iOS: airplane mode + toolbar Share → toast "❌ Share: 网络错误".
86. iOS: `share.apiKey` not configured → Share → toast pointing to
    Settings → Share.
87. iOS: 25+ MB markdown → Share → toast "❌ Share: 文档过大（X MB / 上限 25 MB）".
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
96. iOS：未配置 vault → 抽屉 Vault 分区显示"去设置配置仓库"；点跳到
    SettingsDialog → Vault tab。
97. 输入 remote URL + PAT + 保存 → toast "正在 clone..." → 完成后抽屉
    显示 vault 根目录文件。
98. 已配置 vault，杀进程重开 → vault 状态自动恢复，文件列表照旧。
99. 点抽屉里一个 `.md` 文件 → mdeditor 打开；编辑保存 → 工作树 dirty。
100. 点 vault 区的 [↻] 同步按钮 → spinner → 完成后 toast "✓ Vault 同步
     完成"；GitHub Web 上能看到新 commit `vault: auto-sync <ts>`。
101. 另一台设备改一个文件 push → iOS App 切回前台 → 5 秒内自动拉回 →
     抽屉里该文件 mtime 更新；打开文件看到新内容。
102. 双向冲突：本地编辑 A + 远端也改 A → 同步 → toast "⚠️ Vault: 同步
     完成，1 个本地修改保留为 .conflict 副本" → 抽屉里
     `A.conflict.<ts>.md` 同目录可见；GitHub 仓库收到两个文件。
103. PAT 失效（GitHub revoke）→ 同步 → toast "❌ Vault: 鉴权失败，请去
     Vault 设置更新 PAT"。
104. 飞行模式 → 同步 → toast "❌ Vault: 网络错误"。
105. "断开 Vault" → 二次确认 → 本地 `Documents/Vault/` 删除、Keychain
     item 清除、抽屉 Vault 区回到"未配置"；远端仓库不受影响。
106. iPad 上 ☰ 按钮显示并能打开抽屉；vault 文件浏览行为与 iPhone 一致。
107. vault 仓库中有 `.png` → 抽屉点击 → 进入 mdeditor 图片预览 tab。
108. vault 仓库 `.git` 目录在抽屉中不可见。
109. Files App → `Documents/Vault/` → 用户看到完整工作树（含 `.git`）→
     顶部不显示 iCloud 图标（`NSURLIsExcludedFromBackupKey` 生效）。
110. IPA 包体增量 < 10 MB（与 v0.6.0 baseline 对比）；总 IPA < 30 MB。

## Spec & Plan

- Designs: `docs/superpowers/specs/`
- Plans: `docs/superpowers/plans/`

## License

Apache-2.0 (consistent with `@moraya/core`).
