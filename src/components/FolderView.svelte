<script lang="ts">
  import {
    folderView, setRootDir, setWidth, refreshAll, syncToActiveFile,
    parentDir, watchRoot, type FolderEntry,
  } from '../lib/folder-view.svelte'
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

  let rootEntries = $derived<FolderEntry[]>(
    folderView.rootDir ? (folderView.entriesCache.get(folderView.rootDir) ?? []) : []
  )
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

<aside bind:this={asideEl} class="folder-view" style="width: {folderView.width}px">
  <div class="header">
    <button class="hbtn" onclick={goUp} disabled={!canGoUp} title="Parent folder" aria-label="Parent folder">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
      </svg>
    </button>
    <span class="root-name" title={folderView.rootDir ?? ''}>{rootName || 'No folder'}</span>
    <button class="hbtn" onclick={() => refreshAll()} title="Refresh" aria-label="Refresh">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    </button>
  </div>
  <div class="tree">
    {#if rootEntries.length === 0}
      <div class="empty">Empty folder</div>
    {:else}
      {#each rootEntries as entry (entry.path)}
        <FolderTreeNode {entry} depth={0} {activePath} onOpen={open} />
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

<style>
  .folder-view {
    position: relative;
    flex: 0 0 auto;
    height: 100%;
    display: flex; flex-direction: column;
    background: var(--drawer-bg, #f6f6f6);
    border-right: 1px solid rgba(0,0,0,0.08);
    overflow: hidden;
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
  .tree { flex: 1; overflow: auto; padding: 4px 0; }
  .empty { padding: 12px 10px; opacity: 0.5; font-size: 13px; }
  .splitter {
    position: absolute; top: 0; right: 0; width: 5px; height: 100%;
    cursor: col-resize; touch-action: none;
  }
  .splitter:hover { background: rgba(0,0,0,0.08); }
  @media (prefers-color-scheme: dark) {
    .folder-view { background: var(--drawer-bg, #1c1c1e); border-right-color: rgba(255,255,255,0.08); }
    .header { border-bottom-color: rgba(255,255,255,0.06); }
    .hbtn:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
    .splitter:hover { background: rgba(255,255,255,0.1); }
  }
</style>
