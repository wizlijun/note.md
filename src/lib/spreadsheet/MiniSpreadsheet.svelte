<script lang="ts">
  import { RevoGrid, type ColumnRegular } from '@revolist/svelte-datagrid'
  import { parseCsv, serializeCsv } from './csv'
  import { evaluateGrid } from './formula'
  import { observePrefersColorScheme } from '../theme-loader'

  let {
    csvSource,
    onChange,
  }: {
    csvSource: string
    onChange: (csv: string) => void
  } = $props()

  // Track system color scheme so RevoGrid swaps between compact light/dark.
  let isDark = $state(false)
  $effect(() => observePrefersColorScheme((dark) => { isDark = dark }))
  let theme = $derived<'compact' | 'darkCompact'>(isDark ? 'darkCompact' : 'compact')

  // rawGrid is the source of truth (may contain formulas like =A1+B1)
  let rawGrid: string[][] = $state<string[][]>([])
  let _syncedCsv = $state('')

  // Re-parse when csvSource changes externally (e.g. undo/redo)
  $effect(() => {
    const csv = csvSource
    if (csv !== _syncedCsv) {
      _syncedCsv = csv
      rawGrid = parseCsv(csv)
    }
  })

  // displayGrid shows evaluated results
  let displayGrid = $derived(evaluateGrid(rawGrid))

  let columns = $derived<ColumnRegular[]>(
    (rawGrid[0] ?? []).map((_, ci) => ({
      prop: String(ci),
      name: colLabel(ci),
      size: 110,
    }))
  )

  // Source — first row gets a class so it renders as a visual header
  let source = $derived(
    displayGrid.map((row, ri) => {
      const obj: Record<string, string> = {}
      row.forEach((cell, ci) => { obj[String(ci)] = cell })
      if (ri === 0) obj._rowClass = 'ms-header-row'
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

  function commit(newGrid: string[][]) {
    rawGrid = newGrid
    onChange(serializeCsv(newGrid))
  }

  // ── Focus + range tracking ──────────────────────────────────────
  let focusRow = $state<number | null>(null)
  let focusCol = $state<number | null>(null)
  let range = $state<{ x: number; y: number; x1: number; y1: number } | null>(null)

  function handleAfterFocus(e: CustomEvent) {
    const d = e.detail as { rowIndex?: number; colIndex?: number }
    if (typeof d.rowIndex === 'number') focusRow = d.rowIndex
    if (typeof d.colIndex === 'number') focusCol = d.colIndex
  }
  function handleSetRange(e: CustomEvent) {
    // Detail may be the RangeArea itself or wrapped in { newRange }.
    const raw = (e.detail ?? {}) as { x?: number; y?: number; x1?: number; y1?: number; newRange?: { x: number; y: number; x1: number; y1: number } }
    const r = raw.newRange ?? raw
    if (r && typeof r.x === 'number' && typeof r.y === 'number') {
      range = { x: r.x, y: r.y, x1: r.x1 ?? r.x, y1: r.y1 ?? r.y }
    } else {
      range = null
    }
  }

  // ── Edit ─────────────────────────────────────────────────────────
  function handleAfterEdit(e: CustomEvent) {
    const detail = e.detail as { rowIndex?: number; prop?: string | number; val?: string; value?: string }
    const rowIndex = detail.rowIndex
    const prop = detail.prop
    const val = detail.val ?? detail.value ?? ''
    if (rowIndex == null || prop == null) return
    const ci = Number(prop)
    if (isNaN(ci)) return
    const newGrid = rawGrid.map(row => [...row])
    if (!newGrid[rowIndex]) return
    newGrid[rowIndex][ci] = val
    commit(newGrid)
  }

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
    if (detail.model) detail.model[String(ci)] = raw
    if ('val' in detail) detail.val = raw
  }

  // ── Row / column manipulation ───────────────────────────────────
  function emptyRow(): string[] {
    const cols = rawGrid[0]?.length ?? 3
    return Array(cols).fill('')
  }
  function targetRowIndex(): number {
    if (focusRow != null && focusRow >= 0 && focusRow < rawGrid.length) return focusRow
    return rawGrid.length - 1
  }
  function targetColIndex(): number {
    if (focusCol != null && focusCol >= 0 && focusCol < (rawGrid[0]?.length ?? 0)) return focusCol
    return (rawGrid[0]?.length ?? 1) - 1
  }
  function insertRowAt(at: number) {
    const clamped = Math.max(0, Math.min(at, rawGrid.length))
    commit([...rawGrid.slice(0, clamped), emptyRow(), ...rawGrid.slice(clamped)])
  }
  function insertRowAbove() { insertRowAt(targetRowIndex()) }
  function insertRowBelow() { insertRowAt(targetRowIndex() + 1) }
  function deleteRowAt(at: number) {
    if (rawGrid.length <= 1) return
    const clamped = Math.max(0, Math.min(at, rawGrid.length - 1))
    commit([...rawGrid.slice(0, clamped), ...rawGrid.slice(clamped + 1)])
  }
  function deleteFocusedRow() { deleteRowAt(targetRowIndex()) }

  function insertColAt(at: number) {
    const width = rawGrid[0]?.length ?? 0
    const clamped = Math.max(0, Math.min(at, width))
    commit(rawGrid.map(row => [...row.slice(0, clamped), '', ...row.slice(clamped)]))
  }
  function insertColLeft() { insertColAt(targetColIndex()) }
  function insertColRight() { insertColAt(targetColIndex() + 1) }
  function deleteColAt(at: number) {
    const width = rawGrid[0]?.length ?? 0
    if (width <= 1) return
    const clamped = Math.max(0, Math.min(at, width - 1))
    commit(rawGrid.map(row => [...row.slice(0, clamped), ...row.slice(clamped + 1)]))
  }
  function deleteFocusedCol() { deleteColAt(targetColIndex()) }

  function clearSelection() {
    const r = range
    if (r) {
      const x0 = Math.min(r.x, r.x1)
      const x1 = Math.max(r.x, r.x1)
      const y0 = Math.min(r.y, r.y1)
      const y1 = Math.max(r.y, r.y1)
      const newGrid = rawGrid.map((row, ri) => {
        if (ri < y0 || ri > y1) return row
        const newRow = [...row]
        for (let ci = x0; ci <= x1; ci++) newRow[ci] = ''
        return newRow
      })
      commit(newGrid)
      return
    }
    if (focusRow != null && focusCol != null) {
      const newGrid = rawGrid.map(row => [...row])
      if (newGrid[focusRow]) newGrid[focusRow][focusCol] = ''
      commit(newGrid)
    }
  }

  // ── Keyboard: Delete / Backspace clears selection ──────────────
  function handleWrapperKeydown(e: KeyboardEvent) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    // Don't fire while a cell editor is open — the editor swallows keys itself,
    // but a focused INPUT in the grid means we should let it through.
    const ae = document.activeElement
    if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) return
    if (focusRow == null && range == null) return
    e.preventDefault()
    e.stopPropagation()
    clearSelection()
  }

  // ── Context menu ───────────────────────────────────────────────
  type MenuItem =
    | { kind: 'item'; label: string; action: () => void; disabled?: boolean }
    | { kind: 'divider' }

  let menuPos = $state<{ x: number; y: number } | null>(null)
  let menuItems = $derived<MenuItem[]>([
    { kind: 'item', label: '在上方插入行', action: insertRowAbove },
    { kind: 'item', label: '在下方插入行', action: insertRowBelow },
    { kind: 'item', label: '删除此行', action: deleteFocusedRow, disabled: rawGrid.length <= 1 },
    { kind: 'divider' },
    { kind: 'item', label: '在左侧插入列', action: insertColLeft },
    { kind: 'item', label: '在右侧插入列', action: insertColRight },
    { kind: 'item', label: '删除此列', action: deleteFocusedCol, disabled: (rawGrid[0]?.length ?? 0) <= 1 },
    { kind: 'divider' },
    { kind: 'item', label: '清空选中', action: clearSelection, disabled: focusRow == null && range == null },
  ])

  function handleContextMenu(e: MouseEvent) {
    const t = e.target as HTMLElement | null
    if (!t || !t.closest('revo-grid')) return
    e.preventDefault()
    menuPos = { x: e.clientX, y: e.clientY }
  }
  function closeMenu() { menuPos = null }
  function runMenu(action: () => void) {
    action()
    closeMenu()
  }
  function handleDocMouseDown(e: MouseEvent) {
    if (!menuPos) return
    const t = e.target as HTMLElement | null
    if (t && t.closest('.ms-context-menu')) return
    closeMenu()
  }
  function handleDocKeydown(e: KeyboardEvent) {
    if (menuPos && e.key === 'Escape') closeMenu()
  }
  $effect(() => {
    if (!menuPos) return
    window.addEventListener('mousedown', handleDocMouseDown)
    window.addEventListener('keydown', handleDocKeydown)
    return () => {
      window.removeEventListener('mousedown', handleDocMouseDown)
      window.removeEventListener('keydown', handleDocKeydown)
    }
  })
