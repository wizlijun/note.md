<script lang="ts">
  import { folderView, toggleExpanded, type FolderEntry } from '../lib/folder-view.svelte'
  import FolderTreeNode from './FolderTreeNode.svelte'

  let {
    entry,
    depth,
    activePath,
    onOpen,
  }: {
    entry: FolderEntry
    depth: number
    activePath: string | null
    onOpen: (path: string) => void
  } = $props()

  let expanded = $derived(folderView.expanded.has(entry.path))
  let children = $derived(folderView.entriesCache.get(entry.path) ?? [])
  let isActive = $derived(!entry.isDir && entry.path === activePath)

  function onRowClick() {
    if (entry.isDir) toggleExpanded(entry.path)
    else onOpen(entry.path)
  }
</script>

<button
  class="node"
  class:active={isActive}
  style="padding-left: {8 + depth * 14}px"
  onclick={onRowClick}
  title={entry.name}
>
  {#if entry.isDir}
    <svg class="chev" class:open={expanded} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
    <svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  {:else}
    <span class="chev spacer"></span>
    <svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  {/if}
  <span class="label">{entry.name}</span>
</button>

{#if entry.isDir && expanded}
  {#each children as child (child.path)}
    <FolderTreeNode entry={child} depth={depth + 1} {activePath} {onOpen} />
  {/each}
{/if}

<style>
  .node {
    display: flex; align-items: center; gap: 4px;
    width: 100%; box-sizing: border-box;
    text-align: left; padding: 3px 8px; border: 0; background: transparent;
    font: inherit; font-size: 13px; line-height: 1.4; cursor: pointer;
    white-space: nowrap; overflow: hidden;
  }
  .node:hover { background: rgba(0,0,0,0.05); }
  .node.active { background: rgba(0,0,0,0.1); font-weight: 500; }
  .chev { flex: 0 0 auto; width: 14px; height: 14px; opacity: 0.55; transition: transform 0.12s ease; }
  .chev.open { transform: rotate(90deg); }
  .chev.spacer { display: inline-block; visibility: hidden; }
  .icon { flex: 0 0 auto; display: block; opacity: 0.75; }
  .label { overflow: hidden; text-overflow: ellipsis; }
  @media (prefers-color-scheme: dark) {
    .node:hover { background: rgba(255,255,255,0.07); }
    .node.active { background: rgba(255,255,255,0.13); }
  }
</style>
