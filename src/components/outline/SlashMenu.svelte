<script lang="ts">
  import type { SlashItem } from '../../lib/outline/completion'
  let { items, selected, x, y, onPick }: {
    items: SlashItem[]; selected: number; x: number; y: number; onPick: (item: SlashItem) => void
  } = $props()
</script>

<div class="menu menu-panel" style="left: {x}px; top: {y}px" role="listbox">
  {#each items as item, i}
    <button class="item menu-row" class:active={i === selected} role="option" aria-selected={i === selected}
      onmousedown={(e) => { e.preventDefault(); onPick(item) }}>
      <span class="icon">{item.icon}</span>{item.label}
    </button>
  {/each}
  {#if items.length === 0}<div class="item menu-row none">—</div>{/if}
</div>

<style>
  /* Chrome comes from the shared .menu-panel / .menu-row classes in app.css. */
  .menu { position: fixed; z-index: 100; min-width: 180px; max-height: 240px; overflow-y: auto; }
  .item { gap: 8px; width: 100%; text-align: left; background: none; border: none;
    font: inherit; color: inherit; }
  .item.none { opacity: 0.5; }
  .icon { width: 18px; opacity: 0.75; }
</style>
