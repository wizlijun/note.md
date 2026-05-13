# Spreadsheet Feature Design

**Date:** 2026-05-13  
**Status:** Approved

## Overview

Add lightweight spreadsheet capability to mdeditor with two entry points:

1. **Embedded block** — a `spreadsheet` ProseMirror node inside a Markdown document, inserted via slash command, serialized as a ` ```csv ` fenced block
2. **CSV file editor** — when opening a `.csv` file, render a spreadsheet UI instead of plain text

### Libraries

- `@revolist/svelte-datagrid` (MIT) — Svelte-native editable data grid
- `@formulajs/formulajs` (MIT) — Excel-compatible formula engine (SUM, AVG, COUNT, arithmetic, cell references)

---

## Architecture

Three independent units with clear boundaries:

```
MiniSpreadsheet.svelte            ← Pure UI, no ProseMirror/Tauri knowledge
  props: csvSource: string
         onChange(csv: string): void
  responsibilities: cell editing, Tab/Enter/Arrow navigation,
                    add/remove rows and columns, formula display

SpreadsheetNodeView               ← ProseMirror NodeView (vanilla DOM shell)
  defined in moraya-core
  uses injected SpreadsheetViewFactory to mount MiniSpreadsheet

CsvEditor.svelte                  ← Standalone tab for .csv files
  reads/writes via Tauri fs
  mounts MiniSpreadsheet directly, no ProseMirror involved
```

### Injection pattern (same as RendererRegistry)

moraya-core defines the interface; mdeditor provides the Svelte implementation:

```ts
spreadsheetViewFactory?: (
  container: HTMLElement,
  source: string,
  onChange: (csv: string) => void
) => { destroy(): void }
```

mdeditor implements this with Svelte 5's `mount()`.

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

**In-memory:** `string[][]` (rows × cols). First row is the header row (styled bold).

**CSV parsing:** Minimal implementation in `csv.ts` — comma-separated, newline rows, double-quote escaping for cells containing commas.

**Formula cells:** Any cell value starting with `=` is evaluated via `@formulajs/formulajs`. Cell references use A1 notation (`A1`, `B2:B10`). Non-formula cells are displayed as-is.

---

## Data Flow

```
[Markdown file]                      [.csv file]
  ```csv                               2026-05,餐饮,45
  日期,金额                             2026-05,收入,8000
  5月1日,45
  ```
       ↓ moraya-core markdown parse         ↓ Tauri fs.readTextFile
  spreadsheet node (attrs.source)      raw CSV string
       ↓ NodeView + factory inject          ↓ direct prop
  MiniSpreadsheet.svelte           MiniSpreadsheet.svelte
       ↓ onChange(csv)                      ↓ onChange(csv)
  PM transaction (update attrs.source)  Tauri fs.writeTextFile
```

---

## Feature Scope (v1)

**In:**
- Editable cells with Tab/Shift+Tab (horizontal), Enter/Shift+Enter (vertical) navigation
- Add row at bottom, delete selected row
- Add column at right, delete selected column
- Formula evaluation: `=SUM(B2:B5)`, `=AVG(...)`, `=COUNT(...)`, `=A1+B1`, `=A1*0.1`
- A1 cell reference resolution within the same sheet
- Header row (first row): bold styling
- Column width: resizable via drag (RevoGrid built-in)
- Slash command: `电子表格` / `spreadsheet` / `sheet` / `csv` → inserts 3×4 empty block

**Explicitly out (v1):**
- Cell formatting (color, font, bold/italic per cell)
- Cell merging
- Freeze rows/panes
- Charts or visualizations
- Cross-sheet references
- Import/export beyond CSV

---

## moraya-core Changes

### 1. `schema.ts` — new `spreadsheet` node

```ts
const spreadsheet: NodeSpec = {
  group: 'block',
  atom: true,
  selectable: true,
  attrs: { source: { default: '' } },
  parseDOM: [{ tag: 'div[data-spreadsheet]', getAttrs: (dom) => ({ source: dom.getAttribute('data-source') ?? '' }) }],
  toDOM(node) { return ['div', { 'data-spreadsheet': '', 'data-source': node.attrs.source }] },
}
```

### 2. `markdown.ts` — serialize/parse

- **Parse:** ` ```csv ` fenced block → `spreadsheet` node with `attrs.source = content`
- **Serialize:** `spreadsheet` node → ` ```csv\n{source}\n``` `

### 3. `types.ts` — extend SchemaConfig

```ts
export interface SchemaConfig {
  mediaResolver: MediaResolver
  rendererRegistry?: RendererRegistry
  linkOpener?: LinkOpener
  spreadsheetViewFactory?: SpreadsheetViewFactory  // NEW
}

export interface SpreadsheetViewFactory {
  create(
    container: HTMLElement,
    source: string,
    onChange: (csv: string) => void
  ): { destroy(): void }
}
```

### 4. `setup.ts` — register NodeView

When `spreadsheetViewFactory` is provided in config, register a NodeView for `spreadsheet` that calls `factory.create(dom, node.attrs.source, onChange)` and dispatches `setNodeMarkup` transactions on change.

When `spreadsheetViewFactory` is **not** provided (e.g., in tests or headless serialization), the NodeView renders a plain `<pre class="spreadsheet-fallback">` showing the raw CSV source. The node remains selectable and deletable.

---

## mdeditor Changes

### New files

| File | Responsibility |
|------|---------------|
| `src/lib/spreadsheet/csv.ts` | Parse/serialize CSV string ↔ `string[][]` |
| `src/lib/spreadsheet/formula.ts` | Wrap `@formulajs/formulajs`: evaluate cell, resolve A1 refs |
| `src/lib/spreadsheet/MiniSpreadsheet.svelte` | RevoGrid wrapper with formula layer |
| `src/lib/adapters/spreadsheet-factory.ts` | `SpreadsheetViewFactory` impl using Svelte `mount()` |
| `src/components/CsvEditor.svelte` | Standalone tab for `.csv` files; debounced autosave (500 ms) via Tauri fs on every onChange |

### Modified files

| File | Change |
|------|--------|
| `src/components/EditorPane.svelte` | Detect `.csv` extension → mount `CsvEditor` |
| `src/components/RichEditor.svelte` | Pass `spreadsheetFactory` to editor setup |
| `src/lib/slash-menu/slash-items.ts` | Add `电子表格` slash item |

---

## MiniSpreadsheet Internal Design

```
csvSource (string)
   ↓ csv.parse()
rawGrid: string[][]   ← source of truth, includes raw formulas
   ↓ formula.evaluateGrid(rawGrid)
displayGrid: string[][] ← what RevoGrid renders
   ↓
RevoGrid columns + source

On cell focus:    show rawGrid[row][col]   (formula string)
On cell blur:     show displayGrid[row][col] (evaluated result)
On edit commit:   update rawGrid → recompute displayGrid → onChange(csv.serialize(rawGrid))
```

---

## Slash Command

```ts
{
  id: 'spreadsheet',
  label: '电子表格',
  keywords: ['spreadsheet', 'sheet', 'csv', '表格', '电子表格', '记账'],
  icon: '⊞',
  desc: '可编辑电子表格（支持公式）',
  execute: (v) => insertSpreadsheetSync(v),  // inserts 3×4 empty CSV block
}
```

---

## Dependencies to Add

```
pnpm add @revolist/svelte-datagrid @formulajs/formulajs
```

Both MIT licensed.
