<script lang="ts">
  import {
    folderView, setRootDir, setWidth, refreshAll, syncToActiveFile,
    setVisible, parentDir, watchRoot, setFilter, clearFilter, revealInFinder,
    type FolderEntry,
  } from '../lib/folder-view.svelte'
  import { t } from '../lib/i18n/store.svelte'
  import { tick } from 'svelte'
  import { openFile, updateTabPath } from '../lib/tabs.svelte'
  import { showError } from '../lib/dialogs'
  import { planRename, executeRename } from '../lib/outline/rename-pair'
  import { pushToast } from '../lib/toast.svelte'
  import FolderTreeNode from './FolderTreeNode.svelte'

  let { activePath }: { activePath: string | null } = $props()

  // Keep the tree root in step with the active markdown file.
  $effect(() => { void syncToActiveFile(activePath) })

  // While the folder view is open, watch the tree root so file changes (new
  // files from wikilink-open / Save As, deletes, renames) refresh the list.
  // Re-subscribes when the root changes; cleans up on close (component unmount).
  $effect(() => {
    const dir = folderView.rootDir
    if (!dir) return
    return watchRoot(dir)
  })

  let filtering = $derived(!!folderView.filter.trim())
  let rootEntries = $derived.by<FolderEntry[]>(() => {
    const all = folderView.rootDir ? (folderView.entriesCache.get(folderView.rootDir) ?? []) : []
    return filtering ? all.filter((e) => folderView.filterVisible.has(e.path)) : all
  })
  let rootName = $derived(
    folderView.rootDir ? (folderView.rootDir.split('/').filter(Boolean).pop() ?? '/') : ''
  )
  let canGoUp = $derived(!!folderView.rootDir && folderView.rootDir !== '/')

  async function open(path: string) {
    try { await openFile(path) } catch (e) { showError(String(e)) }
  }
  function goUp() {
    if (folderView.rootDir) setRootDir(parentDir(folderView.rootDir))
  }

  // Name-filter search box: toggled by the find button, cleared by its ✕.
  // Reopen it automatically if a filter is still active from a prior mount.
  let searching = $state(!!folderView.filter)
  let searchInput = $state<HTMLInputElement>()
  async function toggleSearch() {
    searching = !searching
    if (searching) { await tick(); searchInput?.focus() }
    else clearFilter()
  }
  function cancelSearch() {
    clearFilter()
    searching = false
  }
  function onSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { cancelSearch() }
  }

  // Right-click context menu for a tree node.
  type CtxState = { open: boolean; x: number; y: number; entry: FolderEntry | null }
  let ctx = $state<CtxState>({ open: false, x: 0, y: 0, entry: null })

  function onNodeContextMenu(e: MouseEvent, entry: FolderEntry) {
    e.preventDefault()
    ctx = { open: true, x: e.clientX, y: e.clientY, entry }
  }
  function closeCtxMenu() {
    ctx = { open: false, x: 0, y: 0, entry: null }
  }
  async function revealCtx() {
    const path = ctx.entry?.path
    closeCtxMenu()
    if (!path) return
    try { await revealInFinder(path) } catch (e) { showError(String(e)) }
  }

  // Inline rename: the ctx-menu "Rename" arms `renamingPath`; FolderTreeNode
  // renders an inline <input> for the matching row and calls back to commit/cancel.
  let renamingPath = $state<string | null>(null)

  function renameCtx() {
    const p = ctx.entry?.path
    closeCtxMenu()
    if (p) renamingPath = p
  }

  async function commitRename(entry: FolderEntry, newName: string) {
    renamingPath = null
    const dir = parentDir(entry.path)
    const cached = folderView.entriesCache.get(dir) ?? []
    const siblings = cached.filter((e) => !e.isDir).map((e) => e.name)
    // A paired companion (.note.md) is hidden from entriesCache but still lives on
    // disk — feed its filename into siblings so conflict/pairing sees it too.
    for (const e of cached) {
      if (e.notePath) siblings.push(e.notePath.slice(e.notePath.lastIndexOf('/') + 1))
    }
    const plan = planRename(entry.path, newName, siblings)
    if (!plan) {
      // Same-name = silent no-op; only a real conflict warrants a toast.
      if (newName !== entry.name) pushToast({ level: 'warn', message: t('folderView.renameConflict') })
      return
    }
    const err = await executeRename(plan)
    if (err) { pushToast({ level: 'error', message: err }); return }
    for (const op of plan.ops) await updateTabPath(op.from, op.to)
    await refreshAll()
  }
  function onWindowMouseDown(e: MouseEvent) {
    if (!ctx.open) return
    const target = e.target as HTMLElement | null
    if (target?.closest('.node-ctx-menu')) return
    closeCtxMenu()
  }
  function onWindowKeyDown(e: KeyboardEvent) {
    if (ctx.open && e.key === 'Escape') { e.preventDefault(); closeCtxMenu() }
  }

  // Drag-to-resize the sidebar width.
  let asideEl: HTMLElement
  let dragging = false
  function startDrag(e: PointerEvent) {
    dragging = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onDrag(e: PointerEvent) {
    if (dragging && asideEl) setWidth(e.clientX - asideEl.getBoundingClientRect().left)
  }
  function endDrag(e: PointerEvent) {
    dragging = false
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }
</script>

<svelte:window onmousedown={onWindowMouseDown} onkeydown={onWindowKeyDown} />

<aside bind:this={asideEl} class="folder-view" style="width: {folderView.width}px">
  <div class="header">
    <button class="hbtn" onclick={goUp} disabled={!canGoUp} title={t('folderView.parentFolder')} aria-label={t('folderView.parentFolder')}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
      </svg>
    </button>
    <span class="root-name" title={folderView.rootDir ?? ''}>{rootName || t('folderView.noFolder')}</span>
    <button class="hbtn" class:on={searching || !!folderView.filter} onclick={toggleSearch} title={t('folderView.find')} aria-label={t('folderView.find')}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    </button>
    <button class="hbtn" onclick={() => refreshAll()} title={t('folderView.refresh')} aria-label={t('folderView.refresh')}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    </button>
    <button class="hbtn" onclick={() => setVisible(false)} title={t('folderView.hide')} aria-label={t('folderView.hide')}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="9" y1="3" x2="9" y2="21" />
        <polyline points="16 15 13 12 16 9" />
      </svg>
    </button>
  </div>
  {#if searching}
    <div class="search">
      <input
        bind:this={searchInput}
        class="search-input"
        type="text"
        placeholder={t('folderView.filterPlaceholder')}
        value={folderView.filter}
        oninput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
        onkeydown={onSearchKeydown}
      />
      <button class="clear" onclick={cancelSearch} title={t('folderView.clearFilter')} aria-label={t('folderView.clearFilter')}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  {/if}
  <div class="tree">
    {#if rootEntries.length === 0}
      <div class="empty">{folderView.filter ? t('folderView.noMatches') : t('folderView.emptyFolder')}</div>
    {:else}
      {#each rootEntries as entry (entry.path)}
        <FolderTreeNode
          {entry}
          depth={0}
          {activePath}
          onOpen={open}
          onContextMenu={onNodeContextMenu}
          {renamingPath}
          onRenameCommit={commitRename}
          onRenameCancel={() => (renamingPath = null)}
        />
      {/each}
    {/if}
  </div>
  <div
    class="splitter"
    role="separator"
    aria-orientation="vertical"
    onpointerdown={startDrag}
    onpointermove={onDrag}
    onpointerup={endDrag}
  ></div>
</aside>

{#if ctx.open}
  <div class="node-ctx-menu menu-panel" role="menu" style="left: {ctx.x}px; top: {ctx.y}px">
    <button type="button" role="menuitem" class="node-ctx-item menu-row" onclick={revealCtx}>
      {t('folderView.reveal')}
    </button>
    {#if ctx.entry && !ctx.entry.isDir}
      <button type="button" role="menuitem" class="node-ctx-item menu-row" onclick={renameCtx}>
        {t('folderView.rename')}
      </button>
    {/if}
  </div>
{/if}

<style>
  .folder-view {
    position: relative;
    flex: 0 0 auto;
    height: 100%;
    display: flex; flex-direction: column;
    background: var(--drawer-bg, #f6f6f6);
    border-right: 1px solid rgba(0,0,0,0.08);
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
  }
  .header {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 8px; border-bottom: 1px solid rgba(0,0,0,0.06);
    font-size: 12px;
  }
  .root-name {
    flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 600; text-transform: none; opacity: 0.8;
  }
  .hbtn {
    display: inline-flex; align-items: center; justify-content: center;
    border: 0; background: transparent; cursor: pointer;
    padding: 3px; border-radius: 4px; opacity: 0.7;
  }
  .hbtn svg { display: block; }
  .hbtn:hover:not(:disabled) { background: rgba(0,0,0,0.08); opacity: 1; }
  .hbtn:disabled { opacity: 0.25; cursor: default; }
  .hbtn.on { background: rgba(0,0,0,0.1); opacity: 1; }
  .search {
    display: flex; align-items: center; gap: 4px;
    padding: 5px 8px; border-bottom: 1px solid rgba(0,0,0,0.06);
  }
  .search-input {
    flex: 1; min-width: 0;
    border: 1px solid rgba(0,0,0,0.15); border-radius: 5px;
    padding: 3px 6px; font: inherit; font-size: 12px;
    background: var(--input-bg, #fff); color: inherit;
  }
  .search-input:focus { outline: none; border-color: rgba(0,120,255,0.6); }
  .clear {
    display: inline-flex; align-items: center; justify-content: center;
    flex: 0 0 auto; border: 0; background: transparent; cursor: pointer;
    padding: 2px; border-radius: 4px; opacity: 0.6;
  }
  .clear:hover { background: rgba(0,0,0,0.08); opacity: 1; }
  .tree { flex: 1; overflow: auto; padding: 4px 0; }
  .empty { padding: 12px 10px; opacity: 0.5; font-size: 13px; }
  .splitter {
    position: absolute; top: 0; right: 0; width: 5px; height: 100%;
    cursor: col-resize; touch-action: none;
  }
  .splitter:hover { background: rgba(0,0,0,0.08); }
  /* Chrome comes from the shared .menu-panel / .menu-row classes in app.css. */
  .node-ctx-menu { position: fixed; z-index: 9998; min-width: 160px; }
  .node-ctx-item {
    width: 100%; text-align: left; background: none; color: inherit;
    border: 0; font: inherit;
  }
  @media (prefers-color-scheme: dark) {
    .folder-view { background: var(--drawer-bg, #1c1c1e); border-right-color: rgba(255,255,255,0.08); }
    .header { border-bottom-color: rgba(255,255,255,0.06); }
    .hbtn:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
    .hbtn.on { background: rgba(255,255,255,0.15); }
    .search { border-bottom-color: rgba(255,255,255,0.06); }
    .search-input { border-color: rgba(255,255,255,0.18); background: var(--input-bg, #2a2a2c); }
    .clear:hover { background: rgba(255,255,255,0.12); }
    .splitter:hover { background: rgba(255,255,255,0.1); }
  }
</style>
