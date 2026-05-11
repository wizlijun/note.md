# Markdown Block Splitting & Stable Block IDs — Final Specification

**Status**: Delivered (as of 2026-05-10)
**Owner**: bruce@hemory.com
**Companion**: this spec captures the AS-DELIVERED system. The original
brainstorm-stage design doc at
`2026-05-10-md-block-splitting-design.md` records the initial decisions and
is preserved as historical context. Where the two diverge, **this spec
wins** — it reflects 50+ iterations of in-product testing.
**Implementation entry point**: `src/lib/mdblock/`, `src/lib/blockchunk/`,
`src/lib/blockio/`, `src/lib/mdblock-hover/`.

## 1. Goal

Assign stable, edit-resilient block ids to every meaningful section of a
markdown document so AI tools can cite passages of M↓-edited documents at
sub-page granularity, **and** so the user can select a block and hand it
to an LLM for revision as a self-contained semantic unit.

The system produces:

1. **The original `<basename>.md`** — never mutated.
2. **`<appLocalDataDir>/blocks/<sha256-of-abs-path>.yaml`** — id metadata,
   full lineage, MinHash fingerprints. This is the source of truth for
   block identity. **Cached centrally** (not a sibling of the source).
3. **`<basename>.block.md`** (optional, `has_block_md=true`) — same content
   with HTML anchor lines inserted before each block, suitable as input to
   an LLM. Lives next to the source so it can be referenced by file path.

When AI output cites `((<basename>.md#b-7f3a9c))`, M↓ resolves the citation
back to a precise source line, walking the lineage chain through retired
ids if needed.

## 2. Non-goals (v1)

- ❌ Built-in LLM client/chat — M↓ produces inputs and consumes citation
  outputs. The AI itself runs externally.
- ❌ Per-keystroke disk persistence — yaml writes happen on save.
- ❌ AST-aware chunking for code files — markdown only.
- ❌ Token-precise sizing via a real tokenizer — char-based approximation.
- ❌ Cross-tool URI schemes (`qmd://`, `file://`) in citations.
- ❌ Editing `<basename>.block.md` — it is a build artifact.
- ❌ Sync of yaml across machines — cache is local; users on a new machine
  re-run Compute Blocks.
- ❌ Live `((..))` pill in the WYSIWYG editor — pills only render in
  share/PDF output. Source-mode `Cmd+Enter` follows citations under cursor.

## 3. Architecture overview

```
src/lib/blockchunk/      ← Pure algorithm layer (no IO)
  breakpoints.ts             scanBreakPoints + BREAK_PATTERNS
  codefences.ts              findCodeFences, isInsideCodeFence
  chunker.ts                 size-bounded chunker (qmd port)
  semantic-chunker.ts        section-first chunker (default)
  fingerprint.ts             SHA-256 hash + MinHash signature + jaccard + coverage
  id.ts                      newBlockId + BLOCK_ID_RE
  merge.ts                   5-pass mergeBlocks + MergeOutcome

src/lib/blockio/         ← Persistence layer (Tauri fs)
  yaml-schema.ts             Types for the v2 yaml
  yaml-rw.ts                 serialize/parse + atomic write
  inject.ts                  generateBlockMd (anchor injection)
  citation.ts                ((..)) parser + history-chain resolver
  marked-citation.ts         marked extension (share/PDF pills)

src/lib/mdblock/         ← Command + path layer
  commands.ts                cmdMdblock{Compute,Refresh,Reset,GenerateBlockMd,
                             FollowCitationAtCursor}, computeAndBuildYaml,
                             persistLiveYamlOrCompute
  auto-refresh.ts            Save-time hook
  path.ts                    cachedYamlPath (path-hashed cache lookup)
  settings.ts                isMdblockEnabled / isHoverEnabled (back-compat)

src/lib/mdblock-hover/   ← Visualization layer (Svelte 5 runes + DOM)
  hover-store.svelte.ts      Per-tab yaml + liveYaml state, recomputeLiveYaml
  rich-gutter.svelte         Left-side gutter for rich editor
  line-block-map.ts          line → blockid map (used internally)

src/components/          ← Editor integration
  SourceView.svelte          Line-number gutter with inlined block frames
                             + diff-debounced recompute trigger
  RichEditor.svelte          Mounts rich editor + RichGutter sibling
                             + diff-debounced recompute trigger
  SettingsDialog.svelte      "Block" tab
```

