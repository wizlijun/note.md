<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { openFile, setContent } from '../lib/tabs.svelte'
  import { readDir, stat, readTextFile } from '@tauri-apps/plugin-fs'
  import { parentDir } from '../lib/folder-view.svelte'
  import { parseBase } from '../lib/base/parse'
  import { scanBaseDir, type ScanDeps } from '../lib/base/scan'
  import { evalFilter } from '../lib/base/filter'
  import { buildRows, sortRows, groupRows, displayCell } from '../lib/base/rows'
  import type { FileRecord, BaseRow, SortDirection, ColumnMenuAction } from '../lib/base/model'
  import { t } from '../lib/i18n/store.svelte'
  import { pushToast } from '../lib/toast.svelte'
  import * as edit from '../lib/base/edit'
  import BaseColumnMenu from './BaseColumnMenu.svelte'
  import BaseAddColumnMenu from './BaseAddColumnMenu.svelte'

  let { tab }: { tab: Tab } = $props()

  const deps: ScanDeps = {
    readDir: (d) => readDir(d),
    stat: (p) => stat(p),
    readTextFile: (p) => readTextFile(p),
  }

  const config = $derived(parseBase(tab.currentContent))
  let viewIndex = $state(0)
  const view = $derived(config.views[Math.min(viewIndex, config.views.length - 1)])

  let records = $state<FileRecord[]>([])
  let loading = $state(true)
  let clickSort = $state<{ property: string; direction: SortDirection } | null>(null)

  const editable = $derived(!config.error)
  const activeViewIndex = $derived(Math.min(viewIndex, config.views.length - 1))

  let colMenu = $state<{ x: number; y: number; col: string } | null>(null)
  let addMenu = $state<{ x: number; y: number } | null>(null)
  let dragCol = $state<string | null>(null)

  const FILE_PROPS = ['file.name', 'file.path', 'file.folder', 'file.ext', 'file.mtime', 'file.ctime', 'file.size', 'file.tags']

  const addableProps = $derived.by(() => {
    const set = new Set<string>(FILE_PROPS)
    for (const r of records) for (const k of Object.keys(r.frontmatter)) set.add('note.' + k)
    const used = new Set(columns)
    return [...set].filter((p) => !used.has(p))
  })

  $effect(() => {
    const dir = parentDir(tab.filePath)
    loading = true
    scanBaseDir(dir, deps)
      .then((r) => { records = r })
      .catch(() => { records = [] })
      .finally(() => { loading = false })
  })

  // 列顺序:view.order,缺省用记录里出现过的 frontmatter 键 + file.name
  const columns = $derived.by(() => {
    if (view.order?.length) return view.order
    const keys = new Set<string>(['file.name'])
    for (const r of records) for (const k of Object.keys(r.frontmatter)) keys.add('note.' + k)
    return [...keys]
  })

  const rows = $derived.by(() => {
    const filtered = records.filter((r) => evalFilter(config.filters, r) && evalFilter(view.filters, r))
    let built: BaseRow[] = buildRows(filtered, columns)
    const sort = clickSort ?? view.sort?.[0] ?? view.groupBy
    if (sort) built = sortRows(built, sort.property, sort.direction)
    if (typeof view.limit === 'number') built = built.slice(0, view.limit)
    return built
  })

  const groups = $derived.by(() =>
    view.groupBy ? groupRows(rows, view.groupBy.property, view.groupBy.direction) : null)

  const label = (col: string) => config.properties[col]?.displayName ?? col

  function applyRaw(nextRaw: edit.Raw) {
    const yaml = edit.toYaml(nextRaw)
    if (parseBase(yaml).error) {
      pushToast({ level: 'error', message: t('base.writeError') })
      return
    }
    setContent(tab.id, yaml)
  }

  function rawObj(): edit.Raw {
    return (config.raw ?? {}) as edit.Raw
  }

  function pickAdd(prop: string) {
    applyRaw(edit.addColumn(rawObj(), activeViewIndex, prop, columns))
  }

  function onColAction(col: string, a: ColumnMenuAction) {
    const i = activeViewIndex
    if (a.kind === 'rename') applyRaw(edit.renameColumn(rawObj(), col, a.name))
    else if (a.kind === 'sort') applyRaw(edit.setSort(rawObj(), i, col, a.direction))
    else if (a.kind === 'clearSort') applyRaw(edit.setSort(rawObj(), i, null, 'ASC'))
    else if (a.kind === 'group') applyRaw(edit.setGroupBy(rawObj(), i, col, a.direction))
    else if (a.kind === 'ungroup') applyRaw(edit.setGroupBy(rawObj(), i, null, 'ASC'))
    else if (a.kind === 'move') applyRaw(edit.moveColumn(rawObj(), i, col, columns.indexOf(col) + a.delta, columns))
    else if (a.kind === 'remove') applyRaw(edit.removeColumn(rawObj(), i, col, columns))
  }

  function openColMenu(e: MouseEvent, col: string) {
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    colMenu = { x: r.left, y: r.bottom + 2, col }
  }
  function openAddMenu(e: MouseEvent) {
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    addMenu = { x: r.left, y: r.bottom + 2 }
  }

  function onDrop(targetCol: string) {
    if (!dragCol || dragCol === targetCol) { dragCol = null; return }
    applyRaw(edit.moveColumn(rawObj(), activeViewIndex, dragCol, columns.indexOf(targetCol), columns))
    dragCol = null
  }

  const isGroupCol = (col: string) => view.groupBy?.property === col
  const isSortCol = (col: string) => view.sort?.[0]?.property === col

  function toggleSort(col: string) {
    if (clickSort?.property === col) {
      clickSort = { property: col, direction: clickSort.direction === 'ASC' ? 'DESC' : 'ASC' }
    } else {
      clickSort = { property: col, direction: 'ASC' }
    }
  }

  async function open(path: string) {
    try { await openFile(path) } catch { /* ignore */ }
  }
