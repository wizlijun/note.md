<script lang="ts">
  let { pages, selected, x, y, onPick }: {
    pages: string[]; selected: number; x: number; y: number; onPick: (page: string) => void
  } = $props()
</script>

<div class="menu" style="left: {x}px; top: {y}px" role="listbox">
  {#each pages as page, i}
    <button class="item" class:sel={i === selected} role="option" aria-selected={i === selected}
      onmousedown={(e) => { e.preventDefault(); onPick(page) }}>{page}</button>
  {/each}
  {#if pages.length === 0}<div class="item none">—</div>{/if}
</div>

<style>
  /* 与 SlashMenu 相同的 .menu/.item 样式，复制即可 */
  .menu { position: fixed; z-index: 100; min-width: 180px; max-height: 240px; overflow-y: auto;
    background: var(--panel-bg, #fff); border: 1px solid var(--border-color, #ccc);
    border-radius: 6px; box-shadow: 0 4px 16px #0003; padding: 4px; }
  .item { display: block; width: 100%; text-align: left; background: none; border: none;
    padding: 5px 8px; border-radius: 4px; font-size: 13px; cursor: pointer; color: inherit; }
  .item.sel, .item:hover { background: var(--accent-color, #4a80d4); color: #fff; }
  .item.none { opacity: 0.5; cursor: default; }
</style>