## 4. Data model

### 4.1 Yaml v2 schema

```yaml
meta:
  source: my-doc.md          # basename, for reference; the cache yaml is
                             # keyed by hash of the FULL path
  source_hash: 'abcdef012345'  # SHA-256 of source content (16 hex)
  generation: 47             # bumped on each merge round
  updated_at: '2026-05-10T...'
  schema_version: 2          # rejects v1 yamls (auto-renamed to .broken-<ts>)
  has_block_md: true         # whether .block.md is in sync

config:
  chunk_strategy: section    # 'size' | 'section' (default: 'section')
  chunk_size_chars: 2400     # max per block (section); target (size mode)
  break_window_chars: 800    # for size mode + size-fallback inside sections
  section_cut_level: 2       # H2 cut level (1..6)
  section_min_chars: 400     # merge undersized below
  similarity_threshold: 0.5  # Jaccard threshold for merge Pass 2
  split_coverage_threshold: 0.3  # coverage threshold for splits/merges
  inject_ai_hint: true       # add <!-- ((basename#xxx)) --> hint to .block.md

active:                      # current blocks, ordered by src_pos
  - id: b-7f3a9c
    src_line: 1              # 1-based line (live, computed by chunker)
    src_pos: 0               # char offset in source
    src_end_line: 5          # last line of the block
    src_end_pos: 142         # exclusive char offset just past block end
    out_line: 1              # line number in .block.md (only when has_block_md)
    fingerprint:
      hash: 'a1b2c3d4e5f6'   # SHA-256 of normalized text, 12 hex
      length: 142            # normalized char count
      minhash: '7f3a9c2e...' # 256 hex chars: k=32 32-bit MinHash signature
    parents: []              # empty for kept/edited; non-empty for splits/merges
    created_gen: 1           # birth generation; never bumped on inheritance

history:                     # append-only retired ids
  - id: b-c91d22
    retired_gen: 47
    replaced_by: [b-7f3a9c]  # successor ids; [] = pure deletion
    last_fingerprint:
      hash: '...'
      length: 1850
      minhash: '...'
```

**Key v2 differences from v1**: dropped `text` (replaced by persisted MinHash);
added `chunk_strategy`, `section_cut_level`, `section_min_chars` config keys;
added `src_end_line`/`src_end_pos` per active block.

### 4.2 Yaml cache location

```
<appLocalDataDir>/blocks/<sha256(absolute-source-path).slice(0,16)>.yaml

macOS: ~/Library/Application Support/com.laobu.mdeditor/blocks/
```

`appLocalDataDir` resolved via Tauri's path API. Directory created lazily
on first compute (`fs:allow-mkdir` capability).

**Why centralized**:

- User content directories stay clean (no sidecar files to `.gitignore`).
- Trade-off: yaml is local to one machine; renaming/moving the source
  orphans its yaml. User re-runs Compute Blocks on the new path.

The `.block.md` artifact (if generated) **stays next to the source** so
it can be passed to AI tools by file path.

### 4.3 Path identity

`absolute-source-path` is hashed with SHA-256, truncated to 16 hex chars
(64 bits). Filename = `<hash>.yaml`. Collision probability is negligible
for any realistic number of files per machine.

### 4.4 Citation syntax

```
((<pageuri>#b-xxxxxx))
```

| Form | Meaning |
|---|---|
| `((doc.md#b-7f3a9c))` | Block in `doc.md` (relative path) |
| `((/abs/path.md#b-7f3a9c))` | Absolute path |
| `((#b-7f3a9c))` | Same document |

