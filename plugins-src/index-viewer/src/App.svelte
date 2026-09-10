<script lang="ts">
  import '../../../src/styles/ui-foundation.css'
  import { onDestroy } from 'svelte'
  import { locale, onDocument, openLink, openPage } from './lib/bridge'
  import type { IndexDocument, IndexRow, IndexSection, IndexView } from './lib/model'
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
  let view = $state<IndexView>('list')
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
  const ungrouped = zh ? '未分类' : 'Uncategorized'
  function groupValue(row: IndexRow, column: string): string {
    const value = row.cells[doc!.columns.indexOf(column)]
    const text = value?.text.trim()
    if (column === '标签' && value?.links.length) {
      return value.links.map(link => link.href.toLocaleLowerCase()).sort().map(target => /\s/.test(target) ? `#[[${target}]]` : `#${target}`).join(' ')
    }
    return (column === '标签' ? text?.split(/\s+/).map(tag => tag.toLocaleLowerCase()).sort().join(' ') : text) || ungrouped
  }
  function groupKey(row: IndexRow): string { return groupBy ? groupValue(row, groupBy) : row.sectionId }
  const groups = $derived([...new Map(filtered.map((row) => [groupKey(row), { key: groupKey(row), label: groupBy ? groupValue(row, groupBy) : row.section || ungrouped }])).values()])
  const lanes = $derived(laneBy ? [...new Set(filtered.map((row) => groupValue(row, laneBy)))] : [''])
  const boardTooLarge = $derived(groups.length * lanes.length > 400)
  type SectionNode = { section: IndexSection; rows: IndexRow[]; children: SectionNode[]; count: number }
  const sectionTree = $derived.by(() => {
    if (!doc) return []
    const nodes = new Map<string, SectionNode>(doc.sections.map((section) => [section.id, { section, rows: [], children: [], count: 0 }]))
    const roots: SectionNode[] = []
    for (const row of filtered) nodes.get(row.sectionId)?.rows.push(row)
    for (const node of nodes.values()) {
      const parent = nodes.get(node.section.parentId)
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
    function count(node: SectionNode): number {
      node.count = node.rows.length + node.children.reduce((total, child) => total + count(child), 0)
      return node.count
    }
    roots.forEach(count)
    return roots
  })
  const rootRows = $derived(filtered.filter((row) => !row.sectionId))
  const usesCategories = $derived(view === 'table' || ((view === 'list' || view === 'gallery') && !groupBy))
  async function open(href: string, kind?: 'page') {
    if (!doc) return
    const version = documentVersion
    error = ''
    try { await (kind === 'page' ? openPage(doc.uri, href) : openLink(doc.uri, href)) }
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
  <article class="card"><button class="file-name" type="button" onclick={() => open(row.href, row.linkKind)}>{row.title}</button>{@render fields(row)}</article>
{/snippet}

{#snippet rowsContent(rows: IndexRow[])}
  {#if view === 'table'}
    {#if rows.length}<div class="table-scroll"><table><thead><tr>{#each doc!.columns as column}<th scope="col">{column}</th>{/each}</tr></thead><tbody>{#each rows as row (row.id)}<tr>{#each row.cells as cell, index}<td class:primary={index === 0}><CellContent {cell} {open}/></td>{/each}</tr>{/each}</tbody></table></div>{/if}
  {:else if view === 'gallery'}
    <div class="gallery">{#each rows as row (row.id)}<article class="gallery-card"><Cover uri={doc!.uri} cover={row.cover} {zh}/><div class="gallery-details"><button class="file-name" type="button" onclick={() => open(row.href, row.linkKind)}>{row.title}</button>{@render fields(row)}</div></article>{/each}</div>
  {:else}
    <div class="list-rows">{#each rows as row (row.id)}{@render card(row)}{/each}</div>
  {/if}
{/snippet}
{#snippet sectionContent(node: SectionNode)}
  {#if node.count || !query.trim()}
    <section class="category-section" class:list-group={view === 'list'} class:gallery-group={view === 'gallery'} data-section-id={node.section.id}>
      <svelte:element this={`h${node.section.level}`} class="section-title">{node.section.title}<span>{node.count}</span></svelte:element>
      {#if node.section.description.length}<div class="section-description">{#each node.section.description as paragraph}<p>{paragraph}</p>{/each}</div>{/if}
      {@render rowsContent(node.rows)}
      {#if node.children.length}<div class="section-children">{#each node.children as child (child.section.id)}{@render sectionContent(child)}{/each}</div>{/if}
    </section>
  {/if}
{/snippet}

<main class="ui-surface">
  {#if doc}
    <header>
      <div class="heading"><div><div class="eyebrow">{zh ? '索引查看器' : 'FILE INDEX'}</div><h1>{doc.title}</h1></div><span class="total">{doc.rows.length} {zh ? '个文件' : 'files'}</span></div>
      {#if doc.description.length}<div class="description">{#each doc.description as paragraph}<p>{paragraph}</p>{/each}</div>{/if}
      <div class="toolbar">
        <div class="view-switch" role="group" aria-label={zh ? '布局' : 'Layout'}>
          {#each views as option}<button type="button" aria-label={option.label} title={option.label} aria-pressed={view === option.id} onclick={() => { view = option.id }}><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={option.path}/></svg><span>{option.label}</span></button>{/each}
        </div>
        <label class="search"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="m12 12 5 5"/></svg><input type="search" aria-label={zh ? '搜索索引' : 'Search index'} placeholder={zh ? '搜索文件与字段…' : 'Search files and fields…'} bind:value={query}/></label>
        {#if view !== 'table'}<label class="select-field"><span>{zh ? '分组' : 'Group'}</span><select aria-label={zh ? '分组字段' : 'Group by'} bind:value={groupBy}><option value="">{zh ? '分类标题' : 'Category headings'}</option>{#each doc.columns as column}<option value={column}>{column}</option>{/each}</select></label>{/if}
        {#if view === 'board'}<label class="select-field"><span>{zh ? '泳道' : 'Lane'}</span><select aria-label={zh ? '泳道字段' : 'Lane by'} bind:value={laneBy}><option value="">{zh ? '无' : 'None'}</option>{#each doc.columns as column}<option value={column}>{column}</option>{/each}</select></label>{/if}
      </div>
    </header>
    {#if error}<div class="error" role="alert">{error}</div>{/if}
    <div class="content" data-view={view}>
      {#if !filtered.length && (query.trim() || !usesCategories || !doc.sections.length)}<div class="empty"><h2>{query ? (zh ? '没有匹配的文件' : 'No matching files') : (zh ? '索引还没有文件' : 'No files in this index')}</h2><p>{query ? (zh ? '试试其他关键词。' : 'Try another search term.') : (zh ? '在 Markdown 列表中添加文件链接后，即可在此查看。' : 'Add file links to the Markdown list to see them here.')}</p></div>
      {:else if usesCategories}
        <div class="category-tree" class:grouped-list={view === 'list'}>
          {@render rowsContent(rootRows)}
          {#each sectionTree as node (node.section.id)}{@render sectionContent(node)}{/each}
        </div>
      {:else if view === 'list'}
        <div class="grouped-list">{#each groups as group (group.key)}<section class="list-group"><h2>{group.label}<span>{filtered.filter((row) => groupKey(row) === group.key).length}</span></h2>{@render rowsContent(filtered.filter((row) => groupKey(row) === group.key))}</section>{/each}</div>
      {:else if view === 'board' && boardTooLarge}
        <div class="empty" role="status"><h2>{zh ? '分组过多' : 'Too many groups'}</h2><p>{zh ? '请筛选文件或改用其他字段，以减少看板的分组与泳道。' : 'Filter files or choose other fields to reduce board columns and lanes.'}</p></div>
      {:else if view === 'board'}
        <div class="board-scroll"><div class="board" style:grid-template-columns={`${laneBy ? 'minmax(110px, 150px) ' : ''}repeat(${groups.length}, minmax(245px, 1fr))`}>
          {#if laneBy}<div class="board-corner">{laneBy} / {groupBy || (zh ? '分类标题' : 'Category headings')}</div>{/if}
          {#each groups as group (group.key)}<h2 class="column-title">{group.label}<span>{filtered.filter((row) => groupKey(row) === group.key).length}</span></h2>{/each}
          {#each lanes as lane}
            {#if laneBy}<h3 class="lane-title">{lane}</h3>{/if}
            {#each groups as group (group.key)}
              {@const cellRows = filtered.filter((row) => groupKey(row) === group.key && (!laneBy || groupValue(row, laneBy) === lane))}
              <section class="board-cell" aria-label={lane ? `${lane} · ${group.label}` : group.label}>
              {#if laneBy}<span class="cell-count">{cellRows.length} {zh ? '个文件' : 'files'}</span>{/if}
              {#each cellRows as row (row.id)}{@render card(row)}{:else}<span class="vacant">—</span>{/each}
            </section>{/each}
          {/each}
        </div></div>
      {:else}
        {#each groups as group (group.key)}<section class="gallery-group"><h2>{group.label}<span>{filtered.filter((row) => groupKey(row) === group.key).length}</span></h2>{@render rowsContent(filtered.filter((row) => groupKey(row) === group.key))}</section>{/each}
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
  h2 span, .section-title span { font-size: 11px; color: var(--ui-tertiary); font-weight: 400; }
  .list-group, .gallery-group, .category-section { margin-bottom: 28px; }
  .section-title { margin: 0 0 12px; font-size: 14px; font-weight: 650; display: flex; align-items: center; gap: 9px; overflow-wrap: anywhere; }
  .section-description { color: var(--ui-secondary); line-height: 1.65; font-size: 12px; margin: -4px 0 12px; }
  .section-description p { margin: 4px 0; }
  .section-children { margin: 18px 0 0 8px; padding-left: 14px; border-left: 1px solid var(--ui-separator); }
  .section-children > .category-section:last-child { margin-bottom: 0; }
  .list-rows { margin-bottom: 20px; }
  .list-rows:empty, .gallery:empty { display: none; }
  .list-rows .card { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px 14px; border: 0; border-bottom: 1px solid var(--ui-separator); border-radius: 0; padding: 15px 0; }
  .card { background: var(--ui-surface); border: 1px solid var(--ui-separator); border-radius: 9px; padding: 14px; min-width: 0; }
  .file-name { padding: 0; margin: 0; border: 0; background: none; color: var(--ui-accent-text); font-weight: 600; text-align: left; line-height: 1.55; cursor: pointer; overflow-wrap: anywhere; }
  .file-name:hover { text-decoration: underline; text-underline-offset: 3px; }
  .fields { display: flex; flex-direction: column; gap: 7px; margin: 10px 0 0; font-size: 11px; }
  .fields div { display: grid; grid-template-columns: minmax(45px, 28%) minmax(0, 1fr); gap: 10px; }
  dt { color: var(--ui-tertiary); overflow-wrap: anywhere; }
  dd { margin: 0; color: var(--ui-secondary); overflow-wrap: anywhere; white-space: pre-wrap; }
  .list-rows .fields { display: flex; flex-direction: row; flex-wrap: wrap; gap: 6px; margin: 0; min-width: 0; }
  .list-rows .fields div { display: flex; align-items: baseline; gap: 5px; padding: 3px 7px; border-radius: 5px; background: var(--ui-bg); min-width: 0; max-width: 100%; }
  .list-rows dt { flex-shrink: 0; }
  .list-rows dd { min-width: 0; }
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
