# Spreadsheet Feature Design

**Date:** 2026-05-13  
**Status:** Implemented

## Overview

Add lightweight spreadsheet capability to mdeditor with two entry points:

1. **Embedded block** — a `spreadsheet` ProseMirror node inside a Markdown document, inserted via slash command, serialized as a ` ```csv ` fenced block
2. **CSV file editor** — when opening a `.csv` file, render a spreadsheet UI; source mode toggle switches to raw CSV text editing

### Libraries

- `@revolist/svelte-datagrid` (MIT) — Svelte-native editable data grid (RevoGrid)
- Custom formula evaluator in `formula.ts` — SUM/AVG/COUNT/A1 cell refs/arithmetic via `new Function()`. No external formula library dependency.

> `@formulajs/formulajs` was evaluated but removed: the v1 formula surface area (SUM, AVG, COUNT, cell references, four-function arithmetic) is fully covered by the 60-line custom evaluator with zero bundle overhead.

---

## Architecture

Three independent units with clear boundaries:

```
MiniSpreadsheet.svelte            ← Pure UI, no ProseMirror/Tauri knowledge
  props: csvSource: string
         onChange(csv: string): void
  responsibilities: cell editing, Tab/Enter/Arrow navigation,
                    add/remove rows and columns, formula display,
                    row number column, dark mode header theming

SpreadsheetNodeView               ← ProseMirror NodeView (vanilla DOM shell)
  defined in moraya-core
  uses injected SpreadsheetViewFactory to mount MiniSpreadsheet

CsvEditor.svelte                  ← Standalone tab for .csv files
  delegates content changes to setContent() → existing autosave loop
  mounts MiniSpreadsheet directly, no ProseMirror involved
```

### Injection pattern (same as RendererRegistry)

moraya-core defines the interface; mdeditor provides the Svelte implementation:

```ts
export interface SpreadsheetViewFactory {
  create(
    container: HTMLElement,
    source: string,
    onChange: (csv: string) => void
  ): { destroy(): void }
}
```

mdeditor implements this in `spreadsheet-factory.ts` using Svelte 5's `mount()` / `unmount()`.

---

## Data Model

**Markdown storage:**

```markdown
```csv
日期,分类,描述,金额,余额
2026-05-01,餐饮,午餐,-45,=E1+D2
2026-05-02,收入,工资,8000,=E2+D3
\```
```

**In-memory:** `string[][]` (rows × cols).

**CSV parsing:** `csv.ts` — RFC 4180 compliant: comma-separated, newline rows, double-quote escaping for cells containing commas or quotes.

**Formula cells:** Any cell value starting with `=` is evaluated by `formula.ts`. Cell references use A1 notation (single-letter `A1` and multi-letter `AA1`, `AB2`, etc.). Non-formula cells are displayed as-is. Circular references resolve to `0`. Errors return `#ERR`.

**TSV files:** `.tsv` opens as plain code/text (kind: `'code'`), not as a spreadsheet — tab-delimiter parsing is not implemented in v1.

---

## Data Flow

```
[Markdown file]                      [.csv file]
  ```csv                               日期,金额
  日期,金额                             2026-05-01,-45
  2026-05-01,-45
  ```
       ↓ moraya-core markdown parse         ↓ tab.currentContent (Tauri fs read)
  spreadsheet node (attrs.source)      raw CSV string
       ↓ NodeView + factory inject          ↓ csvSource prop
  MiniSpreadsheet.svelte           MiniSpreadsheet.svelte
       ↓ onChange(csv)                      ↓ onChange(csv)
  PM setNodeMarkup transaction        setContent(tab.id, csv) → autosave loop
```

---

## Feature Scope (v1)

**Implemented:**
- Editable cells with keyboard navigation (Tab/Enter handled by RevoGrid)
- Add row at bottom (`＋行`), delete last row (`－行`)
- Add column at right (`＋列`), delete last column (`－列`)
- Row number display (RevoGrid `rowHeaders={true}`)
- Formula evaluation: `=SUM(B2:B5)`, `=AVG(...)`, `=COUNT(...)`, `=A1+B1`, `=A1*0.1`
- Multi-letter column references: `AA1`, `AB2`, etc. (beyond column Z)
- When editing a formula cell: editor shows raw formula (via `beforeeditstart` event), not computed result
- Column width resizable via drag (RevoGrid built-in)
- Slash command `电子表格` → inserts 4-row × 3-column block with labelled header row (`列A,列B,列C`)
- Dark mode: column and row headers adapt to system dark mode; data cells always white
- Source mode toggle: switch between spreadsheet grid and raw CSV text editing
- `.csv` files open in `rich` (spreadsheet) mode by default; mode preference is saved

**Explicitly out (v1):**
- Cell formatting (color, font, bold/italic per cell)
- First data row bold/header styling (all rows are uniform)
- Delete *selected* row/column (toolbar always deletes the last row/column)
- Cell merging
- Freeze rows/panes
- Charts or visualizations
- Cross-sheet references
- TSV spreadsheet editing (`.tsv` opens as plain text)
- Import/export beyond CSV

---

## moraya-core Changes

### 1. `schema.ts` — new `spreadsheet` node

