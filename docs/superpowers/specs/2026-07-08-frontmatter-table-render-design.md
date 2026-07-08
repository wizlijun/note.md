# Frontmatter Table Rendering (rich editor)

Date: 2026-07-08
Status: Approved

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

- Editing frontmatter inside the rich editor (source view only).
- Export/preview (marked) frontmatter rendering.
