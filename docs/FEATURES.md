# note.md — full feature list

[English](FEATURES.md) · [简体中文](FEATURES.zh-CN.md) · [← README](../README.md)

Everything note.md does today, in detail. The README keeps the pitch; this file
keeps the receipts.

## The notes layer

The agent-ready notes system, rolling out incrementally:

- [x] **Sidecar notes** — highlights and comments made while reading
      `xxx.md` are saved to a companion `xxx.note.md`. The source stays
      pristine and regenerable; your judgment becomes permanent, searchable
      data. A `.note.md` with no sibling source file is a standalone note.
- [x] **Outline editor** — every `.note.md` opens in a Roam-style outline
      view (never the plain markdown editor); outlines persist as nested
      markdown lists, so the files stay readable everywhere.
- [x] **Daily notes** — a dedicated Daily Notes window with an infinite
      lazy-loading feed of `dailynote/yyyy/yyyy-MM-dd.note.md`, one keystroke
      or tray click away; `[[yyyy-MM-dd]]` is the canonical date link and
      `[[page]]` links open inline.
- [x] **Roam Research Sync** — keep using Roam while gathering pages and daily
      notes into the vault for agent search and computation. The built-in
      plugin supports ongoing CLI synchronization plus a whole-graph JSON
      import, with date-page rewriting to `[[yyyy-MM-dd]]` and a broken-link
      report.
- [x] **Annotation Q&A loop** — an annotation containing `?` becomes a question
      for your agents; the `.note.md` carries the state machine, an external
      agent sweeps it, and answers come back as `type:: answer` nodes you can
      accept into the document. Agents never write into the source `.md`.
- [x] **Wiki pages** — standalone outline notes under a configurable
      `wikipage/` folder, one `[[title]]` namespace across the whole vault.
      Search knows about them: the page a `[[…]]` would create is pinned to
      the top when you type its name exactly.
- [x] **Global index** — full-vault instant search, ranked by provenance,
      rebuilt from files at any time (the index is derived data; the files
      are the only source of truth). Query grammar: `tag:` `type:` `path:`
      `ext:` `after:` `before:` `page:[[X]]`
      `origin:human|derived|source|unlabeled`, and quoted phrases. Raw
      material (`.srt`/`.vtt`/`.txt` transcripts) is indexed inside folders
      you designate. Renames and moves are recognised by content hash, so
      renaming a directory updates paths instead of rebuilding every file.
      Headless too — see `notemd search` under *Built for agents*.
      (Backlinks and linked references already work across `.note.md`.)
- [x] **Smart Lookup** — `Cmd/Ctrl+K` turns a natural-language request into a
      validated local search plan, separating dates, paths, tags, types, and
      provenance from the actual query. Matching notes and source previews
      appear first; quick summaries and a handoff to Claude, Codex, or
      DeepSeek remain explicit actions. Time-sensitive questions are resolved
      against a frozen local date and timezone before retrieval.
- [x] **Controlled personal Memory** — agents may discover and propose durable
      claims, but only the user can confirm, reject, mark important, or ignore
      them. Role and Scope registries keep identities and work contexts apart;
      authoritative revisions live under `.notemd/memory/`, while `USER.md`
      and `MEMORY.md` are rebuildable, human-readable projections. Memory also
      provides a governed co-writing workspace with stable block identities,
      exact-version review, recoverable drafts, and human acceptance of agent
      suggestions.
- [x] **Local Vault MCP server** — `notemd mcp` speaks MCP over stdio and
      exposes the read-only `search` and `vault_info` tools. It uses the same
      warm index as the app and CLI, reaches the running app only through a
      local socket or named pipe, opens no TCP port, and can be disabled in
      Settings.

## Reading & annotating

- **Rich reading view** — KaTeX math, Mermaid diagrams, Graphviz (` ```dot ` /
  ` ```graphviz `), highlight.js code blocks; HTML files open in a sandboxed
  iframe preview; ~36 code file types render as syntax-highlighted blocks;
  images open as preview tabs. Renderers load on demand, so a document without
  diagrams costs nothing.
- **Highlight mark** (`^^text^^` or `==text==`) — yellow highlight in both
  modes; `Cmd+H` in source view wraps the selection.
- **Inline annotations** — CriticMarkup-based comments and questions anchored
  in the text, mirrored into the sidecar outline, with `✦` for what AI wrote
  and `●` for what you thought.
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
- **Table of contents** — a read-only outline of the current Markdown
  document, including unsaved headings. Click to jump to a section; while
  scrolling in rich or source view, the active heading follows the reading
  position, including when headings have duplicate text.
- **Typeset books** — the optional Typeset Reader turns `*.typeset.md` into
  cached, paginated Typst pages. Large books become readable after the first
  batch while later pages continue rendering; CJK books automatically use a
  suitable book template, with a persistent template override and zoom in the
  page context menu.

