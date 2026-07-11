<script lang="ts">
  import type { SlashItem } from './slash-items'
  import { t } from '../i18n/store.svelte'

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
    class="slash-menu menu-panel"
    style="top: {adjustedTop}px; left: {adjustedLeft}px"
    onclick={(e) => e.stopPropagation()}
  >
    {#if items.length === 0}
      <div class="slash-empty">{t('slashMenu.noMatches')}</div>
    {:else}
      {#each items as item, i (item.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="slash-item menu-row"
          class:active={i === selectedIndex}
          onclick={() => onSelect(item)}
        >
          {#if item.icon.startsWith('<svg')}
            <span class="slash-icon svg">{@html item.icon}</span>
          {:else}
            <span class="slash-icon">{item.icon}</span>
          {/if}
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
  /* Chrome (background/blur/highlight) comes from the shared .menu-panel /
     .menu-row classes in app.css — only layout lives here. */
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
    z-index: 71;
  }

  .slash-item { gap: 8px; }

  .slash-icon {
    flex-shrink: 0;
    width: 20px;
    text-align: center;
    font-size: 12px;
    opacity: 0.75;
  }
  .slash-icon.svg { display: inline-flex; justify-content: center; opacity: 1; }

  .slash-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .slash-label {
    font-size: 13px;
    line-height: 1.35;
  }

  .slash-desc {
    font-size: 11px;
    opacity: 0.55;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .slash-empty {
    padding: 8px 12px;
    font-size: 13px;
    opacity: 0.5;
    text-align: center;
  }
</style>