Block id format: strict `b-` + 6 lowercase hex chars (24 random bits;
collision-checked at allocation against active+history union).

## 5. Chunking strategies

### 5.1 Section-first (default)

```
1. Find all headings (h1..h6); skip lines inside code fences.
2. Cut into initial sections at every heading whose level ≤ cutLevel.
3. Recursive split: any section over maxChars with sub-headings at the
   next deeper level is split there. Repeat one level at a time.
4. Size-fallback: any section still over maxChars with no deeper
   headings goes through the size-bounded chunker.
5. Merge undersized sections (size < minChars) forward into the previous
   section. Tail-merge the last section backward if it's still small.
```

**Output convention**: each block's text spans lines [src_line, src_end_line]
inclusive, **without** the trailing `\n` of the last line. Adjacent blocks
share the boundary `\n`.

**Defaults**: `cutLevel=2 (H2)`, `maxChars=2400`, `minChars=400`. For an
H2-organized document with sub-H3 in long sections, this typically yields
one block per chapter or sub-section, ranging 400–2400 chars — the
"select a block, hand to LLM" sweet spot.

### 5.2 Size-first (qmd port, alternative)

Direct port of qmd's chunking core. Greedy walk: at each step, target
`charPos + maxChars`, find the best break point in the window via
score × squared distance decay (h1=100 .. newline=1), cut there.

Intended for documents without headings (or for users who explicitly
prefer mechanical size cuts). Auto-selected as the fallback inside
section-first when an oversized section has no deeper headings.

### 5.3 Strategy selection

`config.chunk_strategy` ∈ `{'section', 'size'}`. When unset (e.g. legacy
or hand-edited yaml), defaults to `'section'`. Strategy persists per
document in its yaml; changing the global default (Settings → Block) only
affects newly Computed documents. Manual override: edit yaml `config:`
or run `mdblock.reset`.

## 6. Block identity & merge

### 6.1 Fingerprint

Each block has a 3-field fingerprint:

```ts
interface BlockFingerprint {
  hash: string         // 12 hex; SHA-256 of normalized text
  length: number       // normalized char count
  minhash: number[]    // length 32; each a 32-bit unsigned hash
}
```

**Normalization**: lowercase + collapse whitespace + trim, retaining
structural markers (`#`, `-`, `>`).

**MinHash**: 32 seeded FNV-1a hashes over the 5-gram shingle set of the
normalized text. Persisted as 256 hex chars in yaml. Approximate Jaccard
≈ (matching positions) / 32 (std error ~0.18, sufficient for the 0.5
threshold zone of merge Pass 2).

**Coverage** (asymmetric, used in Pass 3/4):
```
coverage(small, big) ≈ J × max(|small|, |big|) / |small|
```
Approximation; capped at 1.0.

### 6.2 5-pass merge

`mergeBlocks(oldEntries, newEntries, threshold=0.5, splitCoverage=0.3)`:

| Pass | Purpose | Outcome |
|---|---|---|
| 1 | exact hash equality (in document order) | `kept` |
| 2 | Jaccard ≥ threshold (greedy descending) | `edited` (new inherits oldId) |
| 3 | one old → multiple new with coverage ≥ split | `splits[]` (one inheritor + sibling indices) |
| 4 | multiple old → one new with coverage ≥ split | `merges[]` (new gets fresh id; old all retire) |
| 5 | residue | unmatched old → `retired`, unmatched new → `fresh` |

**Output partitioning rule**: every new block index appears in exactly
ONE of `kept | edited | splits.newIdx | splits.siblings | merges | fresh`.
Every old block id appears in exactly ONE of `kept | edited | splits |
merges | retired`.

**Caller responsibilities** (`computeAndBuildYaml` in commands.ts):

