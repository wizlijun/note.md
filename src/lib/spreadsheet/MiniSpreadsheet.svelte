<script lang="ts">
  import { RevoGrid, type ColumnRegular } from '@revolist/svelte-datagrid'
  import { parseCsv, serializeCsv } from './csv'
  import { evaluateGrid } from './formula'

  let {
    csvSource,
    onChange,
  }: {
    csvSource: string
    onChange: (csv: string) => void
  } = $props()

  // rawGrid is the source of truth (may contain formulas like =A1+B1)
  // Initialised lazily in the sync effect below on first run
  let rawGrid: string[][] = $state<string[][]>([])
  let _syncedCsv = $state('')

  // Re-parse when csvSource changes externally (e.g. undo/redo)
  // Also runs on mount to perform initial parse
  $effect(() => {
    const csv = csvSource
    if (csv !== _syncedCsv) {
      _syncedCsv = csv
      rawGrid = parseCsv(csv)
    }
  })

  // displayGrid shows evaluated results
  let displayGrid = $derived(evaluateGrid(rawGrid))

  // Build RevoGrid columns from the number of columns in rawGrid
  let columns = $derived<ColumnRegular[]>(
    (rawGrid[0] ?? []).map((_, ci) => ({
      prop: String(ci),
      name: colLabel(ci),
      size: 100,
    }))
  )

  // Build RevoGrid source rows from displayGrid
  let source = $derived(
    displayGrid.map(row => {
      const obj: Record<string, string> = {}
      row.forEach((cell, ci) => { obj[String(ci)] = cell })
      return obj
    })
  )

  function colLabel(ci: number): string {
    let name = ''
    let n = ci + 1
    while (n > 0) {
      n--
      name = String.fromCharCode(65 + (n % 26)) + name
      n = Math.floor(n / 26)
    }
    return name
  }

  // Handle cell edit commit — update rawGrid with raw value, propagate
  function handleAfterEdit(e: CustomEvent) {
    const detail = e.detail as { rowIndex?: number; prop?: string | number; val?: string; value?: string }
    const rowIndex = detail.rowIndex
    const prop = detail.prop
    const val = detail.val ?? detail.value ?? ''

    if (rowIndex == null || prop == null) return
    const ci = Number(prop)
    if (isNaN(ci)) return

    // Clone to trigger reactivity
    const newGrid = rawGrid.map(row => [...row])
    if (!newGrid[rowIndex]) return
    newGrid[rowIndex][ci] = val
    rawGrid = newGrid
    onChange(serializeCsv(rawGrid))
  }

  // When cell starts editing, supply raw formula value instead of evaluated
  function handleBeforeEditStart(e: CustomEvent) {
    const detail = e.detail as {
      rowIndex?: number
      prop?: string | number
      model?: Record<string, string>
      val?: string
    }
    const rowIndex = detail.rowIndex
    const prop = detail.prop
    if (rowIndex == null || prop == null) return
    const ci = Number(prop)
    if (isNaN(ci)) return
    const raw = rawGrid[rowIndex]?.[ci] ?? ''
    // Inject raw value so the editor shows the formula, not the computed result
    if (detail.model) {
      detail.model[String(ci)] = raw
    }
    if ('val' in detail) {
      detail.val = raw
    }
  }

  // Toolbar actions
  function addRow() {
    const cols = rawGrid[0]?.length ?? 3
    rawGrid = [...rawGrid, Array(cols).fill('')]
    onChange(serializeCsv(rawGrid))
  }

  function deleteRow() {
    if (rawGrid.length <= 1) return
    rawGrid = rawGrid.slice(0, -1)
    onChange(serializeCsv(rawGrid))
  }

  function addCol() {
    rawGrid = rawGrid.map(row => [...row, ''])
    onChange(serializeCsv(rawGrid))
  }

  function deleteCol() {
    if ((rawGrid[0]?.length ?? 0) <= 1) return
    rawGrid = rawGrid.map(row => row.slice(0, -1))
    onChange(serializeCsv(rawGrid))
  }
</script>

<div class="mini-spreadsheet">
  <div class="toolbar">
    <button class="tb-btn" onclick={addRow} title="添加行">＋行</button>
    <button class="tb-btn" onclick={deleteRow} title="删除最后一行">－行</button>
    <button class="tb-btn" onclick={addCol} title="添加列">＋列</button>
    <button class="tb-btn" onclick={deleteCol} title="删除最后一列">－列</button>
  </div>
  <div class="grid-wrap">
    <RevoGrid
      {columns}
      {source}
      resize={true}
      canFocus={true}
      useClipboard={true}
      applyOnClose={true}
      on:afteredit={handleAfterEdit}
      on:beforeeditstart={handleBeforeEditStart}
    />
  </div>
</div>

<style>
  .mini-spreadsheet {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 200px;
  }

  .toolbar {
    display: flex;
    gap: 4px;
    padding: 4px 6px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, Canvas);
    flex-shrink: 0;
  }

  .tb-btn {
    padding: 2px 8px;
    font-size: 12px;
    border: 1px solid color-mix(in srgb, CanvasText 20%, Canvas);
    border-radius: 4px;
    background: Canvas;
    color: CanvasText;
    cursor: pointer;
    user-select: none;
    line-height: 1.5;
  }

  .tb-btn:hover {
    background: color-mix(in srgb, AccentColor 10%, Canvas);
    border-color: AccentColor;
  }

  .grid-wrap {
    flex: 1;
    overflow: hidden;
  }

  .grid-wrap :global(revo-grid) {
    height: 100%;
    width: 100%;
  }
</style>
