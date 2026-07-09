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
<div class="menu" style="left: {x}px; top: {y}px" role="menu">
  {#each items as action}
    <button class="item" class:danger={action === 'delete'} role="menuitem"
      onclick={(e) => { e.stopPropagation(); onAction(action, node); onClose() }}>
      {labels[action]}
    </button>
  {/each}
</div>

<style>
  .menu { position: fixed; z-index: 100; min-width: 170px; background: var(--panel-bg, #fff);
    border: 1px solid var(--border-color, #ccc); border-radius: 6px; box-shadow: 0 4px 16px #0003; padding: 4px; }
  .item { display: block; width: 100%; text-align: left; background: none; border: none;
    padding: 5px 8px; border-radius: 4px; font-size: 13px; cursor: pointer; color: inherit; }
  .item:hover { background: var(--hover-bg, #8882); }
  .item.danger:hover { background: #d44a4a; color: #fff; }
</style>
