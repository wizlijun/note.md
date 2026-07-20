# note.md

[English](README.md) · [简体中文](README.zh-CN.md) · [notemd.net](https://notemd.net)

> **Read what AI writes. Keep what you think. Keep what only *you* can write.**

**note.md** is a markdown reader & editor for the AI-native era — built for the
moment when your agents write more in a night than you will all year, and the
bottleneck is no longer writing but **reading, judging, and keeping the few
lines only you could have written**. That residue — your judgment, intent,
private facts, and decisions — is the one thing no model can generate. Humans
and agents work in the same plain files: agents write documents, you read and
mark them up, your marks become data your agents read back. No database, no
cloud, no walled garden — a folder of markdown you own forever.

The product name is **note.md** (all lowercase — a note that *is* a plain
markdown file). The CLI binary and bundle identifier are `notemd` /
`net.notemd.app`, and the legacy `mdedit` CLI symlink still works alongside
`notemd`. You will still see `mdeditor` inside the source tree (the Rust
library crate is named `mdeditor_lib`). Versions before v4.8.0 shipped as **M↓**.

Built with [Tauri](https://tauri.app) on
[`@moraya/core`](https://www.npmjs.com/package/@moraya/core): a code-signed,
notarized native macOS `.app` — native Rust binary, native menus / window /
menu-bar tray — whose editor UI is web technology rendered in the system
WebView (WKWebView). No bundled browser, unlike Electron.

## The idea

Four convictions shape everything here:

1. **AI text is infinite; your attention isn't — your judgment is the residue.**
   The documents you actually read and mark up are the ones that earned your
   attention. What you leave in the margins — judgment, intent, private facts,
   decisions — is the one thing no model can generate, and the most valuable
   data you own. note.md captures it instead of losing it in the scroll.
2. **Files over app.** Every note is a plain `.md` on your disk: git-friendly,
   greppable, openable in any other editor today, readable in fifty years.
   Indexes are derived data; files are the only source of truth.
3. **Agents are first-class citizens — they suggest, you confirm.** The vault's
   conventions are plain text that any agent can read. `✦` marks what AI writes;
   `●` marks what you think. Agents write documents and can *suggest* links, but
   the graph grows only where **you** confirm it — note.md never auto-connects
   your notes or fills the vault with agent slop. The loop — agents write, you
   annotate, agents learn from your margins — runs entirely through files on
   your disk.
4. **Your marks belong to the vault, not to a path.** You read files that live
   outside your vault, and paths are fragile across devices and tools. When you
   annotate, note.md mirrors the source into your vault so your marks get a
   stable, git-versioned host — the original stays put, the mirror stays in
   sync, and your notes never lose their home.

## The notes layer

The AI-native notes system, rolling out incrementally:

- [x] **Sidecar notes** — highlights and comments made while reading
      `xxx.md` are saved to a companion `xxx.note.md`. The source stays
      pristine and regenerable; your judgment becomes permanent, searchable
      data. A `.note.md` with no sibling source file is a standalone note.
- [x] **Outline editor** — every `.note.md` opens in a Roam-style outline
      view (never the plain markdown editor); outlines persist as nested
      markdown lists, so the files stay readable everywhere.
- [ ] **Daily notes** — `dailynote/yyyy/yyyy-MM-dd.note.md`, one keystroke
      away, with `yyyy-MM.note.md` / `yyyy.note.md` as monthly / yearly
      summaries and `[[yyyy-MM-dd]]` as the canonical date link.
- [ ] **Wiki pages** — standalone outline notes under `wikipage/`, one
      `[[title]]` namespace across the whole vault.
- [ ] **Global index** — full-vault instant search, backlinks, and link
      autocomplete, rebuilt from files at any time.
- [ ] **Roam import** — one-shot converter from a Roam Research JSON export
      (date-page rewriting + broken-link report included).
- [ ] **Vault MCP server** — expose `vault_search` / `vault_read` /
      `vault_annotate` so any agent (Claude Code, Codex, OpenClaw, Hermes, …)
      can work your vault, with note.md as one client among many.

## Features

### Reading & annotating

- **Rich reading view** — KaTeX math, Mermaid diagrams, highlight.js code
  blocks; HTML files open in a sandboxed iframe preview; ~36 code file types
  render as syntax-highlighted blocks; images open as preview tabs.
- **Highlight mark** (`^^text^^` or `==text==`) — yellow highlight in both
  modes; `Cmd+H` in source view wraps the selection.
- **Block IDs (mdblock)** — every top-level block (paragraph, heading, code
  block, list, table, …) gets a stable `b-xxxxxx` id. Cite any passage from
  anywhere with `((path/to/file.md#b-xxxxxx))` — sub-page granularity for
  humans *and* agents. Ids are edit-resilient (content MinHash + five-pass
  merge); block metadata lives in a central cache, never beside your files.
  Click a gutter marker to copy a citation; `Cmd+Enter` follows one.
- **Reading Insights** — per-document reading / editing engagement
  stored in your vault; turn any date range into a markdown digest from the
  CLI or **View → Reading Insights**.
- **Attachment & video cards** — links to documents, audio, and video render
  as chips / cards; YouTube and Bilibili URLs fetch their titles and render
  as branded play cards.

### Writing & editing

- **Source / rich toggle** (`Cmd+/`) — plain textarea ↔ WYSIWYG, per tab.
- **Slash menu** (`/` on an empty line) and **block shortcuts**
  (`Cmd+1–6` headings, `Cmd+Shift+K` code, `Cmd+Shift+M` math,
  `Cmd+Shift+T` table, `Cmd+Opt+U/O/X` lists, …).
- **Live-preview markers** — typing `**`, `` ` ``, `==`, … stays literal
  until you ask for a mark; existing marks render but reveal their source on
  the caret's line.
- **Wikilinks** — `[[note]]` renders as a link; click to open (or create)
  `note.md` beside the current file; `[[note|alias]]` shows the alias.
- **Task checkboxes**, **bare-URL autolink**, **collapsible + inline-editable
  YAML frontmatter panel**, **line-break fidelity** across export / share.
- **Paste anything** — screenshots land in `{docname}_files/` with relative
  links; files paste as attachment links; images get a click-to-resize
  toolbar (25 / 50 / 75 / 100 %).
- **CSV spreadsheet editor** — `.csv` opens as a live grid with formulas
  (`=SUM(A1:A3)`, cross-cell refs), row/column ops, dark-mode themes; a
  `/spreadsheet` slash command embeds a grid inside markdown.
- **Find & Replace** (`Cmd+F` / `Cmd+H`) with regex, whole-word, and
  case-sensitive options, in both modes.
- **New file** (`Cmd+N`) with a random writing prompt, body pre-selected.

### Your files & vault

- **Folder View** — a live directory tree sidebar with recursive regex
  filtering and *Reveal in Finder*.
- **External change detection** — clean tabs reload silently; dirty tabs get
  a conflict banner (reload / overwrite / recreate on delete). Never silent
  data loss.
- **Sync to Vault** — copy any file into your git-synced vault with
  date-prefixed naming, source ↔ copy mapping, and conflict-aware refresh.
- **Tabs** with dirty indicators and drag-to-reorder; **auto-save** (opt-in);
  **recent files**; Finder double-click / drag-to-open.

### Built for agents

- **Block citations** — `((file#b-xxxxxx))` gives agents a stable way to
  quote and follow passages across the vault.
- **`notemd` CLI** — drive plugin features without the GUI:
  `notemd share draft.md` publishes a share link; `--json` for structured
  output; `notemd reading-insights report` writes engagement digests.
  Install from **Help → Install 'notemd' Command in PATH…**.
- **MCP endpoint** — the share Worker exposes MCP so agents can publish
  documents on your behalf.
- **Plugin system** — out-of-process plugins over stdin/stdout JSON with
  declarative manifests (menus, context menus, settings panels) and
  capability-gated host actions. Dormant until invoked.

### Share & export

- **Share** — `Cmd+Shift+L` publishes the current file as a
  self-contained page on your own Cloudflare Worker: KaTeX, Mermaid SVG,
  syntax highlighting, light + dark, mobile-ready. Update in place, unshare
  anytime; image-heavy docs spill to R2. See `worker/README.md` for
  deployment.
- **PDF export** (`Cmd+Shift+E`) — clean A4 PDF with math, diagrams, and
  highlighted code, rendered by an offscreen WKWebView (no headless
  Chromium).
- **Image upload** — `Cmd+Shift+L` on an image tab uploads to R2 and copies
  the public URL.

### The app

- **Trilingual UI** — English, 简体中文, 日本語 — covering every dialog, the
  native macOS menu bar (system items included), the tray, and plugin
  strings; switch live in Preferences, no restart.
- **Typora-compatible themes** — import any Typora theme `.zip`; pick
  separate light / dark themes that follow macOS Appearance. Ships with
  **default** (GitHub-style) and **effie** (mint-paper, LXGW WenKai).
- **Menu-bar tray**, Typora-style notification bar, full-UI zoom
  (`Cmd+=` / `Cmd+-` / `Cmd+0`).
- **Apple Silicon & Intel** `.dmg`s with per-arch auto-update.

## Develop

```bash
pnpm install
pnpm tauri dev
```

## Build

Current architecture only:

```bash
pnpm tauri build
```

Both architectures (each its own `.app`; universal mode is retired):

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm tauri build --target aarch64-apple-darwin
pnpm tauri build --target x86_64-apple-darwin
```

Output:
- current arch: `src-tauri/target/release/bundle/macos/note.md.app`
- per arch: `src-tauri/target/<arch>-apple-darwin/release/bundle/macos/note.md.app`

## Release (maintainers)

```bash
scripts/release.sh <x.y.z>
```

Tests → version bump → signed per-arch builds → notarize → tag → push →
GitHub Release (two `.dmg`s, two updater tarballs + signatures, and a
`latest.json` manifest driving per-arch auto-update). Requires `APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID` in `.env.release` and the updater key at
`~/.tauri/mdeditor.key`.

## CLI

```bash
notemd share draft.md                      # publish a share link, prints URL
notemd share draft.md --json               # structured output
notemd share draft.md --copy-link          # re-fetch existing URL
notemd share draft.md --unshare            # remove the share
notemd plugin list                         # all plugins and their status
notemd reading-insights report --vault ~/Vault --date 7d   # engagement digest
notemd help                                # full reference
```

The CLI ships built-in core commands (`share`, `reading-insights report`)
plus any commands contributed by *enabled* plugins.

## Testing

The full manual smoke-test checklist (macOS + iOS, run before each release)
lives in [`docs/SMOKE-TEST.md`](docs/SMOKE-TEST.md).

## Spec & Plan

- Designs: `docs/superpowers/specs/`
- Plans: `docs/superpowers/plans/`

## License

Apache-2.0 (consistent with `@moraya/core`).
