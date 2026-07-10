<script lang="ts">
  import type { OutlineNode as NodeT } from '../../lib/outline/model'
  import { t } from '../../lib/i18n/store.svelte'
  let { node, x, y, onAction, onClose }: {
    node: NodeT; x: number; y: number
    onAction: (action: 'jump' | 'copy' | 'copy-subtree' | 'copy-ref' | 'delete', node: NodeT) => void
    onClose: () => void
  } = $props()
  const items = $derived(node.source === 'manual'
    ? (['copy', 'copy-subtree', 'copy-ref', 'delete'] as const)
    : (['jump', 'copy', 'copy-subtree'] as const))
  const labels: Record<string, string> = {
    jump: t('outline.jumpToSource'), copy: t('outline.copyText'),
    'copy-subtree': t('outline.copySubtree'), 'copy-ref': t('outline.copyBlockRef'),
    delete: t('outline.delete'),
  }
</script>

<svelte:window onclick={onClose} oncontextmenu={onClose} />
<div class="menu menu-panel" style="left: {x}px; top: {y}px" role="menu">
  {#each items as action}
    <button class="item menu-row" class:danger={action === 'delete'} role="menuitem"
      onclick={(e) => { e.stopPropagation(); onAction(action, node); onClose() }}>
      {labels[action]}
    </button>
  {/each}
</div>

<style>
  /* Chrome comes from the shared .menu-panel / .menu-row classes in app.css. */
  .menu { position: fixed; z-index: 100; min-width: 170px; }
  .item { display: block; width: 100%; text-align: left; background: none; border: none;
    font: inherit; color: inherit; }
  .item.danger:hover { background: #d44a4a; color: #fff; }
</style>
