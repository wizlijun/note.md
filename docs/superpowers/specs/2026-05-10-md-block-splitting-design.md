# Markdown Block Splitting & Stable Block IDs — Design

**Status**: Brainstorm complete; pending implementation plan
**Date**: 2026-05-10
**Owner**: bruce@hemory.com
**Reference implementation studied**: `qmd` (`/Users/bruce/git/qmd/src/store.ts`,
`src/ast.ts`, `test/store.test.ts`)

## Goal

Add a system for assigning **stable, edit-resilient block ids** to every
section of a markdown document so that AI tools can cite individual passages
of M↓-edited documents at sub-page granularity.

The system produces three artifacts per document:

1. The original `<basename>.md` — never mutated by this system
2. A sidecar `<basename>.block.yaml` — id ↔ block metadata + full lineage
3. A generated `<basename>.block.md` — same content with HTML anchor lines
   inserted before each block, suitable as input to an LLM

When AI output cites `((<doc-uri>#b-7f3a9c))`, M↓ resolves the citation back
to a precise position in the source `.md`, even after the document has been
edited many times. Citations to retired ids follow a lineage chain to the
current location of the content.

## Non-goals (v1)

- ❌ Built-in LLM client / chat — M↓ produces inputs and consumes citation
  outputs; the AI itself runs externally (Claude Code, ChatGPT, etc.)
- ❌ Real-time per-keystroke chunking — re-chunking is an explicit user action
  or opt-in `onSave` hook
- ❌ AST-aware chunking for code files — markdown only (qmd's tree-sitter
  path is not ported)
- ❌ Token-precise sizing via a real tokenizer — char-based approximation only
- ❌ Per-block embedding / search / RAG — that's qmd's job; M↓ stays an editor
- ❌ frontmatter as a citable block — frontmatter is preserved but not chunked
- ❌ Cross-tool URI schemes (`qmd://`, `file://`) in citations — first version
  resolves local relative/absolute paths only
- ❌ Editing the generated `.block.md` — it is a build artifact, regenerated
  whole

## Brainstorm decisions (locked)

| # | Decision | Rationale |
|---|---|---|
| Q1 | Goal: stable block ids for AI source attribution | Drives all later choices toward identity stability over algorithmic novelty |
| Q2 | Block granularity: **D** (qmd-style size-bounded with break-point scoring) | User chose; enables sub-paragraph precision when needed |
| Q3 | ID stability: **B** (content fingerprint + best-match merge) with **git-merge semantics** | Heavy edits should preserve as many ids as possible; historical citations should remain resolvable |
| Q4 | YAML depth: **B** (full append-only lineage) | Any historical id ever issued must be resolvable to its current location or "deleted" status |
| Q5 | Anchor format: **Y** (separate anchor line + dual-coordinate yaml) | Universal renderer compatibility; source `.md` never mutated |
| Q5b | Citation syntax: `((pageuri#blockid))` (Logseq/Roam-style with URI prefix) | User-specified; parseable, distinct, navigable |
| Q6 | Integration: built-in plugin `mdblock` + sister visualization plugin `mdblock-hover` | Aligns with existing share/md2pdf pattern; opt-in; doesn't clutter every `.md` |
| Q6a | Trigger: explicit `Cmd+Shift+B` + optional auto-refresh on save | Default off; user enables per-document |
| Q6b | Scope: only documents with existing `.block.yaml` get auto-tracking | Opt-in via "Compute Blocks" command |
| (c) | Old block text storage: **X2** (inline normalized text in yaml) | Self-contained; merge stays offline-capable; ~1.3× source size is acceptable |
| (c) | history text retention: only recent N or near-distance retired blocks keep `text` | Bounds yaml growth |
| (c) | `.block.yaml` checked into git; `.block.md` gitignored | Yaml is the shared id source of truth; md is a build artifact |

## Design

### (a) Splitting algorithm — `src/lib/blockchunk/`

Pure functions, no IO, browser-safe. Direct port of qmd's chunking core to TS.

**Constants** (defaults; configurable per document via yaml `config:`):

```ts
export const CHUNK_SIZE_TOKENS    = 600;           // ~75% of qmd's 900 — finer attribution
export const CHUNK_OVERLAP_TOKENS = 0;             // ★ no overlap (different goal from qmd's RAG)
export const CHUNK_SIZE_CHARS     = 2400;          // 4 chars/token approximation
export const CHUNK_WINDOW_CHARS   = 800;
```

