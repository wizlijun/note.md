<script lang="ts">
  import { tabs, activeId, isDirty, activate, closeTab } from '../lib/tabs.svelte'
  import { confirmDirtyClose } from '../lib/dialogs'

  async function onClose(e: MouseEvent, id: string) {
    e.stopPropagation()
    await closeTab(id, confirmDirtyClose)
  }
</script>

<div class="tabbar">
  {#each tabs as tab (tab.id)}
    <button
      class="tab"
      class:active={tab.id === activeId.value}
      onclick={() => activate(tab.id)}
      title={tab.filePath}
    >
      <span class="title">{tab.title}</span>
      {#if isDirty(tab.id)}<span class="dot" aria-label="modified"></span>{/if}
      <span class="close" role="button" onclick={(e) => onClose(e, tab.id)}>×</span>
    </button>
  {/each}
</div>

<style>
  .tabbar {
    display: flex;
    flex-shrink: 0;
    height: 36px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    overflow-x: auto;
    background: color-mix(in srgb, Canvas 92%, CanvasText 8%);
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 100%;
    padding: 0 10px 0 14px;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 13px;
    border-right: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
    white-space: nowrap;
  }
  .tab:hover {
    background: color-mix(in srgb, Canvas 80%, CanvasText 20%);
  }
  .tab.active {
    background: Canvas;
    font-weight: 500;
  }
  .title { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.6;
  }
  .close {
    width: 18px;
    height: 18px;
    line-height: 16px;
    text-align: center;
    border-radius: 3px;
    opacity: 0.5;
  }
  .close:hover { opacity: 1; background: color-mix(in srgb, CanvasText 15%, transparent); }
</style>
