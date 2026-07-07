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
    <span class="twisty" class:open={expanded}>▸</span>
    <span class="icon">📁</span>
  {:else}
    <span class="twisty spacer"></span>
    <span class="icon">📄</span>
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
  .twisty { display: inline-block; width: 12px; font-size: 10px; opacity: 0.6; transition: transform 0.1s; }
  .twisty.open { transform: rotate(90deg); }
  .twisty.spacer { visibility: hidden; }
  .icon { flex: 0 0 auto; font-size: 12px; }
  .label { overflow: hidden; text-overflow: ellipsis; }
  @media (prefers-color-scheme: dark) {
    .node:hover { background: rgba(255,255,255,0.07); }
    .node.active { background: rgba(255,255,255,0.13); }
  }
</style>
