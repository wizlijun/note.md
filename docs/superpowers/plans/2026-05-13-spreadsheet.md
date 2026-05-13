# Spreadsheet Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add editable spreadsheet blocks inside Markdown documents and spreadsheet UI for `.csv` files, with formula support.

**Architecture:** New `spreadsheet` ProseMirror node in moraya-core (serialized as ` ```csv ` fences); a `MiniSpreadsheet.svelte` component using `@revolist/svelte-datagrid` as the grid and a custom `formula.ts` evaluator; a `CsvEditor.svelte` standalone tab for `.csv` files. moraya-core accepts an injected `SpreadsheetViewFactory` to stay framework-agnostic.

**Tech Stack:** Svelte 5, ProseMirror, `@revolist/svelte-datagrid` (MIT grid), `@formulajs/formulajs` (MIT formulas), Tauri fs for CSV file I/O.

**Spec:** `docs/superpowers/specs/2026-05-13-spreadsheet-design.md`

---

## File Map

| Status | File | Change |
|--------|------|--------|
| CREATE | `mdeditor/src/lib/spreadsheet/csv.ts` | Parse/serialize CSV string ↔ `string[][]` |
| CREATE | `mdeditor/src/lib/spreadsheet/csv.test.ts` | Unit tests |
| CREATE | `mdeditor/src/lib/spreadsheet/formula.ts` | Formula evaluator (SUM/AVG/COUNT/A1 refs) |
| CREATE | `mdeditor/src/lib/spreadsheet/formula.test.ts` | Unit tests |
| CREATE | `mdeditor/src/lib/spreadsheet/MiniSpreadsheet.svelte` | RevoGrid wrapper with formula display layer |
| CREATE | `mdeditor/src/lib/adapters/spreadsheet-factory.ts` | `SpreadsheetViewFactory` impl (Svelte `mount()`) |
| CREATE | `mdeditor/src/components/CsvEditor.svelte` | Standalone tab for `.csv` files |
| MODIFY | `mdeditor/src/lib/fs.ts` | Add `'spreadsheet'` to `FileKind`; change `.csv`/`.tsv` kind |
| MODIFY | `mdeditor/src/components/EditorPane.svelte` | Add `{:else if tab.kind === 'spreadsheet'}` branch |
| MODIFY | `mdeditor/src/lib/editor-bridge.ts` | Pass `spreadsheetViewFactory` to `coreCreateEditor` |
| MODIFY | `mdeditor/src/lib/slash-menu/slash-items.ts` | Add `电子表格` slash item |
| MODIFY | `moraya-core/src/schema.ts` | Add `spreadsheet` NodeSpec |
| MODIFY | `moraya-core/src/markdown.ts` | Fence override for `csv` + serializer for `spreadsheet` |
| MODIFY | `moraya-core/src/types.ts` | Add `SpreadsheetViewFactory` interface + SchemaConfig field |
| MODIFY | `moraya-core/src/setup.ts` | Add `spreadsheetViewFactory` to opts + NodeView wiring |
| MODIFY | `moraya-core/src/index.ts` | Export `SpreadsheetViewFactory` type |

---

## Task 1: Install dependencies

**Files:** `mdeditor/package.json`, `mdeditor/pnpm-lock.yaml`

- [ ] **Step 1: Install packages**

```bash
cd /Users/bruce/git/mdeditor
pnpm add @revolist/svelte-datagrid @formulajs/formulajs
```

Expected output: `dependencies` in `package.json` now includes both packages.

- [ ] **Step 2: Verify install**

```bash
ls node_modules/@revolist/svelte-datagrid && ls node_modules/@formulajs/formulajs
```

Expected: both directories exist.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @revolist/svelte-datagrid and @formulajs/formulajs dependencies"
```

---

## Task 2: CSV parse/serialize utility

**Files:**
- Create: `mdeditor/src/lib/spreadsheet/csv.ts`
- Create: `mdeditor/src/lib/spreadsheet/csv.test.ts`

- [ ] **Step 1: Write failing tests**

Create `mdeditor/src/lib/spreadsheet/csv.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseCsv, serializeCsv } from './csv'

describe('parseCsv', () => {
  it('parses simple CSV', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
  })

  it('handles quoted cell with comma', () => {
    expect(parseCsv('"a,b",c')).toEqual([['a,b', 'c']])
  })

  it('handles escaped double quote inside quoted cell', () => {
    expect(parseCsv('"say ""hi""",ok')).toEqual([['say "hi"', 'ok']])
  })

  it('returns 3x3 empty grid for empty string', () => {
    expect(parseCsv('')).toEqual([['', '', ''], ['', '', ''], ['', '', '']])
  })

  it('skips blank lines', () => {
    expect(parseCsv('a,b\n\nc,d')).toEqual([['a', 'b'], ['c', 'd']])
  })
})

describe('serializeCsv', () => {
  it('serializes simple grid', () => {
    expect(serializeCsv([['a', 'b'], ['1', '2']])).toBe('a,b\n1,2')
  })

  it('escapes cells containing commas', () => {
    expect(serializeCsv([['a,b', 'c']])).toBe('"a,b",c')
  })

  it('escapes cells containing double quotes', () => {
    expect(serializeCsv([['say "hi"']])).toBe('"say ""hi"""')
  })

  it('round-trips', () => {
    const original = [['日期', '金额', '备注'], ['2026-05-01', '-45', '午餐,外卖']]
    expect(parseCsv(serializeCsv(original))).toEqual(original)
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd /Users/bruce/git/mdeditor && pnpm test -- src/lib/spreadsheet/csv.test.ts
```

Expected: fail with "Cannot find module './csv'"

- [ ] **Step 3: Implement csv.ts**

Create `mdeditor/src/lib/spreadsheet/csv.ts`:

```typescript
const EMPTY_GRID = (): string[][] => [['', '', ''], ['', '', ''], ['', '', '']]

export function parseCsv(text: string): string[][] {
  if (!text.trim()) return EMPTY_GRID()
  const rows: string[][] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    rows.push(parseLine(line))
  }
  return rows.length ? rows : EMPTY_GRID()
}

function parseLine(line: string): string[] {
  const cells: string[] = []
  let i = 0
  while (i <= line.length) {
    if (i === line.length) { cells.push(''); break }
    if (line[i] === '"') {
      let cell = ''
      i++
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { cell += '"'; i += 2 }
        else if (line[i] === '"') { i++; break }
        else { cell += line[i++] }
      }
      cells.push(cell)
      if (line[i] === ',') i++
      else break
    } else {
      const end = line.indexOf(',', i)
      if (end === -1) { cells.push(line.slice(i)); break }
      cells.push(line.slice(i, end))
      i = end + 1
    }
  }
  return cells
}

export function serializeCsv(rows: string[][]): string {
  return rows.map(row => row.map(escapeCell).join(',')).join('\n')
}

function escapeCell(cell: string): string {
  if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
    return '"' + cell.replace(/"/g, '""') + '"'
  }
  return cell
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd /Users/bruce/git/mdeditor && pnpm test -- src/lib/spreadsheet/csv.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spreadsheet/csv.ts src/lib/spreadsheet/csv.test.ts
git commit -m "feat: add CSV parse/serialize utility"
```

---

## Task 3: Formula evaluator

**Files:**
- Create: `mdeditor/src/lib/spreadsheet/formula.ts`
- Create: `mdeditor/src/lib/spreadsheet/formula.test.ts`

- [ ] **Step 1: Write failing tests**

Create `mdeditor/src/lib/spreadsheet/formula.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { evaluateGrid } from './formula'

describe('evaluateGrid', () => {
  it('returns non-formula cells unchanged', () => {
    expect(evaluateGrid([['hello', '42', '']])).toEqual([['hello', '42', '']])
  })

  it('evaluates simple arithmetic =A1+B1', () => {
    const grid = [['10', '20', '=A1+B1']]
    expect(evaluateGrid(grid)[0][2]).toBe('30')
  })

  it('evaluates =SUM(A1:A3)', () => {
    const grid = [['10'], ['20'], ['30'], ['=SUM(A1:A3)']]
    expect(evaluateGrid(grid)[3][0]).toBe('60')
  })

  it('evaluates =AVG(A1:A3)', () => {
    const grid = [['10'], ['20'], ['30'], ['=AVG(A1:A3)']]
    expect(evaluateGrid(grid)[3][0]).toBe('20')
  })

  it('evaluates =COUNT(A1:A3)', () => {
    const grid = [['10'], ['20'], ['hello'], ['=COUNT(A1:A3)']]
    expect(evaluateGrid(grid)[3][0]).toBe('2')
  })

  it('evaluates =A1*0.1', () => {
    const grid = [['200', '=A1*0.1']]
    expect(evaluateGrid(grid)[0][1]).toBe('20')
  })

  it('returns #ERR for syntax errors', () => {
    expect(evaluateGrid([['=SUM((']]))[0][0]).toBe('#ERR')
  })

  it('does not evaluate non-formula strings starting with = in quoted context', () => {
    const grid = [['normal', '=B1']]
    // B1 is 'normal' which is NaN — cell ref resolves to 0 for arithmetic
    expect(evaluateGrid(grid)[0][1]).toBe('0')
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd /Users/bruce/git/mdeditor && pnpm test -- src/lib/spreadsheet/formula.test.ts
```

Expected: fail with "Cannot find module './formula'"

- [ ] **Step 3: Implement formula.ts**

Create `mdeditor/src/lib/spreadsheet/formula.ts`:

```typescript
export function evaluateGrid(grid: string[][]): string[][] {
  return grid.map((row, ri) =>
    row.map((cell, ci) => evaluateCell(cell, grid, ri, ci))
  )
}

function evaluateCell(cell: string, grid: string[][], _row: number, _col: number): string {
  if (!cell.startsWith('=')) return cell
  try {
    const expr = resolveRefs(cell.slice(1), grid)
    // eslint-disable-next-line no-new-func
    const result = new Function(`"use strict"; return (${expr})`)()
    if (result === null || result === undefined || (typeof result === 'number' && isNaN(result))) {
      return '#ERR'
    }
    // Round floating point to 10 decimal places to avoid 0.1+0.2 noise
    if (typeof result === 'number') {
      return String(parseFloat(result.toFixed(10)))
    }
    return String(result)
  } catch {
    return '#ERR'
  }
}

function resolveRefs(expr: string, grid: string[][]): string {
  let out = expr
  // SUM(range)
  out = out.replace(/\bSUM\(([A-Z]+\d+):([A-Z]+\d+)\)/gi, (_, s, e) => {
    const vals = rangeVals(s, e, grid)
    return String(vals.reduce((a, b) => a + b, 0))
  })
  // AVG(range)
  out = out.replace(/\bAVG\(([A-Z]+\d+):([A-Z]+\d+)\)/gi, (_, s, e) => {
    const vals = rangeVals(s, e, grid)
    return vals.length ? String(vals.reduce((a, b) => a + b, 0) / vals.length) : '0'
  })
  // COUNT(range) — counts numeric cells only
  out = out.replace(/\bCOUNT\(([A-Z]+\d+):([A-Z]+\d+)\)/gi, (_, s, e) =>
    String(rangeVals(s, e, grid).length)
  )
  // Single cell ref e.g. A1, B2 (must come after range replacements)
  out = out.replace(/\b([A-Z]+)(\d+)\b/gi, (_, col, row) => {
    const ci = colIdx(col)
    const ri = parseInt(row) - 1
    const val = grid[ri]?.[ci] ?? ''
    if (val.startsWith('=')) return '0' // circular ref guard
    const n = parseFloat(val)
    return isNaN(n) ? '0' : String(n)
  })
  return out
}

function colIdx(col: string): number {
  return col.toUpperCase().charCodeAt(0) - 65
}

function parseRef(ref: string): [number, number] {
  const m = ref.match(/^([A-Z]+)(\d+)$/i)!
  return [parseInt(m[2]) - 1, colIdx(m[1])]
}

function rangeVals(start: string, end: string, grid: string[][]): number[] {
  const [sr, sc] = parseRef(start)
  const [er, ec] = parseRef(end)
  const vals: number[] = []
  for (let r = sr; r <= er; r++) {
    for (let c = sc; c <= ec; c++) {
      const v = grid[r]?.[c] ?? ''
      const n = parseFloat(v)
      if (!isNaN(n)) vals.push(n)
    }
  }
  return vals
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd /Users/bruce/git/mdeditor && pnpm test -- src/lib/spreadsheet/formula.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spreadsheet/formula.ts src/lib/spreadsheet/formula.test.ts
git commit -m "feat: add formula evaluator (SUM/AVG/COUNT/A1 refs)"
```

---

## Task 4: Add 'spreadsheet' FileKind to fs.ts

**Files:**
- Modify: `mdeditor/src/lib/fs.ts`

- [ ] **Step 1: Change FileKind type and .csv/.tsv entry**

In `mdeditor/src/lib/fs.ts`, make two edits:

**Edit 1** — extend the type:
```typescript
// OLD
export type FileKind = 'markdown' | 'html' | 'code' | 'image'
// NEW
export type FileKind = 'markdown' | 'html' | 'code' | 'image' | 'spreadsheet'
```

**Edit 2** — change `.csv` and `.tsv` entries in the extension map (around line 46-47):
```typescript
// OLD
  csv:       { kind: 'code', language: '' },
  tsv:       { kind: 'code', language: '' },
// NEW
  csv:       { kind: 'spreadsheet' },
  tsv:       { kind: 'spreadsheet' },
```

- [ ] **Step 2: Fix TypeScript — check for new kind in autosave**

Open `mdeditor/src/lib/autosave.svelte.ts`. The autosave loop already skips `kind === 'image'`. No changes needed — `'spreadsheet'` tabs have `currentContent` (the CSV text) and should autosave normally.

- [ ] **Step 3: Type-check**

```bash
cd /Users/bruce/git/mdeditor && pnpm check 2>&1 | grep -i "error\|warn" | head -20
```

Expected: no new errors (there may be pre-existing warnings).

- [ ] **Step 4: Commit**

```bash
git add src/lib/fs.ts
git commit -m "feat: add 'spreadsheet' FileKind; .csv/.tsv files now open as spreadsheet"
```

---

## Task 5: MiniSpreadsheet.svelte component

**Files:**
- Create: `mdeditor/src/lib/spreadsheet/MiniSpreadsheet.svelte`

This is the core UI component. It wraps `@revolist/svelte-datagrid` and applies the formula display layer.

**How it works:**
- `rawGrid` (state): the source of truth, stores raw formulas and values
- `displayGrid` (derived): evaluated version of `rawGrid`
- RevoGrid renders `displayGrid` values
- On cell edit commit (`afteredit` event): write back to `rawGrid`, re-evaluate, call `onChange`
- When user focuses a formula cell to edit: show raw formula (handled via `beforecelledit` event)

- [ ] **Step 1: Create MiniSpreadsheet.svelte**

Create `mdeditor/src/lib/spreadsheet/MiniSpreadsheet.svelte`:

```svelte
<script lang="ts">
  import { RevoGrid } from '@revolist/svelte-datagrid'
  import type { ColumnRegular } from '@revolist/svelte-datagrid'
  import { parseCsv, serializeCsv } from './csv'
  import { evaluateGrid } from './formula'

  let {
    csvSource = '',
    onChange,
  }: {
    csvSource: string
    onChange: (csv: string) => void
  } = $props()

  let rawGrid = $state<string[][]>(parseCsv(csvSource))
  const displayGrid = $derived(evaluateGrid(rawGrid))

  // Rebuild rawGrid when csvSource changes externally (undo/redo, file reload)
  let prevSource = csvSource
  $effect(() => {
    if (csvSource !== prevSource) {
      prevSource = csvSource
      rawGrid = parseCsv(csvSource)
    }
  })

  function colName(i: number): string {
    return String.fromCharCode(65 + i)
  }

  const columns = $derived<ColumnRegular[]>(
    Array.from({ length: Math.max(...rawGrid.map(r => r.length), 1) }, (_, i) => ({
      prop: String(i),
      name: colName(i),
      size: 120,
      editor: 'text',
    }))
  )

  const source = $derived(
    displayGrid.map(row => Object.fromEntries(row.map((cell, i) => [String(i), cell])))
  )

  // afteredit: user committed a cell edit — update rawGrid
  function handleAfterEdit(e: CustomEvent<{ prop: string; val: unknown; rowIndex: number }>) {
    const col = parseInt(e.detail.prop)
    const row = e.detail.rowIndex
    const val = String(e.detail.val ?? '')
    const newGrid = rawGrid.map(r => [...r])
    while ((newGrid[row]?.length ?? 0) <= col) newGrid[row]?.push('')
    if (newGrid[row]) newGrid[row][col] = val
    rawGrid = newGrid
    onChange(serializeCsv(rawGrid))
  }

  // beforecelledit: swap in raw formula so the editor shows "=SUM(...)" not "60"
  function handleBeforeCellEdit(e: CustomEvent<{ prop: string; model: Record<string, string>; rowIndex: number }>) {
    const col = parseInt(e.detail.prop)
    const row = e.detail.rowIndex
    const raw = rawGrid[row]?.[col] ?? ''
    if (raw.startsWith('=')) {
      // Mutate the model so RevoGrid's editor receives the raw formula
      e.detail.model[e.detail.prop] = raw
    }
  }

  function addRow() {
    const cols = Math.max(...rawGrid.map(r => r.length), 1)
    rawGrid = [...rawGrid, Array<string>(cols).fill('')]
    onChange(serializeCsv(rawGrid))
  }

  function deleteLastRow() {
    if (rawGrid.length <= 1) return
    rawGrid = rawGrid.slice(0, -1)
    onChange(serializeCsv(rawGrid))
  }

  function addCol() {
    rawGrid = rawGrid.map(r => [...r, ''])
    onChange(serializeCsv(rawGrid))
  }

  function deleteLastCol() {
    if ((rawGrid[0]?.length ?? 0) <= 1) return
    rawGrid = rawGrid.map(r => r.slice(0, -1))
    onChange(serializeCsv(rawGrid))
  }
</script>

<div class="mini-spreadsheet">
  <div class="grid-wrap">
    <RevoGrid
      {columns}
      {source}
      theme="compact"
      resize={true}
      on:afteredit={handleAfterEdit}
      on:beforecelledit={handleBeforeCellEdit}
    />
  </div>
  <div class="sheet-toolbar">
    <button class="sheet-btn" onclick={addRow} title="添加行">＋行</button>
    <button class="sheet-btn" onclick={deleteLastRow} title="删除末行">－行</button>
    <span class="sheet-sep">|</span>
    <button class="sheet-btn" onclick={addCol} title="添加列">＋列</button>
    <button class="sheet-btn" onclick={deleteLastCol} title="删除末列">－列</button>
  </div>
</div>

<style>
  .mini-spreadsheet {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 160px;
  }
  .grid-wrap {
    flex: 1;
    overflow: auto;
  }
  .sheet-toolbar {
    display: flex;
    gap: 4px;
    align-items: center;
    padding: 4px 8px;
    border-top: 1px solid var(--border-color, #ddd);
    background: var(--bg-secondary, #f5f5f5);
    flex-shrink: 0;
  }
  .sheet-btn {
    padding: 2px 8px;
    font-size: 12px;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 3px;
    background: var(--bg-primary, #fff);
    cursor: pointer;
    color: var(--text-primary, #333);
  }
  .sheet-btn:hover {
    background: var(--bg-hover, #e8e8e8);
  }
  .sheet-sep {
    color: var(--border-color, #ccc);
    padding: 0 2px;
  }
</style>
```

> **Note:** The exact event names (`beforecelledit`, `afteredit`) should be verified against `@revolist/svelte-datagrid`'s Svelte 5 examples. The grid mounts via the standard Svelte component API. If event names differ, check `node_modules/@revolist/svelte-datagrid/dist` or the library's changelog.

- [ ] **Step 2: Commit**

```bash
git add src/lib/spreadsheet/MiniSpreadsheet.svelte
git commit -m "feat: add MiniSpreadsheet Svelte component (RevoGrid + formula layer)"
```

---

## Task 6: CsvEditor.svelte — standalone tab for .csv files

**Files:**
- Create: `mdeditor/src/components/CsvEditor.svelte`

- [ ] **Step 1: Create CsvEditor.svelte**

Create `mdeditor/src/components/CsvEditor.svelte`:

```svelte
<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { setContent } from '../lib/tabs.svelte'
  import MiniSpreadsheet from '../lib/spreadsheet/MiniSpreadsheet.svelte'

  let { tab }: { tab: Tab } = $props()

  function handleChange(csv: string) {
    setContent(tab.id, csv)
  }
</script>

<div class="csv-editor">
  {#key tab.id}
    <MiniSpreadsheet csvSource={tab.currentContent} onChange={handleChange} />
  {/key}
</div>

<style>
  .csv-editor {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/CsvEditor.svelte
git commit -m "feat: add CsvEditor standalone tab component"
```

---

## Task 7: Wire CsvEditor into EditorPane.svelte

**Files:**
- Modify: `mdeditor/src/components/EditorPane.svelte`

- [ ] **Step 1: Add import and spreadsheet branch**

In `mdeditor/src/components/EditorPane.svelte`:

**Add import** (after the existing imports, around line 10):
```typescript
import CsvEditor from './CsvEditor.svelte'
```

**Add branch** in the template. Find this block (around line 73):
```svelte
{#if tab.kind === 'image'}
```

Add a new branch BEFORE the `{:else}` fallthrough (which handles `RichEditor`). The full updated conditional should be:

```svelte
{#if tab.kind === 'image'}
  {#key tab.id}
    <div class="image-preview-wrap">
      <img
        class="image-preview"
        src={`${convertFileSrc(tab.filePath)}?v=${tab.lastKnownMtime}`}
        alt={tab.title}
      />
    </div>
  {/key}
{:else if tab.kind === 'spreadsheet'}
  {#key tab.id}
    <CsvEditor {tab} />
  {/key}
{:else if tab.mode === 'source'}
  {#key tab.id}
    <SourceView value={tab.currentContent} oninput={onSourceInput} tabId={tab.id} />
  {/key}
{:else if tab.kind === 'html'}
  {#key tab.id}
    <HtmlPreview html={tab.currentContent} />
  {/key}
{:else}
  {#key tab.id}
    <RichEditor
      {tab}
      onFlush={onRichFlush}
      wrapAsCodeBlock={tab.kind === 'code' ? (tab.language ?? '') : undefined}
    />
  {/key}
{/if}
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/bruce/git/mdeditor && pnpm check 2>&1 | grep -i "error" | head -20
```

Expected: no new type errors.

- [ ] **Step 3: Manual smoke test — open a .csv file**

Start the dev server:
```bash
cd /Users/bruce/git/mdeditor && pnpm dev
```

Create a test file `/tmp/test.csv`:
```
日期,分类,金额
2026-05-01,餐饮,-45
2026-05-02,收入,8000
```

Open the file in mdeditor. Expected: the spreadsheet grid renders with the data (not raw text). The toolbar shows `＋行 －行 | ＋列 －列`.

- [ ] **Step 4: Test editing**

Click a cell and edit it. Expected: the cell updates; the file autosaves.

- [ ] **Step 5: Commit**

```bash
git add src/components/EditorPane.svelte
git commit -m "feat: route .csv files to CsvEditor spreadsheet view"
```

---

## Task 8: moraya-core — Add `spreadsheet` node to schema

**Files:**
- Modify: `moraya-core/src/schema.ts`

- [ ] **Step 1: Add spreadsheet NodeSpec**

In `moraya-core/src/schema.ts`, after the `── Table NodeSpecs ──` section (around line 462), add:

```typescript
// ── Spreadsheet NodeSpec ─────────────────────────────────────────
const spreadsheet: NodeSpec = {
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { source: { default: '' } },
  parseDOM: [{
    tag: 'div[data-spreadsheet]',
    getAttrs(dom: HTMLElement) {
      return { source: dom.getAttribute('data-source') ?? '' }
    },
  }],
  toDOM(node) {
    return ['div', { 'data-spreadsheet': '', 'data-source': node.attrs.source as string }]
  },
}
```

- [ ] **Step 2: Register the node in buildNodes**

In `buildNodes()`, find the table entries (around line 915 area where `table,` is listed):
```typescript
// Find this block:
    table,
    table_header_row,
    table_row,
    table_header,
    table_cell,
// Add spreadsheet AFTER:
    spreadsheet,
```

- [ ] **Step 3: Type-check moraya-core**

```bash
cd /Users/bruce/git/moraya-core && npx tsc --noEmit 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/bruce/git/moraya-core
git add src/schema.ts
git commit -m "feat: add spreadsheet atom node to ProseMirror schema"
```

---

## Task 9: moraya-core — Markdown serialization for spreadsheet

**Files:**
- Modify: `moraya-core/src/markdown.ts`

Two changes: (A) parse ` ```csv ` fences → `spreadsheet` nodes; (B) serialize `spreadsheet` nodes → ` ```csv ` fences.

- [ ] **Step 1: Override fence tokenHandler in MorayaMarkdownParser constructor**

In `moraya-core/src/markdown.ts`, inside the `MorayaMarkdownParser` constructor (after line 391 where `super(schemaArg, md, parserTokens)` is called, and after the `const h = ...` assignment), add:

```typescript
    // ── CSV fence → spreadsheet node ──────────────────────────────
    // Override the default fence handler: when language is 'csv' and the
    // schema has a spreadsheet node, create a spreadsheet atom instead of
    // a code_block. Falls through to default for all other languages.
    const defaultFence = h['fence']
    h['fence'] = (state: any, tok: any, tokens: any[], i: number) => {
      const lang = (tok.info as string).trim().toLowerCase()
      if (lang === 'csv' && schemaArg.nodes.spreadsheet) {
        state.addNode(schemaArg.nodes.spreadsheet, { source: (tok.content as string).trim() })
        return
      }
      defaultFence!(state, tok, tokens, i)
    }
```

- [ ] **Step 2: Add spreadsheet serializer**

In `moraya-core/src/markdown.ts`, in the `MarkdownSerializer` nodes config (around line 618), find the `code_block` serializer and add `spreadsheet` right after it:

```typescript
    spreadsheet(state, node) {
      state.write('```csv\n')
      const src = node.attrs.source as string
      if (src) state.text(src, false)
      state.ensureNewLine()
      state.write('```')
      state.closeBlock(node)
    },
