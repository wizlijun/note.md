<script lang="ts">
  import { t } from '../i18n/store.svelte'

  let {
    position,
    currentWidth,
    onResize,
    onClose,
  }: {
    position: { top: number; left: number }
    currentWidth: string
    onResize: (width: string) => void
    onClose: () => void
  } = $props()

  const sizeOptions = [
    { label: '25%',  value: '25%'  },
    { label: '50%',  value: '50%'  },
    { label: '75%',  value: '75%'  },
    { label: '100%', value: '100%' },
    { label: t('imageToolbar.original'), value: '' },
  ]
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="toolbar-backdrop" onclick={onClose}>
  <div
    class="image-toolbar"
    style="top: {position.top}px; left: {position.left}px"
    onclick={(e) => e.stopPropagation()}
  >
    {#each sizeOptions as opt}
      <button
        class="size-btn"
        class:active={currentWidth === opt.value}
        onclick={() => onResize(opt.value)}
        title={opt.value || t('imageToolbar.originalSize')}
      >
        {opt.label}
      </button>
    {/each}
  </div>
</div>

<style>
  .toolbar-backdrop {
    position: fixed;
    inset: 0;
    z-index: 55;
  }

  .image-toolbar {
    position: fixed;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    background: Canvas;
    border: 1px solid color-mix(in srgb, CanvasText 20%, Canvas);
    border-radius: 6px;
    box-shadow: 0 2px 8px color-mix(in srgb, CanvasText 15%, transparent);
    z-index: 56;
    transform: translateX(-50%);
  }

  .size-btn {
    padding: 3px 8px;
    border: none;
    background: transparent;
    color: color-mix(in srgb, CanvasText 65%, Canvas);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 4px;
    white-space: nowrap;
    transition: background 0.1s, color 0.1s;
  }

  .size-btn:hover {
    background: color-mix(in srgb, CanvasText 8%, Canvas);
    color: CanvasText;
  }

  .size-btn.active {
    background: AccentColor;
    color: white;
  }
</style>