</script>

<div class="base-view">
  <div class="base-toolbar">
    {#if config.views.length > 1}
      <select bind:value={viewIndex} class="base-view-select">
        {#each config.views as v, i}
          <option value={i} disabled={v.type !== 'table'}>{v.name}{v.type !== 'table' ? ` (${v.type})` : ''}</option>
        {/each}
      </select>
    {:else}
      <span class="base-title">{view.name}</span>
    {/if}
    <span class="base-count">{rows.length}</span>
  </div>

  {#if config.error}
    <div class="base-empty">{t('base.parseError')}</div>
  {:else if loading}
    <div class="base-empty">{t('base.loading')}</div>
  {:else if view.type !== 'table'}
    <div class="base-empty">{t('base.unsupportedView')}</div>
  {:else if rows.length === 0}
    <div class="base-empty">{t('base.empty')}</div>
  {:else}
    <table class="base-table">
      <thead>
        <tr>
          {#each columns as col (col)}
            <th
              draggable={editable}
              ondragstart={() => (dragCol = col)}
              ondragover={(e) => { if (editable) e.preventDefault() }}
              ondrop={() => editable && onDrop(col)}
            >
              <span class="th-label" onclick={() => toggleSort(col)}>
                {label(col)}
                {#if clickSort?.property === col}<span class="sort-arrow">{clickSort.direction === 'ASC' ? '▲' : '▼'}</span>{/if}
              </span>
              {#if editable}
                <button type="button" class="th-menu-btn" title={t('base.colMenu')} onclick={(e) => openColMenu(e, col)}>⋯</button>
              {/if}
            </th>
          {/each}
          {#if editable}
            <th class="th-add">
              <button type="button" class="th-add-btn" title={t('base.addColumn')} onclick={openAddMenu}>＋</button>
            </th>
          {/if}
        </tr>
      </thead>
      <tbody>
        {#if groups}
          {#each groups as g}
            <tr class="group-head"><td colspan={columns.length}>{g.key || '—'} · {g.rows.length}</td></tr>
            {#each g.rows as row}
              {@render rowTr(row)}
            {/each}
          {/each}
        {:else}
          {#each rows as row}
            {@render rowTr(row)}
          {/each}
        {/if}
      </tbody>
    </table>
  {/if}
</div>

{#if colMenu}
  <BaseColumnMenu
    x={colMenu.x} y={colMenu.y}
    displayName={label(colMenu.col)}
    isGroup={isGroupCol(colMenu.col)}
    isSort={isSortCol(colMenu.col)}
    onAction={(a) => onColAction(colMenu!.col, a)}
    onClose={() => (colMenu = null)}
  />
{/if}
{#if addMenu}
  <BaseAddColumnMenu
    x={addMenu.x} y={addMenu.y}
    options={addableProps}
    label={label}
    onPick={pickAdd}
    onClose={() => (addMenu = null)}
  />
{/if}

{#snippet rowTr(row: BaseRow)}
  <tr class="base-row" onclick={() => open(row.record.path)}>
    {#each columns as col, i}
      <td class:name-cell={i === 0}>{i === 0 && col === 'file.name' ? row.record.name : displayCell(row.cells[col])}</td>
    {/each}
  </tr>
{/snippet}

<style>
  /* Follow the editor content theme: Canvas/CanvasText system colors track
     light/dark automatically, matching EditorPane and editor-base.css. */
  .base-view { display: flex; flex-direction: column; height: 100%; overflow: auto; background: Canvas; color: CanvasText; }
  .base-toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); position: sticky; top: 0; background: Canvas; z-index: 2; }
  .base-title { font-weight: 600; }
  .base-count { margin-left: auto; color: color-mix(in srgb, CanvasText 55%, Canvas); font-size: 12px; }
  .base-view-select { background: color-mix(in srgb, CanvasText 4%, Canvas); color: inherit; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 4px; padding: 2px 6px; }
  .base-empty { padding: 24px; color: color-mix(in srgb, CanvasText 55%, Canvas); }
  .base-table { border-collapse: collapse; width: 100%; font-size: 13px; }
  .base-table th, .base-table td { text-align: left; padding: 6px 12px; border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent); white-space: nowrap; }
  .base-table th { position: sticky; top: 37px; background: Canvas; cursor: pointer; user-select: none; z-index: 1; }
  .sort-arrow { font-size: 10px; opacity: 0.7; }
  .th-label { cursor: pointer; }
  .th-menu-btn, .th-add-btn {
    border: 0; background: transparent; color: inherit; cursor: pointer;
    font-size: 13px; padding: 0 4px; opacity: 0; margin-left: 4px; border-radius: 3px;
  }
  .base-table th:hover .th-menu-btn { opacity: 0.6; }
  .th-menu-btn:hover, .th-add-btn:hover { opacity: 1; background: color-mix(in srgb, CanvasText 10%, Canvas); }
  .th-add-btn { opacity: 0.6; }
  .th-add { width: 1%; white-space: nowrap; }
  .base-row { cursor: pointer; }
  .base-row:hover { background: color-mix(in srgb, CanvasText 6%, Canvas); }
  .name-cell { font-weight: 500; }
  .group-head td { font-weight: 600; color: color-mix(in srgb, CanvasText 70%, Canvas); background: color-mix(in srgb, CanvasText 4%, Canvas); }
</style>