## Writing & editing

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
  YAML metadata card**, **line-break fidelity** across export / share. The
  card recognises wikilinks, Markdown links, bare URLs, and scalar lists while
  reading, without changing the source text.
- **Paste anything** — screenshots land in `{docname}_files/` with relative
  links; files paste as attachment links; images get a click-to-resize
  toolbar (25 / 50 / 75 / 100 %).
- **Context menu** — a full custom right-click menu in both source and rich
  modes.
- **CSV spreadsheet editor** — `.csv` opens as a live grid with formulas
  (`=SUM(A1:A3)`, cross-cell refs), row/column ops, dark-mode themes; a
  `/spreadsheet` slash command embeds a grid inside markdown.
- **Find & Replace** (`Cmd+F` / `Cmd+H`) with regex, whole-word, and
  case-sensitive options, in both modes.
- **Readable JSON source** — entering Source for a valid `.json` expands
  compact content with two-space indentation while preserving key order,
  duplicate keys, number spelling, and escapes. Invalid JSON and JSONC stay
  untouched; formatting is an ordinary unsaved edit.
- **Source-controlled read-only documents** — top-level `readonly: true`
  prevents Rich, Source, metadata, save, overwrite, Save As, and history
  restore from changing a Markdown file, while its external synchronizer may
  still refresh an open document.
- **New file** (`Cmd+N`) and tray Quick Note create a blank temporary Markdown
  document directly in the Vault's configured inbox. On manual save, an
  unnamed document becomes `YYYY-MM-DD-title.md`, or a timestamped fallback;
  existing names are never rewritten and collisions receive a number.

## Your files & vault

- **Folder View** — a live directory tree sidebar with recursive regex
  filtering and *Reveal in Finder*; global sort, per-folder pinning, and view
  modes (all / files / with-notes / markdown-by-H1 / notes).
- **Switchable side panels** — a registry of left/right sidebars with a
  title-bar switcher.
- **JSON Canvas workspace** — create and edit standard, Obsidian-compatible
  `.canvas` files with text, file/image, link, and group cards; labelled
  connections; pan/zoom, lasso and box selection; snapping, alignment and
  distribution; multi-selection resizing; contextual tools; copy/paste; and
  undo/redo. Unknown JSON Canvas fields survive round trips, and protected
  atomic saves, auto-save, and external-change handling keep the file safe.
  New canvases start as `Vault/canvas/untitled.canvas` and receive a date plus
  title (or time) name on manual save.
- **External change detection** — clean tabs reload silently; dirty tabs get
  a conflict banner (reload / overwrite / recreate on delete). Never silent
  data loss.
- **Sync to Vault** — copy any file into your git-synced vault with
  date-prefixed naming, source ↔ copy mapping, and conflict-aware refresh.
  Annotating a file outside the vault mirrors it in, so your marks always have
  a stable, git-versioned host.
- **Large-file gate** — files above a configurable threshold stay in the
  working tree instead of entering a vault commit; the tray shows the state.
- **Tabs** with dirty indicators and drag-to-reorder; right-click actions to
  close the current tab, tabs to its left, or all tabs (with save prompts
  preserved); **auto-save** (opt-in); **recent files**; Finder double-click /
  drag-to-open.

## Built for agents

- **Block citations** — `((file#b-xxxxxx))` gives agents a stable way to
  quote and follow passages across the vault.
- **`AGENTS.md` conventions** — the vault's rules live in plain text at its
  root, which every CLI agent already reads.
- **`notemd search`** — retrieval for agents, grep-shaped: default output is
  `path:line:text`, one hit per line, so `rg`/`grep` habits keep working.
  `--json` adds `source_ref` (`path#Lline`), `origin`, provenance
  (`agent_by`, `human_verified`) and `attention_minutes` (decayed minutes of
  the user's own reading/editing attention on that document, 0 = no data,
  already factored into ranking — ingested by the desktop app, so it reads 0
  on a machine where the GUI has never opened this vault) — a hit written by a
  model says so, and an
  agent can follow it to the primary document instead of trusting it. Exit
  codes distinguish "no hits" (1) from "no vault" (2), and retrieval never
  hard-fails: an unusable index or an over-budget freshness check degrades to
  a direct file scan with one line on stderr. Default cap is 20 hits;
  `--limit N` adjusts it and `--all` returns everything.
- **`notemd doctor`** — self-check the local setup: environment, Vault,
  search index, plugins, and network reachability (`--offline` skips
  network checks, `--json` for machine-readable output).
- **`notemd` CLI** — drive plugin features without the GUI:
  `notemd share draft.md` publishes a share link; `--json` for structured
  output; `notemd reading-insights report` writes engagement digests;
  enabled plugins add commands such as `meetings-sync`, `apple-notes-sync`,
  and the read-only / proposal operations for Memory, mail, and transcript
  corrections. Operational commands keep note.md available in the background
  without opening or focusing an extra window.
  Install from **Help → Install 'notemd' Command in PATH…**.
