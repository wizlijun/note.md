<script lang="ts">
  import { t } from '../lib/i18n/store.svelte'

  let {
    x, y, options, label, onPick, onClose,
  }: {
    x: number
    y: number
    options: string[]
    label: (prop: string) => string
    onPick: (prop: string) => void
    onClose: () => void
  } = $props()

  let el = $state<HTMLDivElement | null>(null)
  let pos = $state({ left: x, top: y })
  // Keep the panel fully on screen (right-aligns near the viewport's right edge).
  $effect(() => {
    const node = el
    if (!node) return
    const w = node.offsetWidth, h = node.offsetHeight
    pos = {
      left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    }
  })
</script>

<svelte:window onclick={onClose} oncontextmenu={onClose} />

<div bind:this={el} class="menu-panel base-menu" style="left:{pos.left}px; top:{pos.top}px" role="menu" tabindex="-1"
     onclick={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === 'Escape') onClose() }}>
  {#if options.length === 0}
    <div class="menu-row disabled">{t('base.noAddableProps')}</div>
  {:else}
    {#each options as prop}
      <button type="button" role="menuitem" class="menu-row mrow" onclick={() => { onPick(prop); onClose() }}>
        {label(prop)}
      </button>
    {/each}
  {/if}
</div>

<style>
  .base-menu { position: fixed; z-index: 9998; min-width: 180px; max-height: 340px; overflow: auto; display: flex; flex-direction: column; }
  .mrow { width: 100%; text-align: left; background: none; color: inherit; border: 0; font: inherit; cursor: default; }
</style>
