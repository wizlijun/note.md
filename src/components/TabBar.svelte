<script lang="ts">
  import { tabs, activeId, activeTab, isDirty, activate, closeTab } from '../lib/tabs.svelte'
  import { confirmDirtyClose } from '../lib/dialogs'
  import ModeToggle from './ModeToggle.svelte'

  async function onClose(e: MouseEvent, id: string) {
    e.stopPropagation()
    await closeTab(id, confirmDirtyClose)
  }

  let active = $derived(activeTab())
</script>

{#if tabs.length > 1 && active}
  <div class="bar">
    <div class="tabs">
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
    <div class="spacer"></div>
    <div class="right">
      <ModeToggle tab={active} />
    </div>
  </div>
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    height: 36px;
    padding: 0 8px 0 0;
    box-sizing: border-box;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    background: color-mix(in srgb, Canvas 92%, CanvasText 8%);
  }
  .tabs {
    display: flex;
    height: 100%;
    overflow-x: auto;
    flex: 0 1 auto;
    min-width: 0;
  }
  .spacer { flex: 1 1 auto; }
  .right { flex-shrink: 0; padding-right: 4px; }
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