```ts
const spreadsheet: NodeSpec = {
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { source: { default: '' } },
  parseDOM: [{ tag: 'div[data-spreadsheet]', getAttrs: (dom) => ({ source: dom.getAttribute('data-source') ?? '' }) }],
  toDOM(node) { return ['div', { 'data-spreadsheet': '', 'data-source': node.attrs.source }] },
}
```

`draggable: false` prevents ProseMirror's native drag behavior from conflicting with RevoGrid's cell selection.

### 2. `markdown.ts` — serialize/parse

- **Parse:** ` ```csv ` fenced block → `spreadsheet` node (`attrs.source = content.trim()`). Falls through to `code_block` for all other fence languages.
- **Serialize:** `spreadsheet` node → ` ```csv\n{source}\n``` `

### 3. `types.ts` — extend SchemaConfig

```ts
export interface SchemaConfig {
  mediaResolver: MediaResolver
  rendererRegistry?: RendererRegistry
  linkOpener?: LinkOpener
  spreadsheetViewFactory?: SpreadsheetViewFactory
}

export interface SpreadsheetViewFactory {
  create(
    container: HTMLElement,
    source: string,
    onChange: (csv: string) => void
  ): { destroy(): void }
}
```

`SpreadsheetViewFactory` is exported from `index.ts` as a public API type.

### 4. `setup.ts` — register NodeView

- `spreadsheetViewFactory` added to `EditorPluginOptions` and forwarded through `SchemaConfig` in both `createEditorPlugins()` and `createEditor()`.
- When factory is provided: NodeView creates a `<div class="spreadsheet-node-view">`, mounts the component via `factory.create()`, and dispatches `setNodeMarkup` on CSV changes. `update()` returns `true` (no remount) when the source change originated from the component itself; `false` (remount) for external changes (undo/redo).
- When factory is absent: fallback `<pre class="spreadsheet-fallback">` showing raw CSV (tests/headless).

---

## mdeditor Changes

### New files

| File | Responsibility |
|------|---------------|
| `src/lib/spreadsheet/csv.ts` | RFC 4180 CSV parse/serialize, `string[][]` |
| `src/lib/spreadsheet/formula.ts` | Custom formula evaluator: SUM/AVG/COUNT/A1 refs/arithmetic, multi-letter columns |
| `src/lib/spreadsheet/MiniSpreadsheet.svelte` | RevoGrid wrapper: formula layer, row headers, dark mode header CSS, toolbar |
| `src/lib/adapters/spreadsheet-factory.ts` | `SpreadsheetViewFactory` impl via Svelte `mount()` / `unmount()` |
| `src/components/CsvEditor.svelte` | Standalone spreadsheet tab; delegates to `setContent()` for autosave |

### Modified files

| File | Change |
|------|--------|
| `src/lib/fs.ts` | Added `'spreadsheet'` to `FileKind`; `.csv` → `kind: 'spreadsheet'` |
| `src/lib/tabs.svelte.ts` | `.csv`/`spreadsheet` kind opens in `rich` mode by default |
| `src/lib/plugins/types.ts` | Added `'spreadsheet'` to `TabKind` |
| `src/components/EditorPane.svelte` | Added `{:else if tab.kind === 'spreadsheet' && tab.mode !== 'source'}` branch |
| `src/lib/editor-bridge.ts` | Passes `spreadsheetFactory` to `coreCreateEditor()` |
| `src/lib/slash-menu/slash-items.ts` | Added `电子表格` slash item + `insertSpreadsheetSync()` helper |

---

## MiniSpreadsheet Internal Design

```
csvSource (string prop)
   ↓ $effect: re-parse when prop changes externally (undo/redo, file reload)
rawGrid: string[][]   ← $state, source of truth, stores raw formulas
   ↓ $derived: evaluateGrid(rawGrid)
displayGrid: string[][] ← what RevoGrid renders (computed results)
   ↓ $derived: map to Record<string, string>[] objects
RevoGrid source prop

On beforeeditstart:  inject rawGrid[row][col] into event.detail.val
                     so editor shows "=SUM(...)" not "60"
On afteredit:        update rawGrid[row][col] = event.detail.val
                     → recompute displayGrid → onChange(serializeCsv(rawGrid))
```

**RevoGrid events used:**
- `afteredit` → `AfterEditEvent` (detail: `{ prop, val, rowIndex }`)
- `beforeeditstart` → `BeforeSaveDataDetails` (detail: `{ prop, rowIndex, val, model }`)

---

## Slash Command

```ts
{
  id: 'spreadsheet',
  label: '电子表格',
  keywords: ['spreadsheet', 'sheet', 'csv', '表格', '电子表格', '记账', 'excel'],
  icon: '⊞',
  desc: '可编辑电子表格（支持公式）',
  execute: (v) => insertSpreadsheetSync(v),
}
```

Default content: `'列A,列B,列C\n,,\n,,\n,,'` — 4 rows × 3 cols with a labelled header row.

---

## Known Limitations (v2 candidates)

| ID | Description |
|----|-------------|
| I1 | undo/redo triggers NodeView remount (correct behavior, slight visual flash) |
| S1 | First row not visually distinguished as header (no bold/background styling) |
| S2 | Toolbar `－行`/`－列` always removes last row/col, not the selected one |
| S3 | TSV files open as plain text, not as a tab-delimited spreadsheet |
| S4 | `new Function()` requires `unsafe-eval` CSP — relevant if CSP is hardened |
