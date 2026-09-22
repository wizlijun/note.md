# note.md

[English](README.md) · [简体中文](README.zh-CN.md) · [notemd.net](https://notemd.net)

> **Read what AI writes. Keep what you think. Keep what only *you* can write.**

A markdown reader, editor, and bidirectional-linking notes tool designed for
people and AI agents to work in the same files. Desktop app for macOS 13+
(Apple Silicon and Intel) and Windows 10/11 x64. The signed macOS build is
~12 MB to download and ~19 MB installed. Your notes are a folder of plain
`.md` files on your disk — forever.

[Download](https://notemd.net/download) · [Plugins](https://plugins.notemd.net) · [Full feature list](docs/FEATURES.md)

---

## 1. The best place to read what your agents wrote

Rich view and source view, one keystroke apart. Import Typora-compatible
themes. Mermaid, Graphviz, and KaTeX all tuned and lazily loaded.
No bundled Chromium — the current macOS app installs at ~19 MB.

Highlight a claim, leave a question in the margin, fix the sentence right
where it's wrong.

Claude, Codex, OpenClaw each have their own chat window. None of them is a
place to *read*. This is.

## 2. Everything the last generation got right, built in

Local-first. Git sync. Outliner. `[[wikilinks]]` and backlinks. Wiki pages.
Daily notes. Full-vault search. JSON Canvas. A plugin system.

Roam Research and Obsidian figured these out. note.md ships them on files:
Roam Research Sync initializes from a full graph export and can then keep
changed pages in sync, while an Obsidian vault opens directly.

## 3. Agent-ready by design. Use the AI you already have.

Built-in agent workflows use the agents, AI subscriptions, API accounts, or
local runtimes you already have. note.md sells no tokens, adds no token markup,
and charges no separate per-token fee.

Model usage still follows the plan, limits, and billing of your chosen
provider—or uses your own local compute.

Your vault is designed to be the shared, version-controlled context that many
agents and many harnesses work in — Claude Cowork, Claude Code, Codex,
DeepSeek, ChatGPT Work, OpenClaw, Hermes — through public conventions (`AGENTS.md`,
block citations, sidecar `.note.md`). Memory follows the same contract:
agents can suggest what matters, but only you decide what becomes lasting
context. The more you leave in the vault, the better every agent knows you.

Switch AI tools whenever you like. The asset stays yours, without adding a
second token meter from note.md.

Specifically tuned for building products with Claude Code: writing docs,
reading docs, and reviewing what the AI generated.

## 4. Memory discovered by agents. Confirmed by you.

What an agent most needs to know about you is exactly what no model can guess:
how you work, what you prefer, what you have decided, and where your boundaries
are. Asking you to maintain another profile only moves the work back to you.

Memory takes the opposite approach. An agent finds a small number of candidate
memories in the work and conversations you bring into your vault. You review
them one at a time: confirm, reject, mark important, or ignore. An inference
never becomes trusted memory on its own.

Search and Memory stay separate. Search helps an agent find anything you
wrote; Memory gives it the small set of claims you approved. They remain plain,
Git-tracked files that work across agents and models. [Why we built personal AI
memory this way](https://notemd.net/blog/personal-ai-memory/).

## 5. Whatever else you need, grow it yourself

Write a plugin. Wire an OpenClaw cron job. Hang skills off it.

Put a `?` in an annotation and an agent picks it up: it revises the document
asynchronously, fills in the context you asked for, and hands it back for you
to accept — or not.

The rest is yours to discover.

---

## Recently shipped · v6.904–v6.921

- **More ways to read the same files.** A read-only table of contents follows
  your position in long documents. Plugin file views sit beside Rich and
  Source with a safe editor fallback: Timeline renders daily schedules, Index
  Viewer turns `*.index.md` into tables, boards, lists or cover galleries,
  Knowledge Browser opens supported JSON datasets as an interactive graph,
  and Typeset Reader progressively paginates `*.typeset.md` books with Typst.
- **More sources, still under your control.** Apple Notes Sync mirrors Notes
  into readable, read-only Markdown on macOS; Roam Research Sync keeps pages
  and daily notes current; Meetings incrementally archives Hemory transcripts;
  and Assistant Mail stores admitted messages as raw mail plus integrity
  metadata in a configurable Vault archive. Each workflow keeps its own
  conflict, recovery and deletion boundary.
- **A better working surface.** Standard `.canvas` files now open as an
  Obsidian-compatible infinite canvas with lasso selection, snapping,
  alignment, grouping and multi-selection resize. New notes and canvases open
  immediately in the Vault and receive a date-and-title filename when saved.
  Valid JSON is formatted into readable source lines without changing its
  values, and `readonly: true` is enforced across every editing path.
- **Smarter retrieval, explicit approval.** Smart Lookup resolves conservative
  time windows before searching and hands results to enabled Agents. Memory
  adds role/scope governance and governed coauthoring where isolated Agents
  submit reviewable changes. Conversation Transcript Corrections turns
  evidence from conversations you participated in into context-specific name
  and ASR corrections; Agents may propose, but only you can approve.
- **Plugins update in place.** Installing, updating, enabling, disabling or
  removing a plugin refreshes its commands, menus and open views without an
  app restart. See the [changelog](CHANGELOG.md) for release-by-release detail.

---

## Five convictions

1. **AI text is infinite; your attention isn't — your judgment is the residue.**
   What you leave in the margins is the one thing no model can generate.
2. **Files over app.** Every note is a plain `.md`: git-friendly, greppable,
   readable in fifty years. Indexes are derived; files are the only truth.
3. **Agents are first-class citizens — they suggest, you confirm.**
   [The graph grows only where you confirm it](docs/product-principle-relationships-only-grow-where-confirmed.md);
   note.md never auto-connects your notes or turns an agent's guess into trusted
   memory. [The same human checkpoint governs personal AI memory](https://notemd.net/blog/personal-ai-memory/).
4. **[Your marks belong to the vault, not to a path.](docs/product-principle-mirror-hosted-marks.md)**
   Annotate a file from anywhere and it's mirrored in, so your marks get a
   stable, git-versioned host.
5. **[One vault, many agents — you orchestrate.](docs/product-principle-one-vault-many-agents-you-orchestrate.md)**
   The workers are interchangeable. You hold the pen.

## Strictly OKF v0.2

Conviction 2 needs a format, not just a file extension. note.md follows the
[Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)
(OKF) v0.2 — Google Cloud's open spec for knowledge that humans and agents
exchange: plain Markdown, YAML frontmatter, diffable, portable.

- **Everything it writes conforms.** Every document note.md creates opens
  with YAML frontmatter carrying the required `type` — ⌘N notes, `.note.md`
  sidecars, daily notes, wiki pages, Roam and e-book imports, generated
  reports. Existing outline notes get their `type` filled in the next time
  you save one; a plain `.md` you brought from elsewhere is left exactly as
  it is — no app cruft injected into your files, ever.
- **Provenance in the spec's vocabulary.** Source, trust and lifecycle use
  OKF's own fields — `sources`, `generated`, `verified`, `status`,
  `stale_after` — and its actor forms, `<producer>/<version>` for a tool,
  `human:<id>` for a person, `process:<id>` for automation. So "a human
  confirmed this" becomes machine-readable, not a hunch.
- **Everything it reads is tolerated.** A missing optional field, an
  unfamiliar `type`, unknown extra keys, a dead link — none of these ever
  cause a document to be rejected, and keys note.md doesn't understand
  survive a round trip untouched. That's OKF's tolerant conformance, and the
  spec makes it a MUST.
- **Checked, not claimed.** `pnpm okf:lint <dir>` audits any folder against
  the spec's three hard constraints; every path that writes a document is
  tested against it.

Your agents get the same contract: the vault's `AGENTS.md` spells out the OKF
requirement, so anything working in that folder writes conformant files too.
The app now records human authorship in `generated` / `verified` where it has
the evidence to do so, and bundle export writes `index.md`, `log.md` and
portable links. Remaining read-side presentation and attestation work is
tracked in the [conformance audit](docs/okf-v0.2-conformance-audit.md).
Format details: [`docs/okf-v0.2-format-constraints.md`](docs/okf-v0.2-format-constraints.md).

## Written by AI, answered for by a human

note.md is developed and maintained entirely by AI coding, so releases come
fast. The maintainer is a career software engineer; every change is reviewed,
tested, and smoke-run before it ships.

## Under the hood

Built with [Tauri](https://tauri.app) on
[`@moraya/core`](https://www.npmjs.com/package/@moraya/core): a native Rust
desktop binary with native menus / windows / tray and an editor UI rendered in
the operating system WebView, not a bundled browser. The macOS `.app` is
code-signed and notarized; Windows uses the system WebView2 runtime.

The product name is **note.md** (all lowercase — a note that *is* a plain
markdown file). The CLI binary and bundle identifier are `notemd` /
`net.notemd.app`; the legacy `mdedit` symlink still works. You'll still see
`mdeditor` in the source tree (the Rust crate is `mdeditor_lib`). Versions
before v4.8.0 shipped as **M↓**.

## Develop & build

```bash
corepack enable             # project pins pnpm 11.7.0
git clone https://github.com/wizlijun/moraya-core.git ../moraya-core
pnpm install
pnpm tauri dev            # develop
pnpm tauri build          # build, current arch
```

Both architectures (each its own `.app`; universal mode is retired):

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm tauri build --target aarch64-apple-darwin
pnpm tauri build --target x86_64-apple-darwin
```

Output: `src-tauri/target/<arch>-apple-darwin/release/bundle/macos/note.md.app`
(or `src-tauri/target/release/…` for the current arch).

The repository currently depends on a sibling `../moraya-core` checkout.

On Windows, install Node.js with Corepack, the Rust MSVC toolchain and WebView2, then run
the same `pnpm install` / `pnpm tauri dev` / `pnpm tauri build` commands. The
NSIS installer is written under
`src-tauri/target/<arch>-pc-windows-msvc/release/bundle/nsis/`.

## CLI

```bash
notemd search "query" --vault ~/Vault      # full-text search, prints path:line:text
notemd search "query" --json               # hits with source_ref, origin, provenance, attention_minutes (desktop-recorded)
notemd search "query" --all                # every hit (default cap: 20; --limit N adjusts)
notemd share draft.md                      # publish a share link, prints URL
notemd share draft.md --json               # structured output
notemd share draft.md --unshare            # remove the share
notemd plugin list                         # all plugins and their status
notemd meetings-sync --dry-run             # preview incremental Hemory import
notemd apple-notes-sync --dry-run           # preview Apple Notes sync (macOS)
notemd mail-sync                            # pull admitted Assistant Mail
notemd reading-insights report --vault ~/Vault --date 7d
notemd doctor                              # self-check env, vault, index, plugins, network (--offline, --json)
notemd help                                # full reference
```

Built-in core commands plus anything contributed by *enabled* plugins.
Install from **Help → Install 'notemd' Command in PATH…**.

`notemd search` is the one agents reach for. It is grep-shaped on purpose, so
`rg` habits carry over, and `--json` returns `source_ref` (`path#Lline`)
alongside each hit's provenance — a hit written by a model says so, and can be
followed to the primary document instead of trusted. Filters use the same
grammar as the app's search panel (`tag:` `type:` `path:` `ext:` `after:`
`before:` `page:[[X]]` `origin:`). See `notemd help search`.

## MCP, for agents that don't shell out

note.md also speaks [MCP](https://modelcontextprotocol.io) over stdio, so an
agent can call `search` / `vault_info` as tools instead of shelling out to
`notemd search`. Both are read-only, and hit the same warm index the CLI and
the app already share.

Register it in your agent client's config:

```json
{"command": "notemd", "args": ["mcp"]}
```

No TCP port: the shell talks to the running note.md process over a local
socket (a Unix domain socket on macOS/Linux, a named pipe on Windows), never
the network. On by default — switch it off in Settings if you'd rather not
run it.

## Release (maintainers)

```bash
scripts/release.sh [x.y.z] [--draft|--prerelease]
```

Tests → version bump → signed per-arch builds → notarize → tag → push →
GitHub Release (two `.dmg`s, two updater tarballs + signatures, and a
`latest.json` manifest driving per-arch auto-update). Windows packages are
then added to the same tag with `scripts/release-windows.ps1`. Requires `APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID` in `.env.release` and the updater key at
`~/.tauri/mdeditor.key`.

## Docs

- Full feature list: [`docs/FEATURES.md`](docs/FEATURES.md)
- Knowledge-document format (OKF v0.2):
  [`docs/okf-v0.2-format-constraints.md`](docs/okf-v0.2-format-constraints.md)
  · [conformance audit](docs/okf-v0.2-conformance-audit.md)
- Writing plugins: [`docs/plugin-v2-development.md`](docs/plugin-v2-development.md)
- Designs & plans: `docs/superpowers/specs/`, `docs/superpowers/plans/`

## Thanks

To [**Effie**](https://www.effie.pro/) and
[**Hulunote**](https://github.com/hulunote/hulunote) — for their support and
encouragement, and for showing what a distraction-free writing tool and an
open-source bidirectional-linking outliner can be. The bundled **effie** theme
is a nod to the former.

Thanks also to [**Huabu**](https://github.com/microsoft/Huabu), an infinite
workspace for people and agents to think together. note.md's canvas visual
design and editing interactions draw on Huabu, including lasso selection,
smart snapping, alignment and distribution, multi-selection resizing, and
contextual toolbars.

## License

Apache-2.0 (consistent with `@moraya/core`).