```

- [ ] **Step 3: Type-check moraya-core**

```bash
cd /Users/bruce/git/moraya-core && npx tsc --noEmit 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/bruce/git/moraya-core
git add src/markdown.ts
git commit -m "feat: parse/serialize csv fences as spreadsheet nodes"
```

---

## Task 10: moraya-core — SpreadsheetViewFactory interface + export

**Files:**
- Modify: `moraya-core/src/types.ts`
- Modify: `moraya-core/src/index.ts`

- [ ] **Step 1: Add SpreadsheetViewFactory to types.ts**

In `moraya-core/src/types.ts`, after the `RendererRegistry` interface, add:

```typescript
/**
 * Factory for creating the spreadsheet interactive view within a ProseMirror NodeView.
 * Implemented by consumers (mdeditor uses Svelte mount(); other hosts may differ).
 */
export interface SpreadsheetViewFactory {
  create(
    container: HTMLElement,
    source: string,
    onChange: (csv: string) => void
  ): { destroy(): void }
}
```

- [ ] **Step 2: Add spreadsheetViewFactory to SchemaConfig**

In the same file, in the `SchemaConfig` interface:

```typescript
export interface SchemaConfig {
  mediaResolver: MediaResolver
  rendererRegistry?: RendererRegistry
  linkOpener?: LinkOpener
  spreadsheetViewFactory?: SpreadsheetViewFactory  // NEW
}
```

- [ ] **Step 3: Export SpreadsheetViewFactory from index.ts**

In `moraya-core/src/index.ts`, in the DI interfaces block (around line 62):

```typescript
// DI interfaces
export type {
  MediaResolver,
  LinkOpener,
  RendererRegistry,
  RendererPluginModule,
  Platform,
  SpreadsheetViewFactory,   // NEW
} from './types'
```

- [ ] **Step 4: Type-check moraya-core**

```bash
cd /Users/bruce/git/moraya-core && npx tsc --noEmit 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/moraya-core
git add src/types.ts src/index.ts
git commit -m "feat: add SpreadsheetViewFactory DI interface"
```

---

## Task 11: moraya-core — NodeView wiring in setup.ts

**Files:**
- Modify: `moraya-core/src/setup.ts`

- [ ] **Step 1: Add SpreadsheetViewFactory to EditorPluginOptions**

In `moraya-core/src/setup.ts`, find the `EditorPluginOptions` interface (around line 667) and add:

```typescript
export interface EditorPluginOptions {
  // ... existing fields ...
  spreadsheetViewFactory?: SpreadsheetViewFactory    // NEW
}
```

Also add the import at the top of the file (check existing imports for `RendererRegistry`; add `SpreadsheetViewFactory` in the same import):

```typescript
import type {
  // ... existing ...
  SpreadsheetViewFactory,
} from './types'
```

- [ ] **Step 2: Pass factory through SchemaConfig**

In `createEditorPlugins()` (around line 748), update the `schemaConfig` construction:

```typescript
  const schemaConfig: SchemaConfig = {
    mediaResolver: opts.mediaResolver,
    ...(opts.rendererRegistry ? { rendererRegistry: opts.rendererRegistry } : {}),
    ...(opts.linkOpener ? { linkOpener: opts.linkOpener } : {}),
    ...(opts.spreadsheetViewFactory ? { spreadsheetViewFactory: opts.spreadsheetViewFactory } : {}),  // NEW
  }