</script>

<div class="mini-spreadsheet">
  <!-- Toolbar removed: all row/col actions are available via right-click menu. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="grid-wrap"
    onkeydown={handleWrapperKeydown}
    oncontextmenu={handleContextMenu}
  >
    <RevoGrid
      {columns}
      {source}
      {theme}
      rowClass="_rowClass"
      rowHeaders={true}
      resize={true}
      range={true}
      canFocus={true}
      useClipboard={true}
      applyOnClose={true}
      on:afteredit={handleAfterEdit}
      on:beforeeditstart={handleBeforeEditStart}
      on:afterfocus={handleAfterFocus}
      on:setrange={handleSetRange}
    />
  </div>

  {#if menuPos}
    <div
      class="ms-context-menu"
      style="left: {menuPos.x}px; top: {menuPos.y}px;"
      role="menu"
    >
      {#each menuItems as item, i (i)}
        {#if item.kind === 'divider'}
          <div class="cm-divider"></div>
        {:else}
          <button
            class="cm-item"
            type="button"
            disabled={item.disabled}
            onclick={() => runMenu(item.action)}
          >{item.label}</button>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .mini-spreadsheet {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 200px;
    position: relative;
  }

  .grid-wrap {
    flex: 1;
    overflow: hidden;
  }
  .grid-wrap :global(revo-grid) {
    height: 100%;
    width: 100%;
  }
  /* Hide the bottom-corner "RevoGrid" attribution link (MIT-licensed package). */
  .grid-wrap :global(revogr-attribution) {
    display: none !important;
  }

  /* First-row visual header — bold + subtle tint. */
  .grid-wrap :global(.ms-header-row .rgCell),
  .grid-wrap :global(.ms-header-row) {
    background: color-mix(in srgb, CanvasText 6%, Canvas);
    font-weight: 600;
  }
  @media (prefers-color-scheme: dark) {
    .grid-wrap :global(.ms-header-row .rgCell),
    .grid-wrap :global(.ms-header-row) {
      background: color-mix(in srgb, CanvasText 12%, Canvas);
    }
  }

  /* Context menu */
  .ms-context-menu {
    position: fixed;
    z-index: 9999;
    background: Canvas;
    color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    padding: 4px;
    min-width: 160px;
    font-size: 13px;
  }
  .cm-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 5px 12px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: inherit;
    cursor: pointer;
    font: inherit;
    line-height: 1.4;
  }
  .cm-item:not(:disabled):hover {
    background: color-mix(in srgb, AccentColor 18%, Canvas);
  }
  .cm-item:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .cm-divider {
    height: 1px;
    background: color-mix(in srgb, CanvasText 12%, Canvas);
    margin: 4px 2px;
  }
</style>