**Public surface**:

```ts
export interface BreakPoint    { pos: number; score: number; type: string }
export interface CodeFenceRegion { start: number; end: number }
export interface Block           { text: string; src_pos: number; src_line: number }

export function scanBreakPoints(text: string): BreakPoint[];
export function findCodeFences(text: string): CodeFenceRegion[];
export function isInsideCodeFence(pos: number, fences: CodeFenceRegion[]): boolean;
export function findBestCutoff(
  breakPoints: BreakPoint[],
  targetCharPos: number,
  windowChars?: number,
  decayFactor?: number,
  codeFences?: CodeFenceRegion[],
): number;
export function chunkDocumentWithBreakPoints(
  content: string,
  breakPoints: BreakPoint[],
  codeFences: CodeFenceRegion[],
  maxChars?: number,
  overlapChars?: number,
  windowChars?: number,
): { text: string; pos: number }[];
export function chunkDocument(content: string, ...): Block[];
export function mergeBreakPoints(a: BreakPoint[], b: BreakPoint[]): BreakPoint[];
```

**Break point patterns** (identical scores to qmd):

| type | pattern | score |
|---|---|---|
| h1–h6 | `\n#{1..6}(?!#)` | 100/90/80/70/60/50 |
| codeblock | `\n```` | 80 |
| hr | `\n(?:---\|\*\*\*\|___)\s*\n` | 60 |
| blank | `\n\n+` | 20 |
| list | `\n[-*]\s` | 5 |
| numlist | `\n\d+\.\s` | 5 |
| newline | `\n` | 1 |

**Algorithm** (qmd verbatim, slight surface tweak):

```
charPos = 0
while charPos < content.length:
  target = min(charPos + maxChars, content.length)
  end    = findBestCutoff(breakPoints, target, windowChars, 0.7, codeFences) or target
  push({ text: content.slice(charPos, end), pos: charPos, line: lineOf(charPos) })
  if end == content.length: break
  charPos = end - overlapChars            # 0 in our case
  if charPos <= last.pos: charPos = end   # forward-progress safety
```

`findBestCutoff` uses qmd's squared distance decay (`1 - (d/window)² × 0.7`) with
the result that headings far back beat low-quality breaks near the target.

**Differences from qmd**:

1. `CHUNK_OVERLAP_TOKENS = 0` — block ids must be 1:1 with content; overlap
   would split a paragraph's identity across two ids
2. Output type adds `src_line` (1-based) — useful downstream; computed once
3. No `chunkDocumentByTokens` — char-based suffices; no tokenizer dependency
4. No `chunkDocumentAsync` / AST — markdown only

**Future-extensible** (out of scope v1, but architecture allows):

- KaTeX `$$...$$` blocks treated like code fences (no internal splitting)
- Mermaid fences already covered by code-fence logic
- frontmatter excluded at the IO layer, not the algorithm

### (b) Block identity & merge — `fingerprint.ts` + `merge.ts`

**Fingerprint**:

```ts
export interface BlockFingerprint {
  hash: string;     // SHA-256 of normalized text, truncated to 12 hex chars
  shingles: string; // sorted serialization of 5-gram set, for Jaccard
  length: number;   // normalized character count
}

export function computeFingerprint(text: string): BlockFingerprint;
export function jaccard(a: BlockFingerprint, b: BlockFingerprint): number;
```

**Normalization**: lowercase + collapse whitespace + trim + retain structural
markers (`#`, `-`, `>`, fence markers) since they encode block type.

**Merge — 5 passes**:

```ts
export interface MergeOutcome {
  kept:    { newIdx: number; oldId: string }[];                          // hash equal
  edited:  { newIdx: number; oldId: string; similarity: number }[];      // ≥ threshold
  splits:  { newIdx: number; oldId: string; siblings: number[] }[];      // 1 old → many new
  merges:  { newIdx: number; oldIds: string[] }[];                       // many old → 1 new
  fresh:   { newIdx: number }[];                                         // no antecedent
  retired: { oldId: string; replacedBy: string[] }[];                    // dropped or merged out
}

export function mergeBlocks(
  oldBlocks: { id: string; fp: BlockFingerprint; text: string }[],
  newBlocks: { fp: BlockFingerprint; text: string }[],
  threshold?: number,             // default 0.5
  splitCoverage?: number,         // default 0.3
): MergeOutcome;
```