- Allocate fresh ids for `splits.siblings`, `merges`, `fresh`
- Set `parents`: `[]` for kept/edited/splits.newIdx; `[oldId]` for split
  siblings; `[...m.oldIds]` for merges; `[]` for fresh
- Build `history` entries: pure deletions (`out.retired`) get
  `replaced_by=[]`; merge participants (derived from `out.merges.oldIds`)
  get `replaced_by=[mergedNewId]`
- Preserve `created_gen` on inheritance; new blocks get current generation

### 6.3 Edge handling

- **Identical content blocks** (e.g. two `## Section`): Pass 1 matches in
  document order — first old to first new.
- **Tiny blocks** (< 50 normalized chars): skip Pass 2 Jaccard (noisy on
  small shingle sets). Currently `TINY_BLOCK_LEN = 20` at runtime.
- **Empty/short documents**: empty new entries → all retired; empty old
  entries → all fresh.

### 6.4 Stability promise

| Edit | Behavior |
|---|---|
| Untouched | id preserved (Pass 1) |
| Minor edits, ≥ ~50% similarity | id preserved (Pass 2) |
| Reorder | id preserved (matching is content-keyed) |
| Split | one inheritor; siblings fresh with `parents` |
| Merge | new id with `parents`; participants retired |
| Heavy rewrite | retired → fresh |

Citations to ANY id ever issued resolve through `replaced_by` chains;
terminal `replaced_by: []` reports "已删除" with banner.

## 7. Live preview & persistence

### 7.1 Live recompute

While the user types in either editor mode:

1. The component (`SourceView` or `RichEditor`) tracks `value` /
   `tab.currentContent`.
2. On every change, a 250 ms debounce timer is set/reset.
3. When the timer fires, `recomputeLiveYaml(filePath, source)` runs the
   full `computeAndBuildYaml(filePath, source, state.yaml)` against the
   persisted yaml as merge base, producing a new yaml.
4. The result is stored as `state.liveYaml` in `hover-store`. The
   persisted file on disk is **not touched**.
5. All consumers prefer `state.liveYaml ?? state.yaml` for display
   (via `getDisplayYaml`).

This gives ~300 ms perceived latency for structural updates (new
blocks, removed blocks, lineage shifts) without disk writes during typing.

### 7.2 Save-time persistence

When the user saves the .md file (Cmd+S):

1. `tabs.svelte.ts:saveActive` / `saveAs` writes the source.
2. `auto-refresh.ts:maybeAutoRefresh` is invoked.
3. If mdblock is enabled AND a yaml exists in the cache for this path,
   `persistLiveYamlOrCompute(filePath, source)` runs:
   - Prefers `state.liveYaml` (already in memory) and writes it to disk
     via `writeBlockYamlAtomic`.
   - Falls back to a fresh `computeAndBuildYaml` if no liveYaml.
   - Regenerates `.block.md` if `meta.has_block_md=true`.
4. On success, dispatches `mdblock:yaml-updated` so the hover-store
   reloads (drops liveYaml, adopts the freshly-persisted yaml).

**First-time opt-in**: a doc with no yaml in the cache won't auto-create
on save (protects users from yaml proliferation across transient files).
User runs Cmd+Shift+B once; subsequent saves auto-persist.

### 7.3 Manual commands

| Command | Default key | Behavior |
|---|---|---|
| `mdblock.compute` | — | First-time yaml creation (gen 1, all fresh) |
| `mdblock.refresh` | `Cmd+Shift+B` | Re-chunk + merge + write yaml + regen .block.md if applicable |
| `mdblock.generateBlockMd` | — | Generate `.block.md` (sets `has_block_md=true`) |
| `mdblock.reset` | — | Discard lineage; rebuild fresh (confirm dialog). Preserves `has_block_md`, regenerates `.block.md` so on-disk artifacts stay coherent |
| `mdblock.followCitationAtCursor` | `Cmd+Enter`* | Jump to `((..))` under cursor (source mode) |

*`Cmd+Enter` only fires when the cursor is inside a `((..))` token; falls
through to default keystroke handling otherwise.