```

Do the same in `createEditor()` (around line 852):

```typescript
  const schemaConfig: SchemaConfig = {
    mediaResolver: opts.mediaResolver,
    ...(opts.rendererRegistry ? { rendererRegistry: opts.rendererRegistry } : {}),
    ...(opts.linkOpener ? { linkOpener: opts.linkOpener } : {}),
    ...(opts.spreadsheetViewFactory ? { spreadsheetViewFactory: opts.spreadsheetViewFactory } : {}),  // NEW
  }
```

- [ ] **Step 3: Register the spreadsheet NodeView in createEditor()**

In `createEditor()`, after the `nodeViews.code_block = tier1.codeBlockView` line (around line 869), add:

```typescript
  const svFactory = opts.spreadsheetViewFactory
  if (svFactory && schema.nodes.spreadsheet) {
    nodeViews.spreadsheet = (
      node: import('prosemirror-model').Node,
      view: import('prosemirror-view').EditorView,
      getPos: () => number | undefined,
    ) => {
      const dom = document.createElement('div')
      dom.className = 'spreadsheet-node-view'
      let lastSource = node.attrs.source as string

      const instance = svFactory.create(dom, lastSource, (csv: string) => {
        lastSource = csv
        const pos = getPos()
        if (pos == null) return
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { source: csv }))
      })

      return {
        dom,
        destroy() { instance.destroy() },
        update(newNode: import('prosemirror-model').Node) {
          if (newNode.type.name !== 'spreadsheet') return false
          const newSource = newNode.attrs.source as string
          if (newSource === lastSource) return true
          // External change (undo/redo): let PM recreate the NodeView
          return false
        },
      }
    }
  }