| Pass | Purpose | Effect |
|---|---|---|
| 1 — exact hash | Detect untouched blocks | 1:1 kept; both pools shrink |
| 2 — Jaccard ≥ T | Detect minor edits | 1:1 edited; new inherits old's id |
| 3 — split detection | Old → multiple new | Highest-coverage new inherits id; siblings get fresh ids with `parents: [old.id]` |
| 4 — merge detection | Multiple old → one new | New gets fresh id with `parents: [...]`; all old retired with `replaced_by: [new.id]` |
| 5 — residue | Anything left | Unmatched old → retired (deleted); unmatched new → fresh |

**Tiebreak for identical text** (e.g. two `## Section` headings): Pass 1
matches in document order — first old to first new.

**Edge: tiny blocks** (< 50 normalized chars): skip Pass 2 (Jaccard unreliable
on small shingle sets); rely on Pass 1 + Pass 5 position fallback.

**Stability promise**:

| Edit | ID behavior |
|---|---|
| Untouched | preserved (Pass 1) |
| Minor edits, ≥ 50% Jaccard | preserved (Pass 2) |
| Reorder | preserved (content-keyed, position-agnostic) |
| Split | one inheritor; siblings fresh with `parents` |
| Merge | new id; all parents retired with `replaced_by` |
| Rewrite > 50% | retired → fresh |

**ID allocator** — `id.ts`:

```ts
export function newBlockId(reservedIds: Set<string>): string;
// 'b-' + 6 random hex; collides against active∪retired; ≤3 retries
```

### (c) yaml schema — `src/lib/blockio/yaml-schema.ts` + `yaml-rw.ts`

**Location**: `<basename>.block.yaml` next to source file.

**Sections**: `meta` / `config` / `active` / `history`.

```yaml
meta:
  source: "my-doc.md"
  source_hash: "sha256:abc..."     # short SHA-256 of source .md
  generation: 47
  updated_at: "2026-05-10T03:42:11Z"
  schema_version: 1
  has_block_md: true               # whether .block.md was generated this round

config:
  chunk_size_chars: 2400
  break_window_chars: 800
  similarity_threshold: 0.5
  split_coverage_threshold: 0.3
  inject_ai_hint: true

active:
  # genesis block, never edited
  - id: b-7f3a9c
    src_line: 1
    src_pos: 0
    out_line: 1                     # only when has_block_md=true
    fingerprint:
      hash: "a1b2c3d4e5f6"
      length: 142
    text: |-
      # introduction
      this is the first paragraph of the document...
    parents: []
    created_gen: 1

  # block whose content has been edited multiple times across generations;
  # id is unchanged because each merge round saw similarity ≥ threshold
  - id: b-c91d22
    src_line: 24
    src_pos: 856
    out_line: 27
    fingerprint:
      hash: "f6e5d4c3b2a1"          # current hash; may differ from gen-1 hash
      length: 1893
    text: |-
      ## background
      ...current paragraph text...
    parents: []                     # never split or merged; clean inheritance
    created_gen: 1                  # birth generation; never bumped on inheritance

  # fresh block born from a split: a long paragraph at gen 46 was rechunked
  # into two; b-c91d22 (above) inherited the larger half, b-9a0d11 is the
  # smaller half whose lineage points back to the parent it diverged from
  - id: b-9a0d11
    src_line: 51
    src_pos: 2310
    fingerprint: { hash: "...", length: 612 }
    text: |- ...
    parents: [b-c91d22]             # spawned by Pass-3 split out of b-c91d22
    created_gen: 46

  # fresh block born from a merge: gen 47 combined b-aa11bb and b-cc22dd
  - id: b-44ee7a
    src_line: 80
    src_pos: 4920
    fingerprint: { hash: "112233445566", length: 980 }
    text: |- ...
    parents: [b-aa11bb, b-cc22dd]   # both ancestors retired this round
    created_gen: 47

history:                            # append-only; oldest first
  - id: b-aa11bb
    retired_gen: 47
    replaced_by: [b-44ee7a]
    last_fingerprint: { hash: "...", length: 410 }
    text: |-                        # retained because retired in last 5 gens
      ...
  - id: b-cc22dd
    retired_gen: 47
    replaced_by: [b-44ee7a]
    last_fingerprint: { hash: "...", length: 570 }
    text: |- ...
  - id: b-9f0e1d
    retired_gen: 23                 # too old for text retention; only fingerprint
    replaced_by: []                 # pure deletion
    last_fingerprint: { hash: "...", length: 88 }
```

