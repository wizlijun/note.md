# Frontmatter Table Rendering (rich editor)

Date: 2026-07-08
Status: Approved — Revised 2026-07-08 (segmented + editable, see "Revision 2")

## Problem

YAML frontmatter (`--- … ---`) now parses into a dedicated `frontmatter` node
(v3.14.0) that renders as a raw `<pre>`. The user wants a richer read-only
display in the rich editor:

- `key: value` pairs → a two-column table (key | value).
- lists, block scalars, and long/multi-line text → auto-wrap, never overflow
  horizontally or collapse onto one line.

Editing stays in the source view; the rich-editor rendering is read-only.

## Approach (chosen: A)

**A — consumer NodeView via a new moraya `frontmatterViewFactory` option.**
Mirrors the existing `spreadsheetViewFactory` pattern. The table + YAML parsing
lives in mdeditor (which already depends on `yaml`); `@moraya/core` stays
generic and keeps its raw `<pre>` fallback when no factory is supplied. The
`frontmatter` schema node is unchanged, so parsing/serialization/roundtrip are
untouched — only the rendered DOM changes.

Rejected B (build the table directly in moraya's `toDOM` with a hand-rolled
line parser): bakes a product decision into the shared lib and parses YAML less
robustly.

## Design

### @moraya/core

- `types.ts`: add `FrontmatterViewFactory { render(container, raw): { destroy() } | void }`.
- `setup.ts`: add `frontmatterViewFactory?` to `EditorPluginOptions`; when set
  and `schema.nodes.frontmatter` exists, register `nodeViews.frontmatter`:
  a `div.frontmatter-node-view`, `contentEditable=false`, `stopEvent`/
  `ignoreMutation` true (read-only, same pattern as spreadsheet). `update`
  re-renders only when `node.textContent` changes.
- Default (no factory) keeps the existing `pre.moraya-frontmatter` toDOM.

### mdeditor

- `src/lib/frontmatter-view.ts`:
  - `buildFrontmatterDom(raw: string): HTMLElement` — pure, testable.
    - `yaml.parse(raw)`; on throw or non-plain-object → `<pre class="frontmatter-raw">`
      (wrapped) fallback.
    - plain object → `<table class="frontmatter-table">`, one `<tr>` per top-level key.
    - value rendering (all wrap):
      - scalar (string/number/boolean/null) → text; multi-line string keeps
        newlines via `pre-wrap`.
      - array → `<ul>`, one `<li>` per item (recurse).
      - nested object → `<div class="fm-nested">` of `key: value` lines (recurse).
  - `frontmatterFactory` implementing `FrontmatterViewFactory`.
- `editor-bridge.ts`: pass `frontmatterViewFactory: frontmatterFactory`.
- `editor-base.css`: `.frontmatter-table` (borders, key column muted/bold,
  `td` `vertical-align: top`), `.fm-val`/`.frontmatter-raw` `white-space:
  pre-wrap; overflow-wrap: break-word`.

## Testing

- `frontmatter-view.test.ts` (happy-dom): key:value → table rows; list → `<ul>`;
  multi-line string → cell with preserved newlines; malformed YAML → `.frontmatter-raw`
  fallback; nested object → nested lines.
- Existing moraya roundtrip tests still pass (schema unchanged).

## Out of scope

- Export/preview (marked) frontmatter rendering.

---

## Revision 2 — segmented rendering + editable scalar values

Shipped v3.15.0 rendered the whole frontmatter as one read-only table and only
when the entire block parsed as a YAML mapping. Revised requirements:

1. **Segment** the frontmatter into contiguous `key: value` regions vs. other
   content — do not require the whole block to be a mapping.
2. Non-key:value regions render as **markdown** (read-only).
3. Multi-line values (list / block scalar under a key) belong to that key's row.
4. **Scalar values are editable** in the rich editor; write back on blur.

### Segmentation (`src/lib/frontmatter-segment.ts`, pure)

`segmentFrontmatter(raw): Segment[]`, `Segment = { kind: 'kv'|'md', text, start, end }`.
Segments partition `raw` contiguously (concat of `text` === `raw`).

Line scan:
- A **top-level key line** matches `/^[^\s#][^:]*:(\s|$)/` (col 0, not `- `, not `---`).
- **Continuation** of a key = following indented lines (`/^\s/`); blank lines are
  continuations only when the next non-blank line is still indented (keeps block
  scalars with internal blanks intact), otherwise they end the kv block.
- Maximal runs of key lines (+continuations) → `kv` segment; everything else → `md`.

### Rendering (`frontmatter-view.ts`)

- `kv` segment → `<table class="frontmatter-table">` built from
  `yaml.parseDocument(segment.text)`. One `<tr>` per top-level pair:
  - **scalar** (string/number/boolean) → `td.fm-val[contenteditable]`; on blur, if
    changed, `doc.set(key, text)` → `String(doc)` re-stringifies the segment
    (preserves comments + key order; minor whitespace normalization accepted),
    spliced back into `raw` → `onChange(newRaw)`.
  - **list / nested / multi-line** → read-only rendering in the value cell.
- `md` segment → shared `marked` (sync parse) → read-only HTML.

### @moraya/core

Extend `FrontmatterViewFactory.render(container, raw, onChange?)`. The
`frontmatter` NodeView passes an `onChange(newRaw)` that replaces the node's
text content via a transaction (`tr.replaceWith(pos+1, pos+size-1, text)`),
marking the doc dirty. Re-render happens after blur, so it does not interrupt
typing. Schema node still `text*`; serialization/roundtrip unchanged.

### Testing

Segmentation (mixed / block-scalar / blank-line cases), kv→table, md segment
render, scalar edit write-back + full-raw roundtrip, malformed-YAML fallback.