```

Also add a fallback NodeView for when the factory is NOT provided (tests, headless):

```typescript
  if (!svFactory && schema.nodes.spreadsheet) {
    nodeViews.spreadsheet = (node: import('prosemirror-model').Node) => {
      const dom = document.createElement('pre')
      dom.className = 'spreadsheet-fallback'
      dom.textContent = node.attrs.source as string
      return { dom }
    }
  }
```

- [ ] **Step 4: Type-check moraya-core**

```bash
cd /Users/bruce/git/moraya-core && npx tsc --noEmit 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/moraya-core
git add src/setup.ts
git commit -m "feat: wire SpreadsheetViewFactory into createEditor NodeView"
```

---

## Task 12: Sync moraya-core to mdeditor

**Files:** moraya-core dist, mdeditor node_modules

- [ ] **Step 1: Build moraya-core**

```bash
cd /Users/bruce/git/moraya-core && npx tsup
```

Expected: `dist/` updated.

- [ ] **Step 2: Sync to mdeditor**

```bash
cd /Users/bruce/git/mdeditor && pnpm sync:core
```

Expected: "synced+vite-cache-cleared ..."

- [ ] **Step 3: Type-check mdeditor**

```bash
cd /Users/bruce/git/mdeditor && pnpm check 2>&1 | grep -i "error" | head -20
```

Expected: no new type errors.

---

## Task 13: spreadsheet-factory.ts — Svelte bridge

**Files:**
- Create: `mdeditor/src/lib/adapters/spreadsheet-factory.ts`

- [ ] **Step 1: Create spreadsheet-factory.ts**

Create `mdeditor/src/lib/adapters/spreadsheet-factory.ts`:

```typescript
import type { SpreadsheetViewFactory } from '@moraya/core'
import { mount, unmount } from 'svelte'