**ID inheritance model** (resolves any ambiguity around `parents`):

- An id `b-XXX` is allocated **once**, on the generation a block first appears
  (`created_gen`). It is **never reissued** to different content.
- When merge Pass 1 (hash exact) or Pass 2 (Jaccard ≥ threshold) sees old → new
  with the same identity, the new block keeps `id = old.id` and
  `parents = []`. `created_gen` is unchanged.
- `parents` is non-empty **only** for blocks born by Pass 3 (split siblings —
  `parents = [the parent that was split]`) or Pass 4 (merged blocks —
  `parents = [all ancestors that contributed]`).
- Citations against any id ever issued — active or retired — must resolve.
  Active: direct hit. Retired: walk `replaced_by` forward to find the current
  carrier of that content.

**Persistence**:

- Atomic write: `*.tmp` → fsync → `rename`
- `js-yaml` with `noCompatMode: true, lineWidth: -1` (preserves long lines and
  block scalars)
- Corruption recovery: parse failure → rename `*.broken-<ts>` + log + treat as
  fresh chunking on next run

**`history[].text` retention policy**:

- Keep `text` for retired blocks where `retired_gen >= meta.generation - 5`
  (last five generations) **OR** `replaced_by` is empty (deletions, for
  forensic value)
- Older retired entries keep only `last_fingerprint` (hash + length)
- This bounds yaml growth at ~5 generations × current block count

**Git policy**:

- `.block.yaml` → committed (id source of truth)
- `.block.md` → `.gitignore`d (build artifact)

### (d) `.block.md` generation — `src/lib/blockio/inject.ts`

**File naming**: `<original-name>.block.md` (preserves original extension).
`note.md` → `note.block.md`; `note.markdown` → `note.markdown.block.md`.

**Anchor format** (validated CommonMark-compatible):

```
<a id="b-7f3a9c"></a>

<original block content>
```

Two lines per block: anchor + blank. The blank is mandatory — type-7 HTML
blocks in CommonMark only terminate at a blank line, so omitting it folds a
following `# Heading` into the HTML block.

**Algorithm**:

1. **Frontmatter**: if source matches `/^---\n[\s\S]*?\n---\n/`, lift it
   verbatim to top of output; chunker operates on the remainder; `src_pos` and
   `src_line` are offset accordingly.
2. **Sort active blocks** by `src_pos`. For each:
   - If `src_pos` falls at a line boundary (after `\n`): insertion point is
     `src_pos`.
   - Else (rare; only when chunker fell back to char-position split inside an
     unbroken line): retreat to nearest preceding `\n + 1`; this becomes
     `adjusted_pos`. Update yaml's `src_pos` and `src_line` to match.
3. **Splice**:

   ```
   for block in blocks:
     output += source.slice(prevEnd, block.adjusted_pos)
     output += `<a id="${block.id}"></a>\n\n`
     prevEnd = block.adjusted_pos
   output += source.slice(prevEnd)
   ```
4. **Compute `out_line`**: scan output, count `\n` up to each anchor, write
   into yaml.
5. **Optional AI hint** (`config.inject_ai_hint: true`): inject below
   frontmatter / above first block. The injected text substitutes the actual
   source basename; placeholders below are template syntax in the spec, not
   in the output:

   ```html
   <!--
     Each block in this document is preceded by an HTML anchor like:
       <a id="b-xxxxxx"></a>
     When citing a block from this document, use:
       ((${SOURCE_BASENAME}#b-xxxxxx))
   -->
   ```

   With `${SOURCE_BASENAME}` substituted to the actual filename (e.g.
   `my-doc.md`).

6. **Atomic write** to `<basename>.block.md`.

**Properties**:

- Pure function: same source + same active → same output bytes
- Read-only artifact: M↓ marks `.block.md` tabs read-only (or refuses to open
  them in source view; if opened, banner: "generated; edits will be discarded")
- Each block costs +2 output lines vs source — non-equal line numbers between
  `.md` and `.block.md`, by design (yaml carries both `src_line` and `out_line`)

### (e) `((pageuri#blockid))` parsing & navigation — `src/lib/blockio/citation.ts`

**Syntax** (regex):

```ts
export const CITATION_RE = /\(\(([^()#]*)#(b-[0-9a-f]{6})\)\)/g;
```

