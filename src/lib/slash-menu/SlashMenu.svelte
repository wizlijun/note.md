<script lang="ts">
  import type { SlashItem } from './slash-items'

  let {
    position,
    items,
    selectedIndex,
    onSelect,
    onClose,
  }: {
    position: { top: number; left: number }
    items: SlashItem[]
    selectedIndex: number
    onSelect: (item: SlashItem) => void
    onClose: () => void
  } = $props()

  let menuEl: HTMLDivElement | undefined = $state()
  let adjustedTop = $state(position.top)
  let adjustedLeft = $state(position.left)

  // Flip up if menu would overflow bottom of viewport
  $effect(() => {
    if (!menuEl) return
    const rect = menuEl.getBoundingClientRect()
    adjustedTop = (position.top + rect.height > window.innerHeight)
      ? Math.max(4, position.top - rect.height - 8)
      : position.top + 4
    adjustedLeft = (position.left + rect.width > window.innerWidth)
      ? Math.max(4, window.innerWidth - rect.width - 4)
      : position.left
  })

  // Scroll selected item into view
  $effect(() => {
    if (!menuEl) return
    const el = menuEl.querySelectorAll<HTMLElement>('.slash-item')[selectedIndex]
    el?.scrollIntoView({ block: 'nearest' })
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="slash-backdrop" onclick={onClose}>
  <div
    bind:this={menuEl}
    class="slash-menu"
    style="top: {adjustedTop}px; left: {adjustedLeft}px"
    onclick={(e) => e.stopPropagation()}
  >
    {#if items.length === 0}
      <div class="slash-empty">无匹配项</div>
    {:else}
      {#each items as item, i (item.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="slash-item"
          class:selected={i === selectedIndex}
          onclick={() => onSelect(item)}
        >
          <span class="slash-icon">{item.icon}</span>
          <div class="slash-text">
            <span class="slash-label">{item.label}</span>
            <span class="slash-desc">{item.desc}</span>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .slash-backdrop {
    position: fixed;
    inset: 0;
    z-index: 70;
  }

  .slash-menu {
    position: fixed;
    width: 248px;
    max-height: 340px;
    overflow-y: auto;
    padding: 4px;
    background: Canvas;
    border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas);
    border-radius: 8px;
    box-shadow: 0 4px 16px color-mix(in srgb, CanvasText 12%, transparent);
    z-index: 71;
  }

  .slash-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 7px;
    border-radius: 5px;
    cursor: pointer;
    user-select: none;
  }

  .slash-item:hover,
  .slash-item.selected {
    background: color-mix(in srgb, AccentColor 10%, Canvas);
  }

  .slash-icon {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, CanvasText 6%, Canvas);
    border: 1px solid color-mix(in srgb, CanvasText 10%, Canvas);
    border-radius: 5px;
    font-size: 11px;
    font-weight: 700;
    font-family: ui-monospace, Menlo, monospace;
    color: CanvasText;
  }

  .slash-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .slash-label {
    font-size: 13px;
    font-weight: 500;
    color: CanvasText;
    line-height: 1.3;
  }

  .slash-desc {
    font-size: 11px;
    color: color-mix(in srgb, CanvasText 55%, Canvas);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .slash-empty {
    padding: 8px 12px;
    font-size: 13px;
    color: color-mix(in srgb, CanvasText 45%, Canvas);
    text-align: center;
  }
</style>