- **Two distinct MCP surfaces** — the local `notemd mcp` endpoint provides
  read-only Vault search and information; the optional share Worker exposes a
  separate MCP endpoint for publishing documents on your behalf.
- **Plugin system (v2)** — out-of-process plugins over stdin/stdout JSON *plus*
  isolated-webview UI plugins, with declarative manifests (menus, context
  menus, settings panels, sidebars, tray items, CLI subcommands) and
  capability-gated host actions; dormant until invoked. Plugins may also
  declare file views selected by extension, filename, path, or frontmatter;
  these appear beside Rich and Source, with a built-in-editor fallback on
  failure. Installing, updating, enabling, disabling, or removing a plugin
  reloads its runtime, menus, shortcuts, and open views without restarting.
  Browse and install from the in-app marketplace
  ([plugins.notemd.net](https://plugins.notemd.net)). Writing your own:
  [`plugin-v2-development.md`](plugin-v2-development.md).

## Official plugins & file views

- **Memory 2.5.2** *(note.md 6.906.1+)* — the controlled personal Memory and
  governed co-writing workspace described above.
- **Meetings 1.0.3** *(macOS; note.md 6.906.2+)* — safely migrate Hemory
  conversations, or incrementally archive new and changed speaker-attributed,
  time-coded transcripts with `notemd meetings-sync`; dry runs, checkpoints,
  journals, and conflict reports protect local edits, and audio is never
  copied.
- **Timeline 1.0.4** *(note.md 6.909.4+)* — render Markdown with
  `type: timeline` as a vertical daily schedule with overlapping events,
  configurable categories, date navigation, and a configurable opening time.
- **Index Viewer 1.0.2** *(note.md 6.910.1+)* — render `*.index.md` as a cover
  gallery, multi-column table, grouped list, or swimlane board. Heading
  hierarchy supplies categories; one-line list attributes, tags, wikilinks,
  and relative file links remain portable Markdown.
- **Ebook Import 1.5.0** *(macOS; note.md 6.910.1+)* — import books with
  metadata and covers from Open Library plus Apple Books fallback, maintain
  live gallery indexes, AI reading notes, and topic organization, and write
  new book bodies as `book.typeset.md` while retaining compatibility with
  existing `book.md`.
- **Assistant Mail 0.1.6** *(macOS; note.md 6.912.1+)* — pull approved mail
  from a dedicated Worker into a portable Vault archive of paired `.eml` and
  integrity JSON files. The trusted UI provides sanitized, sandboxed HTML
  previews; Agent CLI commands disclose only bounded metadata, and deletion
  requires a reviewed plan.
- **Apple Notes Sync 1.0.4** *(macOS; note.md 6.915.1+)* — mirror Apple Notes
  accounts and nested folders into readable, source-controlled Markdown under
  `applenotes/`, with attachments, manual or five-minute automatic sync,
  journal recovery, protected deletions, and stable identities kept centrally
  in `applenotes/id-sync.json`.
- **Knowledge Browser 3.2.0** *(note.md 6.916.1+)* — open supported extracted
  knowledge JSON directly in the editor as an interactive graph, relation
  groups, timeline, reading view, or diagnostics. It preserves multi-party
  relationship roles and source evidence without changing the dataset.
- **Conversation Transcript Corrections 0.1.9** *(macOS; note.md 6.916.1+)* —
  review formal names, aliases, and ASR mistakes from conversations in which
  the user participated, merge entries across public contexts, and apply
  approved replacement or preservation rules per context. Agents may query or
  propose drafts, but cannot approve them; an optional
  `build-conversation-dictionary` Skill prepares review datasets.
- **Typeset Reader 0.1.1** *(macOS; note.md 6.921.2+)* — the progressive Typst
  view described above, integrated with Ebook Import 1.5.0.
- The marketplace also includes **Roam Research Sync**, **Base** (Obsidian
  `.base` tables), **Weekly Review**, **Decision**, Claude / Codex / DeepSeek
  Agents, **OpenClaw Chat**, md→PDF, and more.

## Share & export

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

## The app

- **Four-language UI** — English, Deutsch, 简体中文, 日本語 — covering dialogs,
  native desktop menus, the tray, and plugin strings; switch live in
  Preferences, no restart.
- **Typora-compatible themes** — import any Typora theme `.zip`; pick
  separate light / dark themes that follow macOS Appearance. Ships with
  **default** (GitHub-style) and **effie** (mint-paper, LXGW WenKai).
- **Menu-bar tray**, Typora-style notification bar, full-UI zoom
  (`Cmd+=` / `Cmd+-` / `Cmd+0`).
- **macOS 13+ and Windows 10/11 x64** desktop builds. macOS ships signed and
  notarized Apple Silicon and Intel `.dmg`s with per-architecture auto-update;
  Windows uses its own installer and can trail the macOS release while its
  package is produced.