`pageuri` may be empty (same-doc), relative path, or absolute path. URI
schemes (`qmd://`, `file://`) are rejected in v1.

**Rendering**:

- Source view (textarea): unchanged raw text
- Rich view: `marked` extension produces an inline pill

```ts
marked.use({
  extensions: [{
    name: 'blockCitation',
    level: 'inline',
    start(src) { return src.indexOf('(('); },
    tokenizer(src) {
      const m = /^\(\(([^()#]*)#(b-[0-9a-f]{6})\)\)/.exec(src);
      if (!m) return;
      return { type: 'blockCitation', raw: m[0], pageuri: m[1], blockid: m[2] };
    },
    renderer(token) {
      const label = token.pageuri || '此处';
      return `<span class="block-citation"
                    data-pageuri="${escapeHtml(token.pageuri)}"
                    data-blockid="${token.blockid}"
                    title="跳转 ${token.pageuri || '同文档'} #${token.blockid}">→ ${escapeHtml(label)}#${token.blockid.slice(0,8)}</span>`;
    },
  }],
});
```

CSS lives in `editor-base.css` so all skins share pill styling. Retired
citations get `[data-status="retired"]`; deleted get `[data-status="deleted"]`
applied at hover-resolve time.

**`resolveCitation`**:

```ts
async function resolveCitation(
  pageuri: string,
  blockid: string,
  currentDocPath: string,
): Promise<{
  filePath: string;
  srcLine: number;
  status: 'active' | 'retired' | 'deleted';
  banner?: string;
}>;
```

1. Resolve `pageuri` to an absolute path (empty → current; relative → resolve
   against current's dir; absolute → as-is). Reject `..` traversal outside
   Tauri fs sandbox.
2. Locate the target's `.block.yaml` (sibling of the path).
3. Search `active` first; hit → return `{ srcLine, status: 'active' }`.
4. Search `history`; hit → walk `replaced_by` chain forward to an active
   block; return `{ srcLine, status: 'retired', banner: "原 block 已编辑，跳转到当前继承块 b-xxxxxx" }`.
5. Chain ends in `replaced_by: []` → return
   `{ status: 'deleted', banner: "原 block 已删除（在 generation N）" }`;
   no jump performed.

**Failure modes** (all non-fatal; toast + log):

| Cause | UX |
|---|---|
| Target file not found | toast: `引用的文件不存在: <path>` |
| `.block.yaml` missing | toast: `目标文档未启用块 id（无 .block.yaml）` |
| blockid not in active or history | toast: `引用的 block id 在目标文档中无记录` |
| yaml corrupted | toast: `目标文档的 block.yaml 解析失败` |

**Source-mode jump**: command `mdblock.followCitationAtCursor` (default
`Cmd+Enter`, scoped to `((..))` ranges). Implementation scans backward from
selectionStart for `((`, forward for `))`, regex-matches.

### (f) `mdblock-hover` visualization — `src/lib/mdblock-hover/`

A separate, in-process Svelte module gated by `settings.mdblock.hover.enabled`.
mdeditor's existing plugin protocol is out-of-process IPC and unsuited to UI
decoration; "plugin" here is a settings-toggleable subsystem, not a child
process.

**Module layout**:

```
src/lib/mdblock-hover/
├── line-block-map.ts          # active[] → Map<line, blockid>
├── source-gutter.svelte       # left rail in source view
├── rich-overlay.svelte        # absolute-positioned overlay over rich editor
└── hover-store.svelte.ts      # Svelte 5 runes; per-tab state
```

**Source view gutter**:

```
┌──────────┬──────────────────────────────────┐
│  b-7f3a9c│ # Introduction                   │
│    │     │ This is the first paragraph...   │
├──────────┼──────────────────────────────────┤
│  b-2e8b41│ ## Background                    │
└──────────┴──────────────────────────────────┘
```

- Block-start lines show full `b-xxxxxx`; continuation lines show a thin
  vertical bar
- Click on label → copy `b-xxxxxx` to clipboard
- Hover → highlight matching block's text background (CSS sibling selector)
- Scroll synced via `textarea.addEventListener('scroll', ...)` setting
  `gutter.scrollTop`
- Width fixed at ~84px; font / line-height match textarea via
  `getComputedStyle`

**Soft-wrap handling**: when hover is enabled, source textarea's
`white-space` is forced to `pre` (no wrap). User accepts horizontal scrolling
of long lines as a tradeoff for visual alignment. Documented in Settings UI.

**Rich view overlay**:

```
┌─ b-7f3a9c ───────────────────────┐
│ Introduction                     │
└──────────────────────────────────┘
```

- Absolute-positioned `<div class="mdblock-overlay">` outside `@moraya/core`,
  `pointer-events: none`
- `MutationObserver` on rich editor root, throttled to 100ms; on change, walk
  top-level DOM children and 1:1 align with `active[]` (in document order)
- Each top-level element gets a dashed outer rect + `b-xxxxxx` badge anchored
  to its top-left
- **1:N reconciliation** (multiple active blocks landing in the same rendered
  top-level node — happens when chunker splits a long paragraph): merge into
  one rect; badge shows `b-7f3a9c +1`; clicking badge popovers full id list

**Lifecycle**:

| Event | Effect |
|---|---|
| Hover enabled + tab has `.block.yaml` | Mount gutter + overlay |
| Tab switch | Tear down + remount per new tab |
| Hover disabled | Tear down; restore textarea CSS; unbind listeners |
| `.block.yaml` updated (mdblock.refresh, file watcher) | Reload yaml + redraw |
| `.block.yaml` missing | Empty gutter; no overlay; no error |

**Performance budget**:

- 1500-line, 200-block doc: gutter first paint < 16ms; scroll sync < 1ms/event
- Rich overlay recomputation: < 50ms per debounced batch

### (g) Module organization & settings

**File tree**:

```
src/lib/
├── blockchunk/          # pure algorithm (no IO)
├── blockio/             # persistence (Tauri fs)
├── mdblock-hover/       # visualization (DOM + Svelte)
└── plugins/mdblock/     # commands + manifest + onSave hook
src/components/
├── SettingsDialog.svelte    # add Block tab
├── SourceView.svelte        # mount mdblock-hover gutter slot
└── RichEditor.svelte        # mount mdblock-hover overlay slot
```

**Commands**:

| Command | Default shortcut | Behavior |
|---|---|---|
| `mdblock.compute` | — | First-time `.block.yaml` generation (gen=1, all fresh) |
| `mdblock.refresh` | `Cmd+Shift+B` | Re-chunk + merge; update yaml; regenerate `.block.md` if `has_block_md` |
| `mdblock.generateBlockMd` | — | Generate / regenerate `.block.md` only |
| `mdblock.reset` | — | Discard all lineage; rebuild fresh (confirm dialog) |
| `mdblock.followCitationAtCursor` | `Cmd+Enter`* | Resolve `((..))` under cursor and jump |
| `mdblock.toggleHover` | — | Toggle visualization (also in View menu) |

*`Cmd+Enter` only when cursor is inside `((..))`; otherwise pass-through.

**Settings schema** (added to `settings.svelte.ts`):

```ts
mdblock: {
  enabled: false,                   // master toggle; hides commands when off
  autoRefreshOnSave: false,         // auto re-merge on Cmd+S
  injectAiHint: true,
  similarityThreshold: 0.5,
  splitCoverageThreshold: 0.3,
  chunkSizeChars: 2400,
  hover: {
    enabled: false,
    showSourceGutter: true,
    showRichOverlay: true,
    badgeFormat: 'short',           // 'short' | 'full'
  },
}
```

UI: Settings → new `Block` tab (peer of `Plugins`).

**Refresh data flow**:

```
mdblock.refresh
  → load source content (in-memory)
  → load .block.yaml (if exists)
  → if source_hash unchanged → toast "无需更新" + write out_line if needed
  → else:
      chunkDocument(source) → newBlocks
      computeFingerprint(newBlocks) + load yaml.active fingerprints
      mergeBlocks(old, new, threshold) → MergeOutcome
      assign ids (kept/edited inherit; splits/merges/fresh allocate)
      build new yaml { meta, config, active, history-appended }
      atomicWrite(.block.yaml.tmp → rename)
      if has_block_md: generateBlockMd → atomicWrite(.block.md)
      notify mdblock-hover (via store) to reload
      toast "Refreshed: 23 active, +2 fresh, 1 retired"
