<script lang="ts">
  import '../../../src/styles/ui-foundation.css'
  import { onDestroy } from 'svelte'
  import { locale, onDocument, openLink } from './lib/bridge'
  import type { IndexDocument, IndexRow, IndexView } from './lib/model'
  import CellContent from './lib/components/CellContent.svelte'
  import Cover from './lib/components/Cover.svelte'

  const zh = locale().startsWith('zh')
  const views: { id: IndexView; label: string; path: string }[] = [
    { id: 'table', label: zh ? '表格' : 'Table', path: 'M3 3h14v14H3zM3 8h14M8 3v14M3 12h14' },
    { id: 'list', label: zh ? '分组列表' : 'Grouped list', path: 'M7 4h10M7 10h10M7 16h10M3 4h.01M3 10h.01M3 16h.01' },
    { id: 'board', label: zh ? '泳道看板' : 'Board', path: 'M3 3h5v9H3zM12 3h5v5h-5zM12 12h5v5h-5z' },
    { id: 'gallery', label: zh ? '封面画廊' : 'Gallery', path: 'M3 3h14v14H3zM3 14l4-5 4 4 3-3 3 4M12 6h.01' },
  ]
  let doc = $state<IndexDocument | null>(null)
  let view = $state<IndexView>('table')
  let query = $state('')
  let groupBy = $state('')
  let laneBy = $state('')
  let error = $state('')
  let documentVersion = 0
  const unsubscribe = onDocument((value) => {
    documentVersion++
    doc = value
    view = value.view
    query = ''
    groupBy = value.groupBy
    laneBy = value.laneBy
    error = ''
  })
  onDestroy(() => { documentVersion++; unsubscribe() })
  const filtered = $derived(doc?.rows.filter((row) => `${row.section} ${row.cells.map((cell) => cell.text).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [])
  function groupValue(row: IndexRow, column: string): string {
    return (column ? row.cells[doc!.columns.indexOf(column)]?.text : row.section)?.trim() || (zh ? '未分组' : 'Ungrouped')
  }
  const groups = $derived([...new Set(filtered.map((row) => groupValue(row, groupBy)))])
  const lanes = $derived(laneBy ? [...new Set(filtered.map((row) => groupValue(row, laneBy)))] : [''])
  const boardTooLarge = $derived(groups.length * lanes.length > 400)
  async function open(href: string) {
    if (!doc) return
    const version = documentVersion
    error = ''
    try { await openLink(doc.uri, href) }
    catch (cause) { if (version === documentVersion) error = `${zh ? '无法打开文件：' : 'Could not open file: '}${cause instanceof Error ? cause.message : String(cause)}` }
  }
</script>

{#snippet fields(row: IndexRow)}
  <dl class="fields">
    {#each doc!.columns.slice(1) as column, index}
      {#if row.cells[index + 1].text}<div><dt>{column}</dt><dd><CellContent cell={row.cells[index + 1]} {open} /></dd></div>{/if}
    {/each}
  </dl>
{/snippet}
{#snippet card(row: IndexRow)}
  <article class="card"><button class="file-name" type="button" onclick={() => open(row.href)}>{row.title}</button>{@render fields(row)}</article>
{/snippet}

<main class="ui-surface">
  {#if doc}
    <header>
      <div class="heading"><div><div class="eyebrow">{zh ? '文件索引' : 'FILE INDEX'}</div><h1>{doc.title}</h1></div><span class="total">{doc.rows.length} {zh ? '个文件' : 'files'}</span></div>
      {#if doc.description.length}<div class="description">{#each doc.description as paragraph}<p>{paragraph}</p>{/each}</div>{/if}
      <div class="toolbar">
        <div class="view-switch" role="group" aria-label={zh ? '布局' : 'Layout'}>
          {#each views as option}<button type="button" aria-label={option.label} title={option.label} aria-pressed={view === option.id} onclick={() => { view = option.id }}><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={option.path}/></svg><span>{option.label}</span></button>{/each}
        </div>
        <label class="search"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="m12 12 5 5"/></svg><input type="search" aria-label={zh ? '搜索索引' : 'Search index'} placeholder={zh ? '搜索文件与字段…' : 'Search files and fields…'} bind:value={query}/></label>
        {#if view !== 'table'}<label class="select-field"><span>{zh ? '分组' : 'Group'}</span><select aria-label={zh ? '分组字段' : 'Group by'} bind:value={groupBy}><option value="">{zh ? '章节' : 'Section'}</option>{#each doc.columns as column}<option value={column}>{column}</option>{/each}</select></label>{/if}
        {#if view === 'board'}<label class="select-field"><span>{zh ? '泳道' : 'Lane'}</span><select aria-label={zh ? '泳道字段' : 'Lane by'} bind:value={laneBy}><option value="">{zh ? '无' : 'None'}</option>{#each doc.columns as column}<option value={column}>{column}</option>{/each}</select></label>{/if}
      </div>
    </header>
    {#if error}<div class="error" role="alert">{error}</div>{/if}
    <div class="content" data-view={view}>
      {#if !filtered.length}<div class="empty"><h2>{query ? (zh ? '没有匹配的文件' : 'No matching files') : (zh ? '索引还没有文件' : 'No files in this index')}</h2><p>{query ? (zh ? '试试其他关键词。' : 'Try another search term.') : (zh ? '在 Markdown 表格中添加文件链接后，即可在此查看。' : 'Add file links to the Markdown table to see them here.')}</p></div>
      {:else if view === 'table'}
        <div class="table-scroll"><table><thead><tr>{#each doc.columns as column}<th scope="col">{column}</th>{/each}</tr></thead><tbody>{#each filtered as row (row.id)}<tr>{#each row.cells as cell, index}<td class:primary={index === 0}><CellContent {cell} {open}/></td>{/each}</tr>{/each}</tbody></table></div>
      {:else if view === 'list'}
        <div class="grouped-list">{#each groups as group}<section class="list-group"><h2>{group}<span>{filtered.filter((row) => groupValue(row, groupBy) === group).length}</span></h2>{#each filtered.filter((row) => groupValue(row, groupBy) === group) as row (row.id)}{@render card(row)}{/each}</section>{/each}</div>
      {:else if view === 'board' && boardTooLarge}
        <div class="empty" role="status"><h2>{zh ? '分组过多' : 'Too many groups'}</h2><p>{zh ? '请筛选文件或改用其他字段，以减少看板的分组与泳道。' : 'Filter files or choose other fields to reduce board columns and lanes.'}</p></div>
      {:else if view === 'board'}
        <div class="board-scroll"><div class="board" style:grid-template-columns={`${laneBy ? 'minmax(110px, 150px) ' : ''}repeat(${groups.length}, minmax(245px, 1fr))`}>
          {#if laneBy}<div class="board-corner">{laneBy} / {groupBy || (zh ? '章节' : 'Section')}</div>{/if}
          {#each groups as group}<h2 class="column-title">{group}<span>{filtered.filter((row) => groupValue(row, groupBy) === group).length}</span></h2>{/each}
          {#each lanes as lane}
            {#if laneBy}<h3 class="lane-title">{lane}</h3>{/if}
            {#each groups as group}
              {@const cellRows = filtered.filter((row) => groupValue(row, groupBy) === group && (!laneBy || groupValue(row, laneBy) === lane))}
              <section class="board-cell" aria-label={lane ? `${lane} · ${group}` : group}>
              {#if laneBy}<span class="cell-count">{cellRows.length} {zh ? '个文件' : 'files'}</span>{/if}
              {#each cellRows as row (row.id)}{@render card(row)}{:else}<span class="vacant">—</span>{/each}
            </section>{/each}
          {/each}
        </div></div>
      {:else}
        {#each groups as group}<section class="gallery-group"><h2>{group}<span>{filtered.filter((row) => groupValue(row, groupBy) === group).length}</span></h2><div class="gallery">{#each filtered.filter((row) => groupValue(row, groupBy) === group) as row (row.id)}<article class="gallery-card"><Cover uri={doc.uri} cover={row.cover} {zh}/><div class="gallery-details"><button class="file-name" type="button" onclick={() => open(row.href)}>{row.title}</button>{@render fields(row)}</div></article>{/each}</div></section>{/each}
      {/if}
    </div>
    <footer>{query ? `${filtered.length} / ${doc.rows.length}` : doc.rows.length} {zh ? '个文件' : 'files'}</footer>
  {:else}<div class="empty" role="status">{zh ? '正在载入索引…' : 'Loading index…'}</div>{/if}
</main>

<style>
  :global(html), :global(body), :global(#app) { margin: 0; min-height: 100%; }
  main { min-height: 100vh; background: var(--ui-surface); }
  header { padding: 30px 32px 20px; border-bottom: 1px solid var(--ui-separator); }
  .heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .eyebrow { color: var(--ui-tertiary); font-size: 10px; font-weight: 650; letter-spacing: .12em; margin-bottom: 6px; }
  h1 { font-size: 25px; line-height: 1.3; letter-spacing: -.035em; margin: 0; font-weight: 650; overflow-wrap: anywhere; }
  .total { flex-shrink: 0; color: var(--ui-secondary); background: var(--ui-bg); border: 1px solid var(--ui-separator); border-radius: 20px; padding: 4px 10px; font-size: 11px; }
  .description { color: var(--ui-secondary); max-width: 850px; line-height: 1.7; margin-top: 10px; }
  .description p { margin: 4px 0; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 22px; }
  .view-switch { display: flex; gap: 2px; padding: 3px; border: 1px solid var(--ui-separator); border-radius: 9px; background: var(--ui-bg); }
  .view-switch button { display: flex; align-items: center; gap: 6px; border: 0; border-radius: 6px; color: var(--ui-secondary); background: transparent; padding: 6px 9px; cursor: pointer; white-space: nowrap; font-size: 12px; }
  .view-switch button[aria-pressed='true'] { color: CanvasText; background: var(--ui-surface); box-shadow: 0 1px 3px #0002; }
  .view-switch button:hover { color: CanvasText; }
  .search { display: flex; align-items: center; gap: 8px; border: 1px solid var(--ui-control-border); border-radius: 7px; min-width: 140px; flex: 1; padding: 7px 10px; color: var(--ui-tertiary); }
  .search input { background: transparent; color: CanvasText; border: 0; min-width: 0; width: 100%; }
  .select-field { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ui-secondary); }
  select { padding: 7px 24px 7px 8px; border: 1px solid var(--ui-control-border); border-radius: 7px; color: CanvasText; background: var(--ui-surface); max-width: 150px; }
  .content { padding: 24px 32px; }
  .table-scroll, .board-scroll { overflow-x: auto; }
  table { width: 100%; border-spacing: 0; font-size: 12px; }
  th { background: var(--ui-bg); color: var(--ui-secondary); font-size: 11px; font-weight: 600; text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--ui-separator); white-space: nowrap; }
  td { padding: 14px; border-bottom: 1px solid var(--ui-separator); min-width: 100px; max-width: 450px; vertical-align: top; overflow-wrap: anywhere; }
  td.primary { min-width: 190px; font-weight: 600; }
  tbody tr:hover { background: var(--ui-hover); }
  h2 { margin: 0 0 12px; font-size: 13px; font-weight: 650; display: flex; align-items: center; gap: 9px; overflow-wrap: anywhere; }
  h2 span { font-size: 11px; color: var(--ui-tertiary); font-weight: 400; }
  .list-group, .gallery-group { margin-bottom: 28px; }
  .list-group .card { border: 0; border-bottom: 1px solid var(--ui-separator); border-radius: 0; padding: 15px 0; }
  .card { background: var(--ui-surface); border: 1px solid var(--ui-separator); border-radius: 9px; padding: 14px; min-width: 0; }
  .file-name { padding: 0; margin: 0; border: 0; background: none; color: var(--ui-accent-text); font-weight: 600; text-align: left; line-height: 1.55; cursor: pointer; overflow-wrap: anywhere; }
  .file-name:hover { text-decoration: underline; text-underline-offset: 3px; }
  .fields { display: flex; flex-direction: column; gap: 7px; margin: 10px 0 0; font-size: 11px; }
  .fields div { display: grid; grid-template-columns: minmax(45px, 28%) minmax(0, 1fr); gap: 10px; }
  dt { color: var(--ui-tertiary); overflow-wrap: anywhere; }
  dd { margin: 0; color: var(--ui-secondary); overflow-wrap: anywhere; white-space: pre-wrap; }
  .list-group .fields { display: flex; flex-direction: row; flex-wrap: wrap; column-gap: 24px; }
  .list-group .fields div { display: flex; gap: 8px; }
  .board { display: grid; gap: 12px; min-width: 100%; }
  .column-title { margin: 0; padding: 8px 4px; }
  .board-corner { color: var(--ui-tertiary); font-size: 11px; align-self: center; }
  .lane-title { font-size: 12px; margin: 0; padding: 16px 0; color: var(--ui-secondary); overflow-wrap: anywhere; }
  .board-cell { background: var(--ui-bg); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 8px; min-height: 100px; }
  .cell-count { color: var(--ui-tertiary); font-size: 10px; padding: 2px 4px; }
  .vacant { color: var(--ui-tertiary); margin: auto; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 18px; }
  .gallery-card { min-width: 0; overflow: hidden; border: 1px solid var(--ui-separator); border-radius: 10px; }
  .gallery-details { padding: 15px; }
  .empty { padding: 70px 20px; text-align: center; color: var(--ui-secondary); }
  .empty h2 { justify-content: center; font-size: 16px; color: CanvasText; }
  .empty p { font-size: 12px; }
  .error { margin: 16px 32px 0; color: var(--ui-danger); font-size: 12px; overflow-wrap: anywhere; }
  footer { padding: 0 32px 24px; font-size: 11px; color: var(--ui-tertiary); }
  @media (max-width: 650px) { header { padding: 22px 18px 16px; } .content { padding: 20px 18px; } h1 { font-size: 22px; } .view-switch button span { display: none; } .search { min-width: 120px; } .gallery { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; } .error { margin: 16px 18px 0; } footer { padding-left: 18px; } }
</style>