## 8. Citation rendering

### 8.1 Marked extension (share / PDF output)

`src/lib/blockio/marked-citation.ts` registers a marked extension that
matches `((page#b-xxxxxx))` inline and renders as an HTML pill:

```html
<span class="block-citation"
      data-pageuri="doc.md"
      data-blockid="b-7f3a9c"
      title="跳转 doc.md #b-7f3a9c">→ doc.md#b-7f3a9c</span>
```

Registered into `host-render-html.ts`'s `sharedMarked`, so all share-page
and md2pdf output gets pill rendering. Pill CSS lives in
`src/styles/editor-base.css` (background tint, hover, retired/deleted
status overrides).

### 8.2 Live rich editor

`@moraya/core` is prosemirror-based and does not route through marked,
so `((..))` displays as plain text in the live rich editor view. Source
mode's `Cmd+Enter` is the navigation path during editing. Rich-mode
pill rendering would require a custom prosemirror node — recorded as
future work.

### 8.3 Source-mode `Cmd+Enter` flow

`cmdMdblockFollowCitationAtCursor` in commands.ts:

1. Locate the active textarea (`textarea.src-textarea`).
2. Read `selectionStart`; scan the value for `((..))` containing that
   position via `citationAtCursor`.
3. If found, `resolveCitation(pageuri, blockid, currentDocPath)`:
   - Resolve pageuri to absolute path (rejects `..` traversal)
   - Load yaml from cache (`cachedYamlPath`)
   - Search active first; then walk `replaced_by` chains in history
   - Return `{filePath, srcLine, status, banner}`
4. Open the target tab if different, dispatch `mdblock:jump` event with
   `srcLine`. SourceView listens and scrolls + selects.

Statuses: `active` / `retired` (with banner pointing to current carrier) /
`deleted` (banner only, no jump) / `not_found` (toast only).

### 8.4 Click-to-copy from gutter markers

Both source and rich gutters expose a click handler on each marker:

- Click → copy `((<basename>#<blockid>))` to clipboard
- Marker flashes green for ~1.2 s as confirmation
- Hover → `title` attribute shows the full citation
- Useful for AI prompt assembly: open doc → click block → paste citation

## 9. UI: source view

### 9.1 Block frames inlined into line-number gutter

Source view has a single combined gutter (`.gutter`):

```svelte
<div class="gutter">
  {@html lineNumbersHtml}  {/* numeric lines + per-block-start <button> */}
</div>
<div class="host">
  <pre class="hl">  {/* highlight overlay */}
  <textarea class="src-textarea">
</div>
```

For block-start lines, the line-number text is wrapped in:

```html
<button class="num block-start"
        data-blockid="b-7f3a9c"
        title="((doc.md#b-7f3a9c))">76</button>
```

CSS: `display: inline-block; width: 100%; outline: 1px solid; padding: 0
4px; background: tinted`. **`outline` + `outline-offset: -1px`** instead of
`border` so the visible frame **takes zero layout space** — the row's
outer height stays exactly `line-height`, keeping subsequent line numbers
perfectly aligned with their textarea content rows. Layout-driven; zero
pixel math on our side.

Gutter scroll syncs with textarea via `gutterEl.scrollTop = textarea.scrollTop`
in `syncScroll`. The `<button>` markers move with the gutter's natural
scroll (no separate transform).

Click on `.block-start` → `onGutterClick` event delegate → copies
citation + flashes green.

### 9.2 Live recompute trigger

```ts
let recomputeTimer: ReturnType<typeof setTimeout> | null = null
$effect(() => {
  void value
  const t = activeTab()
  if (!t?.filePath || !isHoverActive() || !t.filePath.endsWith('.md')) return
  if (recomputeTimer) clearTimeout(recomputeTimer)
  const filePath = t.filePath
  const cur = value
  recomputeTimer = setTimeout(() => void recomputeLiveYaml(filePath, cur), 250)
})
```

