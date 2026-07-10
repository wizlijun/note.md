<script lang="ts">
  import ReadonlyNode from './ReadonlyNode.svelte'
  import InlineRender from './InlineRender.svelte'
  import { childrenOf, type OutlineTree, type OutlineNode as NodeT } from '../../lib/outline/model'
  import { SvelteSet } from 'svelte/reactivity'

  let { node, depth, tree, collapsed, onNodeClick, onPageClick }: {
    node: NodeT
    depth: number
    tree: OutlineTree
    /** 面板本地折叠状态(不持久化) */
    collapsed: SvelteSet<string>
    onNodeClick: (n: NodeT) => void
    onPageClick: (target: string) => void
  } = $props()

  let kids = $derived(childrenOf(tree, node.id))
  let isCollapsed = $derived(collapsed.has(node.id))
</script>

<div class="node" style="--depth: {depth}">
  <div class="row" class:auto={node.source !== 'manual'}>
    {#if kids.length > 0}
      <button class="tri" class:closed={isCollapsed}
        onclick={() => { if (isCollapsed) collapsed.delete(node.id); else collapsed.add(node.id) }}>▾</button>
    {:else}<span class="tri-spacer"></span>{/if}
    <span class="bullet"
      class:src-toc={node.source === 'toc'}
      class:src-hl={node.source === 'highlight'}
      class:src-wl={node.source === 'wikilink'}>•</span>
    <span class="content" onclick={() => onNodeClick(node)} role="button" tabindex="0"
      onkeydown={(e) => { if (e.key === 'Enter') onNodeClick(node) }}>
      {#if node.content === ''}{'​'}{:else}<InlineRender content={node.content} {onPageClick} />{/if}
    </span>
  </div>
  {#if !isCollapsed}
    {#each kids as child (child.id)}
      <ReadonlyNode node={child} depth={depth + 1} {tree} {collapsed} {onNodeClick} {onPageClick} />
    {/each}
  {/if}
</div>

<style>
  .row {
    display: flex; align-items: flex-start; gap: 4px;
    padding: 1px 4px 1px calc(var(--depth) * 16px + 4px);
    border-radius: 4px;
    font-family: var(--outline-font-family);
    font-size: var(--outline-font-size, 13px);
    line-height: var(--outline-line-height, 1.5);
  }
  .row.auto .content { opacity: 0.92; }
  .tri { background: none; border: none; padding: 0; width: 1.1em; font-size: 0.7em;
    line-height: var(--outline-line-height, 1.5); cursor: pointer; opacity: 0.6; transition: transform 0.1s; }
  .tri.closed { transform: rotate(-90deg); }
  .tri-spacer { width: 1.1em; flex-shrink: 0; }
  .bullet { font-size: 1em; line-height: var(--outline-line-height, 1.5); opacity: 0.7; }
  .bullet.src-toc { color: var(--accent-color, #4a80d4); }
  .bullet.src-hl { color: #d4a94a; }
  .bullet.src-wl { color: #3aa99f; }
  .content { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; cursor: pointer;
    min-height: calc(1em * var(--outline-line-height, 1.5)); }
  .content:hover { text-decoration: underline dotted; text-underline-offset: 3px; }
</style>
