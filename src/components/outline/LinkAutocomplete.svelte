<script lang="ts">
  let { pages, selected, x, y, onPick }: {
    pages: string[]; selected: number; x: number; y: number; onPick: (page: string) => void
  } = $props()
</script>

<div class="menu menu-panel" style="left: {x}px; top: {y}px" role="listbox">
  {#each pages as page, i}
    <button class="item menu-row" class:active={i === selected} role="option" aria-selected={i === selected}
      onmousedown={(e) => { e.preventDefault(); onPick(page) }}>{page}</button>
  {/each}
  {#if pages.length === 0}<div class="item menu-row none">—</div>{/if}
</div>

<style>
  /* Chrome comes from the shared .menu-panel / .menu-row classes in app.css. */
  .menu { position: fixed; z-index: 100; min-width: 180px; max-height: 240px; overflow-y: auto; }
  .item { width: 100%; text-align: left; background: none; border: none;
    font: inherit; color: inherit; }
  .item.none { opacity: 0.5; }
</style>