`Cmd+Enter` keydown handler routes to `cmdMdblockFollowCitationAtCursor`;
returns `true` to consume the event, `false` to fall through.

## 10. UI: rich view

### 10.1 Left gutter (sibling, not overlay)

```svelte
<div class="rich-pane">
  {#if isHoverActive() && hover.showRichOverlay && hoverYaml && host}
    <RichGutter container={host}
                yaml={hoverYaml}
                source={tab.currentContent}
                pageBasename={...} />
  {/if}
  <div class="host" bind:this={host}></div>
</div>
```

`.rich-pane` is `display: flex` so the gutter (22 px) and the editor host
sit side-by-side. The gutter does NOT overlay the editor — the rich
editor is fully interactive without click interception.

### 10.2 Source-line → DOM-child mapping

`@moraya/core` renders each top-level markdown construct as a direct
child of `.ProseMirror`. `RichGutter.topLevelStartLines(source)` parses
the source markdown into the same sequence of constructs:

| Source pattern | Counted as 1 unit |
|---|---|
| `# H1` … `###### H6` | heading |
| Code fence (\`\`\`...\`\`\`) | one |
| Horizontal rule (`---`, `***`, `___`) | one |
| Paragraph (consecutive non-empty non-special lines) | one |
| List (consecutive list items, possibly nested) | one |
| Blockquote (consecutive `>` lines) | one |
| **Extra blank lines (3+ in a row)** | ProseMirror emits N−1 empty paragraphs; we emit a placeholder per extra blank |
| **Setext heading (`Title\n===`)** | merged into the preceding paragraph (becomes one heading) |
| **YAML frontmatter at start** | stripped before parsing (ProseMirror doesn't render it) |

The Nth top-level unit corresponds to the Nth DOM child of `.ProseMirror`.
For each yaml block, its `[src_line, next_block.src_line - 1]` range maps
to a contiguous run of top-level units → contiguous DOM children →
`getBoundingClientRect()` on first/last gives the marker's content-Y span.

### 10.3 Marker layout

Each marker is a 10×10 button at the top of its block's range, with a
2 px vertical bar extending downward to the block's last child's bottom.
`pointer-events: none` on the wrapping row; `pointer-events: auto` only
on the marker button so the bar doesn't intercept clicks.

### 10.4 Scroll sync (jitter-free)

Scroll handler writes the inner div's `transform` **directly via the
DOM ref**, not through Svelte reactive state:

```ts
const onScroll = () => {
  if (innerEl) innerEl.style.transform = `translateY(${-container.scrollTop}px)`
}
container.addEventListener('scroll', onScroll, { passive: true })
```

This keeps the gutter and host content frame-locked (zero lag from
Svelte's batched update queue). **Recompute is NOT triggered on scroll**
— content-Y is independent of scroll, so re-measuring `getBoundingClientRect`
at each scroll tick would only inject subpixel noise (visible as marker
jitter). Recompute fires only on:

- MutationObserver child/text changes (editor content updated)
- `window resize`
- Source / yaml prop changes (via a separate `$effect`)

## 11. Settings UI

Settings → Block tab (peer of Plugins / Core):

```
[ Enable Block IDs (mdblock) ]   (master toggle)

Chunking strategy
  Strategy:        [ Section-first | Size-first ]
  Section cut level: [ H1 | H2 | H3 ]
  Min section chars (merge below): 400
  Max chars per block:              2400
  Similarity threshold (id stability): 0.5

[ Inject AI usage hint into .block.md ]  (default: on)

Visualization
  Source-mode markers (in line-number gutter)
  Rich-mode left gutter (markers + bars)

(saving the .md auto-persists the matching .block.yaml)
```

Behavior implications:

- `mdblock.enabled` is the master switch. When on:
  - Opening any .md auto-loads its yaml from the cache (if one exists)
  - Markers display in both source and rich (subject to the per-view
    checkboxes below)
  - `Cmd+Shift+B` and the live recompute path are active
  - Save-time persist runs (no separate `autoRefreshOnSave` toggle)
- The per-view checkboxes default to true — they're opt-OUT, not opt-IN.

## 12. Tauri capabilities

Required permissions in `src-tauri/capabilities/default.json`:

```
fs:allow-read-text-file        path: **
fs:allow-write-text-file       path: **
fs:allow-read-file             path: **
fs:allow-exists                path: **
fs:allow-stat                  path: **
fs:allow-rename                path: **        ← atomic .tmp → final
fs:allow-remove                path: **        ← Windows pre-rename
fs:allow-mkdir                 path: **        ← cache dir bootstrap
fs:scope                       path: **
```

`@tauri-apps/plugin-fs` is imported lazily inside specific functions to
keep the IO layer out of the test environment by default.

## 13. File system layout (after a session)

```
~/Library/Application Support/com.laobu.mdeditor/
├── settings.json                       (mdeditor's existing prefs)
└── blocks/                              ← created on first compute
    ├── a3f7c9b2e4d18e5c.yaml            (one cache per source path)
    ├── b8a4f1e6c92d3a4f.yaml
    └── …

<user content directory>/
├── doc.md                               (untouched source)
└── doc.block.md                         (only if has_block_md=true)
```

## 14. Performance characteristics (typical 20 KB doc, ~20 blocks)

| Operation | Wall time |
|---|---|
| `chunkDocumentSemantic` | <5 ms |
| `computeFingerprint` × 20 (parallel) | ~10 ms |
| `mergeBlocks` (5 passes) | ~10 ms |
| `serializeBlockYaml` | ~5 ms |
| Tauri fs write (yaml) | ~5–15 ms |
| **Total `Cmd+Shift+B` end-to-end** | ~50 ms |
| **Live recompute (debounced)** | 250 ms debounce + ~30 ms compute = ~280 ms perceived |

For a 100 KB / 100-block doc, multiply by ~5×. Still under 500 ms total.

## 15. Known limitations / future work

- **Heavy live-edit lineage churn**: rapidly typing a heading mid-document
  triggers 250 ms-spaced recomputes. Each recompute may produce different
  fresh ids for unmatched blocks. Save commits whichever id was current at
  save time. Acceptable.
- **Renamed/moved source files orphan their yaml**. Mitigation: re-run
  Compute Blocks at the new path. Future: optional content-based migration
  (detect "yaml whose persisted blocks closely match this new source").
- **Rich-mode `((..))` pill** is share/PDF only; no live pill in
  `@moraya/core`. Future: prosemirror node + click handler.
- **Multi-document operations**: no batch Compute on a folder, no
  "find references to this block id across the cache". Out of scope v1.
- **YAML hand-edits**: parsing trusts the file (only schema_version is
  validated). Hand-edits to make ids match across machines are possible
  but not assisted by the UI.
- **Top-level construct parser** (rich-gutter) heuristics may diverge
  from `@moraya/core`'s rendering for unusual markdown (raw HTML
  blocks, malformed tables, indented code blocks). The `tops/children
  mismatch` warning logs to console when the gap > 2.

## 16. Test coverage

```
src/lib/blockchunk/
  breakpoints.test.ts          (10 tests; BREAK_PATTERNS scoring + scanner)
  codefences.test.ts           (8;  fence pairing, isInside)
  chunker.test.ts              (17; size-mode chunker; ports qmd's tests)
  fingerprint.test.ts          (19; normalize, hash, MinHash, jaccard, coverage)
  id.test.ts                   (4;  newBlockId, BLOCK_ID_RE, collision retry)
  merge.test.ts                (9;  5-pass outcomes + invariants)
  semantic-chunker.test.ts     (10; cut/split/merge/fallback paths)

src/lib/blockio/
  yaml-rw.test.ts              (5;  v2 schema round-trip, v1 rejection)
  inject.test.ts               (8;  anchor injection, frontmatter, idempotency)
  inject-frontmatter.test.ts   (1;  regression: every block gets an anchor)
  citation.test.ts             (14; regex, parse, resolvePageUri, history walks)
  marked-citation.test.ts      (4;  pill rendering + XSS safety)

src/lib/mdblock/
  e2e-smoke.test.ts            (4;  full-pipeline smoke on a sample doc)

src/lib/mdblock-hover/
  line-block-map.test.ts       (3;  line → entry map)
```

**368 tests total**; all green. No code-quality / svelte-check errors
(only the 4 pre-existing a11y warnings on TabBar / SettingsDialog which
are inherited from before this work).

## 17. Manual smoke checklist

```
N.  Settings → Block → enable "Enable Block IDs (mdblock)" → close.

N+1.  Open any .md file; press Cmd+Shift+B → toast "Computed: K blocks (gen 1)".
      Verify <appLocalDataDir>/blocks/<hash>.yaml exists.

N+2.  Edit lightly (fix a typo); pause for ~300 ms. Block markers in both
      source gutter and rich gutter update positions; structure unchanged
      (same K blocks).

N+3.  Insert a new "## New Section" line. Pause. A new marker appears in
      both gutters at that line's position.

N+4.  Save (Cmd+S). yaml file modified time updates. Cat the yaml: a new
      active entry exists for the new section; existing ids preserved.

N+5.  Hover a source-mode line-number with a frame around it → tooltip
      shows "((doc.md#b-xxxxxx))". Click → flashes green; clipboard
      contains the citation.

N+6.  Open another .md; type ((doc.md#b-xxxxxx)) where doc.md is the
      previous file and b-xxxxxx is one of its real ids. Place cursor
      inside the parens; press Cmd+Enter → other doc opens, jumps to
      the right line.

N+7.  In the source view of that other doc, place cursor on a citation
      whose id was retired (run Cmd+Shift+B after deleting some blocks
      first to retire them). Cmd+Enter → toast banner shows the
      retirement chain destination.

N+8.  Settings → Block → Strategy = "Size-first"; run Cmd+Shift+B; ids
      get reassigned along size boundaries. Toggle back to "Section-first";
      another Cmd+Shift+B realigns to chapters.

N+9.  Reset Block Lineage… → confirm. ids change but `.block.md` is
      regenerated to match (no orphaned anchors).

N+10. Disable "Enable Block IDs" in Settings. All markers disappear from
      both views. Re-enable. Markers come back from cached yaml without
      another compute.
```

---

## Appendix A: yaml minhash example

For visual reference, a real fingerprint entry:

```yaml
fingerprint:
  hash: 160011557b0c
  length: 1578
  minhash: 0044701c0041122a000d5c7c00358084000ea413000d6754...   # 256 hex chars
```

The 256 hex chars decode to 32 32-bit unsigned integers (k=32 MinHash
signature). Direct hex inspection is not human-meaningful; debugging
typically uses fingerprint equality / Jaccard-similarity tooling.

## Appendix B: divergences from the original design doc

For readers comparing this final spec to
`2026-05-10-md-block-splitting-design.md`:

| Original design | Final delivered |
|---|---|
| yaml stored next to source (`<basename>.block.yaml`) | yaml stored in `<appLocalDataDir>/blocks/<hash>.yaml` |
| yaml inlines normalized text per block (X2) | yaml stores MinHash signature only; no text |
| Single chunking strategy (size-only, qmd port) | Two strategies; "section-first" is the default |
| Manual Cmd+Shift+B to persist | Save-time auto-persist; debounced live preview during typing |
| Separate `block-gutter` column in source view | Block frames inlined into existing line-number gutter |
| Rich overlay above editor (intercepts clicks) | Rich gutter as left sibling (no overlay) |
| Hover-toggle as separate Settings switch | Subsumed into mdblock master toggle |
| `((..))` pill in rich editor live | Share/PDF only (rich editor pills = future work) |
