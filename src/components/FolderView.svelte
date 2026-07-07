<script lang="ts">
  import {
    folderView, setRootDir, setWidth, refreshAll, syncToActiveFile,
    setVisible, parentDir, watchRoot, setFilter, clearFilter, revealInFinder,
    type FolderEntry,
  } from '../lib/folder-view.svelte'
  import { tick } from 'svelte'
  import { openFile } from '../lib/tabs.svelte'
  import { showError } from '../lib/dialogs'
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
    <button class="hbtn" onclick={goUp} disabled={!canGoUp} title="Parent folder" aria-label="Parent folder">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
      </svg>
    </button>
    <span class="root-name" title={folderView.rootDir ?? ''}>{rootName || 'No folder'}</span>
    <button class="hbtn" class:on={searching || !!folderView.filter} onclick={toggleSearch} title="Find" aria-label="Find">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    </button>
    <button class="hbtn" onclick={() => refreshAll()} title="Refresh" aria-label="Refresh">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    </button>
    <button class="hbtn" onclick={() => setVisible(false)} title="Hide Folder View" aria-label="Hide Folder View">
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
        placeholder="Filter (regex)…"
        value={folderView.filter}
        oninput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
        onkeydown={onSearchKeydown}
      />
      <button class="clear" onclick={cancelSearch} title="Clear filter" aria-label="Clear filter">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  {/if}
  <div class="tree">
    {#if rootEntries.length === 0}
      <div class="empty">{folderView.filter ? 'No matches' : 'Empty folder'}</div>
    {:else}
      {#each rootEntries as entry (entry.path)}
        <FolderTreeNode {entry} depth={0} {activePath} onOpen={open} onContextMenu={onNodeContextMenu} />
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
  <div class="node-ctx-menu" role="menu" style="left: {ctx.x}px; top: {ctx.y}px">
    <button type="button" role="menuitem" class="node-ctx-item" onclick={revealCtx}>
      Reveal in Finder
    </button>
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
  .node-ctx-menu {
    position: fixed; z-index: 9998;
    min-width: 160px; padding: 4px;
    background: Canvas; color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.18);
    font-size: 13px; user-select: none;
  }
  .node-ctx-item {
    display: block; width: 100%; text-align: left;
    padding: 6px 10px; background: transparent; color: inherit;
    border: 0; border-radius: 4px; cursor: pointer;
  }
  .node-ctx-item:hover { background: color-mix(in srgb, AccentColor 18%, Canvas); }
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
