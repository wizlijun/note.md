<script lang="ts">
  import type { IndexCell } from '../model'
  let { cell, open }: { cell: IndexCell; open: (href: string) => void } = $props()
  const parts = $derived.by(() => {
    const result: { text: string; href?: string }[] = []
    let position = 0
    for (const link of cell.links) {
      if (link.start > position) result.push({ text: cell.text.slice(position, link.start) })
      result.push({ text: cell.text.slice(link.start, link.end), href: link.href })
      position = link.end
    }
    if (position < cell.text.length) result.push({ text: cell.text.slice(position) })
    return result
  })
</script>
{#each parts as part}
  {#if part.href}<button type="button" class="cell-link" onclick={() => open(part.href!)}>{part.text}</button>{:else}{part.text}{/if}
{/each}
<style>
  .cell-link { display: inline; color: var(--ui-accent-text); background: none; border: 0; padding: 0; text-align: inherit; cursor: pointer; text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 35%, transparent); text-underline-offset: 3px; }
</style>