export const spreadsheetFactory: SpreadsheetViewFactory = {
  create(container, source, onChange) {
    // Svelte 5 mount() returns the component instance
    const app = mount(
      // Dynamic import to avoid loading RevoGrid until first spreadsheet node is encountered
      (await import('../spreadsheet/MiniSpreadsheet.svelte')).default,
      {
        target: container,
        props: { csvSource: source, onChange },
      }
    )
    return {
      destroy() {
        try { unmount(app) } catch { /* ignore */ }
      },
    }
  },
}
```

Wait — the `create` method is synchronous in the interface but we need to dynamic-import the Svelte component. Adjust:

```typescript
import type { SpreadsheetViewFactory } from '@moraya/core'
import { mount, unmount } from 'svelte'
import MiniSpreadsheet from '../spreadsheet/MiniSpreadsheet.svelte'

export const spreadsheetFactory: SpreadsheetViewFactory = {
  create(container, source, onChange) {
    const app = mount(MiniSpreadsheet, {
      target: container,
      props: { csvSource: source, onChange },
    })
    return {
      destroy() {
        try { unmount(app) } catch { /* ignore */ }
      },
    }
  },
}
```

> Note: Svelte 5's `mount()` is synchronous when props are passed directly. `unmount()` is the proper cleanup function (not `$destroy()`).

- [ ] **Step 2: Type-check**

```bash
cd /Users/bruce/git/mdeditor && pnpm check 2>&1 | grep -i "error" | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/adapters/spreadsheet-factory.ts
git commit -m "feat: add SpreadsheetViewFactory Svelte bridge adapter"
```

---

## Task 14: Wire spreadsheetFactory into editor-bridge.ts

**Files:**
- Modify: `mdeditor/src/lib/editor-bridge.ts`

- [ ] **Step 1: Add spreadsheetFactory to mountRichEditor call**

In `mdeditor/src/lib/editor-bridge.ts`:

**Add import** (after existing imports):
```typescript
import { spreadsheetFactory } from './adapters/spreadsheet-factory'
```

**Pass to createEditor** (in the `coreCreateEditor` call):
```typescript
  return coreCreateEditor({
    container: root,
    initialContent,
    mediaResolver: tauriMediaResolver,
    rendererRegistry,
    linkOpener: tauriLinkOpener,
    platform,
    spreadsheetViewFactory: spreadsheetFactory,   // NEW
    enableMath: true,
    enableMermaid: true,
    enableTableResize: true,
    enableImageSelection: true,
    enableHistory: true,
    onChange,
    changeDebounceMs: 200,
  })
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/bruce/git/mdeditor && pnpm check 2>&1 | grep -i "error" | head -20
```

Expected: no errors.

- [ ] **Step 3: Manual smoke test — embedded block**

Start dev server and open a `.md` file. Manually type:

~~~
```csv
日期,金额
2026-05-01,-45
2026-05-02,8000
=SUM(B1:B2)
```
~~~

Switch to Rich mode. Expected: a spreadsheet grid renders inside the document. The last cell should show `7955` (the evaluated SUM).

- [ ] **Step 4: Commit**

```bash
git add src/lib/editor-bridge.ts
git commit -m "feat: pass spreadsheetFactory to moraya-core createEditor"
```

---

## Task 15: Add 电子表格 slash command

**Files:**
- Modify: `mdeditor/src/lib/slash-menu/slash-items.ts`

- [ ] **Step 1: Add insertSpreadsheetSync helper function**

In `mdeditor/src/lib/slash-menu/slash-items.ts`, after the `insertTableSync` function, add:

```typescript
function insertSpreadsheetSync(v: EditorView) {
  const { schema } = v.state
  const spreadsheet = schema.nodes.spreadsheet
  if (!spreadsheet) return
  // Default 4-row × 3-column template with header row
  const defaultCsv = '列A,列B,列C\n,,\n,,\n,,'
  v.dispatch(
    v.state.tr
      .replaceSelectionWith(spreadsheet.create({ source: defaultCsv }))
      .scrollIntoView()
  )
  v.focus()
}
```

- [ ] **Step 2: Add the slash item to SLASH_ITEMS**

In the `SLASH_ITEMS` array, after the `table` entry:

```typescript
  {
    id: 'spreadsheet',
    label: '电子表格',
    keywords: ['spreadsheet', 'sheet', 'csv', '表格', '电子表格', '记账', 'excel'],
    icon: '⊞',
    desc: '可编辑电子表格（支持公式）',
    execute: (v) => insertSpreadsheetSync(v),
  },
