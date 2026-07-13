<script lang="ts">
  import type { RecallTreeNode } from '../../lib/outline/recall'
  import InlineRender from './InlineRender.svelte'
  import RefTreeNode from './RefTreeNode.svelte'

  // Read-only, collapsible renderer for one recalled subtree node (Phase A).
  let { node, defaultCollapsed = false }: { node: RecallTreeNode; defaultCollapsed?: boolean } = $props()

  let collapsed = $state(defaultCollapsed)
  const hasChildren = $derived(node.children.length > 0)
</script>

<div class="ref-node">
  <div class="ref-row">
    {#if hasChildren}
      <button class="twist" onclick={() => (collapsed = !collapsed)} aria-label="toggle">{collapsed ? '▸' : '▾'}</button>
    {:else}
      <span class="dot">•</span>
    {/if}
    <span class="text"><InlineRender content={node.text} /></span>
  </div>
  {#if hasChildren && !collapsed}
    <div class="children">
      {#each node.children as c, i (i)}
        <RefTreeNode node={c} />
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Inherit the main outline's typography so references read as one outline. */
  .ref-row {
    display: flex; align-items: baseline; gap: 4px; padding: 1px 0;
    font-family: var(--outline-font-family);
    font-size: var(--outline-font-size, 13px);
    line-height: var(--outline-line-height, 1.5);
  }
  .twist {
    background: none; border: none; cursor: pointer; color: inherit;
    font-size: 0.7em; opacity: 0.55; width: 1.1em; flex: none; padding: 0; line-height: inherit;
  }
  .twist:hover { opacity: 1; }
  .dot { opacity: 0.35; width: 1.1em; flex: none; text-align: center; font-size: 0.7em; }
  .text { flex: 1; min-width: 0; }
  .children { padding-left: 1.1em; }
</style>
