<script lang="ts">
  import { tabs, activeId, activeTab, isDirty, activate, closeTab } from '../lib/tabs.svelte'
  import { confirmDirtyClose } from '../lib/dialogs'
  import ModeToggle from './ModeToggle.svelte'
  import {
    collectMenuItems, evaluateEnabled, type CollectedItem,
  } from '../lib/plugins/menu-registry'
  import { pluginRuntime, dispatchPluginCommand } from '../lib/plugins/runtime.svelte'
  import { getPluginScopedAll, pluginScopedVersion } from '../lib/settings.svelte'
  import type { EnabledWhenContext } from '../lib/plugins/types'

  async function onClose(e: MouseEvent, id: string) {
    e.stopPropagation()
    await closeTab(id, confirmDirtyClose)
  }

  let active = $derived(activeTab())

  // Right-click context menu state.
  type CtxState = {
    open: boolean
    x: number
    y: number
    items: { item: CollectedItem; enabled: boolean }[]
  }
  let ctx = $state<CtxState>({ open: false, x: 0, y: 0, items: [] })

  let allTabContextItems = $derived(collectMenuItems(pluginRuntime.manifests).tabContext)

  function buildEwContext(tabId: string): EnabledWhenContext {
    const tab = tabs.find((t) => t.id === tabId)
    return {
      currentTab: tab
        ? {
            path: tab.filePath || null,
            filename: tab.title || null,
            extension: tab.filePath ? (tab.filePath.split('.').pop() ?? null) : null,
            kind: tab.kind === 'image' ? null : tab.kind,
            hasContent: (tab.currentContent ?? '').length > 0,
            isDirty: tab.currentContent !== tab.initialContent,
            isUntitled: !tab.filePath,
          }
        : null,
      // Settings reactivity: read pluginScopedVersion to make this dependent on
      // plugin settings changes (so a re-evaluation after settings.merge picks
      // up the latest values).
      settings: {} as Record<string, unknown>,
    }
  }

  function openTabContextMenu(e: MouseEvent, tabId: string) {
    if (allTabContextItems.length === 0) return
    e.preventDefault()
    // Pre-compute enabled state per item with each item's own plugin scoped
    // settings (mirrors App.svelte's top-level menu evaluation).
    void pluginScopedVersion.value
    const items = allTabContextItems.map((item) => {
      const ctxObj = buildEwContext(tabId)
      ctxObj.settings = getPluginScopedAll(item.pluginId)
      return { item, enabled: evaluateEnabled(item, ctxObj) }
    })
    // First, switch the active tab so dispatch builds the snapshot from the
    // right tab. (Plugin commands use activeTab() inside dispatch.)
    activate(tabId)
    ctx = { open: true, x: e.clientX, y: e.clientY, items }
  }

  function closeCtxMenu() {
    ctx = { open: false, x: 0, y: 0, items: [] }
  }

  async function onCtxItemClick(item: CollectedItem, enabled: boolean) {
    if (!enabled) return
    closeCtxMenu()
    try {
      await dispatchPluginCommand(item.pluginId, item.command)
    } catch (e) {
      console.warn('[TabBar] context menu dispatch failed:', e)
    }
  }

  function onWindowMouseDown(e: MouseEvent) {
    // Close on click outside the menu.
    if (!ctx.open) return
    const target = e.target as HTMLElement | null
    if (target?.closest('.tab-ctx-menu')) return
    closeCtxMenu()
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (ctx.open && e.key === 'Escape') {
      e.preventDefault()
      closeCtxMenu()
    }
  }
</script>

<svelte:window onmousedown={onWindowMouseDown} onkeydown={onWindowKeyDown} />

{#if tabs.length > 1 && active}
  <div class="bar">
    <div class="tabs">
      {#each tabs as tab (tab.id)}
        <button
          class="tab"
          class:active={tab.id === activeId.value}
          onclick={() => activate(tab.id)}
          oncontextmenu={(e) => openTabContextMenu(e, tab.id)}
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

{#if ctx.open}
  <div
    class="tab-ctx-menu"
    role="menu"
    style="left: {ctx.x}px; top: {ctx.y}px"
  >
    {#each ctx.items as { item, enabled } (item.id)}
      <button
        type="button"
        role="menuitem"
        class="tab-ctx-item"
        class:disabled={!enabled}
        disabled={!enabled}
        onclick={() => onCtxItemClick(item, enabled)}
      >
        {item.label}
      </button>
    {/each}
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

  .tab-ctx-menu {
    position: fixed;
    z-index: 9998;
    min-width: 180px;
    padding: 4px;
    background: Canvas;
    color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    border-radius: 6px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    font-size: 13px;
  }
  .tab-ctx-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 10px;
    background: transparent;
    color: inherit;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
  }
  .tab-ctx-item:hover:not(.disabled) {
    background: color-mix(in srgb, AccentColor 18%, Canvas);
  }
  .tab-ctx-item.disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