```

- [ ] **Step 3: Run slash-items tests**

```bash
cd /Users/bruce/git/mdeditor && pnpm test -- src/lib/slash-menu/slash-items.test.ts
```

Expected: existing tests still pass (we only added a new item).

- [ ] **Step 4: Manual smoke test — slash command**

Open a `.md` file in Rich mode. Type `/电子` or `/sheet`. Expected: "电子表格" appears in the slash menu. Select it. Expected: a 4×3 spreadsheet grid is inserted.

- [ ] **Step 5: Commit**

```bash
git add src/lib/slash-menu/slash-items.ts
git commit -m "feat: add 电子表格 slash command to insert spreadsheet block"
```

---

## Self-Review Checklist

- [x] **Spec coverage check:**
  - Embedded block in Markdown → Tasks 8–11, 13–14
  - CSV file editor → Tasks 4–7
  - Formula support (SUM/AVG/COUNT/A1) → Task 3
  - Slash command → Task 15
  - Add/remove rows and columns → Task 5 (MiniSpreadsheet toolbar)
  - Tab/Enter navigation → built into RevoGrid (no custom code needed)
  - Autosave for CSV files → covered by existing autosave loop (Task 4 note)
  - Fallback NodeView (no factory) → Task 11

- [x] **Placeholder scan:** No TBDs. All code is complete. Event name caveat noted in Task 5.

- [x] **Type consistency:**
  - `SpreadsheetViewFactory.create()` signature consistent across Task 10, 11, 13
  - `parseCsv`/`serializeCsv` defined in Task 2, used in Task 5
  - `evaluateGrid` defined in Task 3, used in Task 5
  - `rawGrid`/`displayGrid` used consistently in Task 5
  - `spreadsheetFactory` created in Task 13, consumed in Task 14