```

**Cross-platform**: `blockchunk/` is pure TS (works in iOS port unchanged);
`blockio/` uses `@tauri-apps/plugin-fs` (same API on Tauri-mobile);
`mdblock-hover/` is DOM + Svelte (works in any webview).

### (h) Test strategy

| Layer | Type | Tooling | Scope |
|---|---|---|---|
| `blockchunk/` | unit, pure | vitest | algorithm + fingerprint + merge edge cases |
| `blockio/` | unit + integration | vitest + tmp dirs | yaml round-trip, inject idempotency, citation parsing |
| `mdblock-hover/` | component | vitest + happy-dom | line-block-map, gutter DOM, overlay DOM |
| End-to-end | command | manual smoke checklist | refresh produces correct artifacts; citations navigate |

**Algorithm-layer key cases**:

1. Port qmd's `test/store.test.ts` chunking describes (~40 cases) — verbatim
   coverage of break-point detection, code fences, best-cutoff scoring,
   integration
2. Fingerprint: identical text → identical hash; whitespace/case-equivalent
   text → identical hash; trigram Jaccard at 0 / 0.5 / 1
3. Merge: each outcome (kept / edited / split / merge / fresh / retired)
   isolated; composite (split + merge in same pass)

**Persistence-layer key cases**:

4. yaml round-trip: write → read → deep-equal
5. yaml corruption: writes `.broken-<ts>` backup, returns fresh state
6. Inject idempotency: source + active → byte-identical output across runs
7. Inject offset: with frontmatter / without / mid-line block boundary
8. Citation regex: nested-paren rejection, malformed id rejection, valid forms
9. Citation resolution: active hit, single-hop history, multi-hop history,
   deleted terminal, missing file, missing yaml, corrupted yaml

**Visualization-layer key cases**:

10. line-block-map: 5 active → correct `Map<line, id>`; empty → empty Map
11. Gutter: 5 source blocks → 5 labels + continuation bars; click copies id
12. Overlay 1:N reconciliation: badge shows `+1` count

**Performance benchmarks** (local, not CI):

- 50 KB markdown / ~200 blocks: chunk + merge < 50 ms; yaml serialize < 20 ms;
  `.block.md` generation < 10 ms
- 100-generation lineage: citation resolution < 5 ms

**Manual smoke checklist** (added to README):

```
N.   Open a .md file → Cmd+Shift+B → toast "computed N blocks"
N+1. Foo.md's directory now contains foo.block.yaml and foo.block.md
N+2. Settings → Block → enable hover → source gutter visible, rich borders visible
N+3. Edit lightly → Cmd+Shift+B → toast "10 kept, 2 edited, 0 fresh"
N+4. Delete half the document → Cmd+Shift+B → yaml history grows; some retired
N+5. In another .md, paste ((foo.md#b-xxxxxx)) → Cmd+Enter → opens foo.md and jumps
```

## Open questions / risks

1. **`@moraya/core` decoration API unknown at design time** — rich overlay
   relies on DOM walking + `MutationObserver`, which works regardless of the
   editor framework, but if `@moraya/core` exposes a proper decoration API
   later, it would be cleaner to migrate.
2. **`Cmd+Enter` shortcut conflict** — needs implementation-time audit against
   existing M↓ shortcuts; alternative: `Cmd+J`.
3. **Soft-wrap toggle UX surprise** — users enabling hover for the first time
   will notice their source view stops wrapping. Settings tooltip should
   explain.
4. **YAML merge conflicts in git** — when two collaborators run `Compute
   Blocks` on diverged branches, manual yaml merge is non-trivial. Document a
   recovery procedure: re-run `mdblock.refresh` on the merged source and let
   the algorithm re-derive ids; old citations resolve through the `history`
   chain.
5. **Generation counter monotonicity** — relies on yaml being trustworthy;
   if a user manually edits yaml's `meta.generation` lower, history ordering
   breaks. Spec assumes yaml is not hand-edited; future: signature/checksum.

## Future work (not in v1, captured for the implementation plan)

- KaTeX `$$..$$` blocks as unsplittable regions (fingerprint algorithm change)
- Token-based sizing via a real tokenizer (only if char-based proves
  insufficient in practice)
- Cross-tool URI schemes in citations (`qmd://`, `file://`)
- frontmatter as a first-class citable block
- Embedding-based similarity for merge (replace Jaccard with semantic match)
- A "lineage graph" panel that visualizes a block's full ancestry/descendant
  tree
- mdshare integration: share-page link `((doc#b-xxx))` resolves remotely
- Export "block diff between two generations" for review workflows
