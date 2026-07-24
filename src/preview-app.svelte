<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import DiffView from './components/history/DiffView.svelte'
  import { loadLocale, watchLocaleChanges, t } from './lib/i18n/store.svelte'
  import { upsertTab, type PreviewTab } from './lib/git-history/preview-tabs'

  let tabs = $state<PreviewTab[]>([])
  let activeId = $state<string | null>(null)

  let active = $derived(tabs.find((x) => x.id === activeId) ?? null)

  async function drainTabs() {
    try {
      const drained = await invoke<PreviewTab[]>('drain_preview_tabs')
      for (const t of drained) {
        const r = upsertTab(tabs, t)
        tabs = r.tabs
        activeId = r.activeId
      }
      const a = tabs.find((x) => x.id === activeId)
      if (a) void getCurrentWindow().setTitle(a.title).catch(() => {})
    } catch (e) {
      console.warn('[preview] drain:', e)
    }
  }

  function selectTab(id: string) {
    activeId = id
    const ttl = tabs.find((x) => x.id === id)?.title
    if (ttl) void getCurrentWindow().setTitle(ttl).catch(() => {})
  }

  function closeTab(id: string) {
    const idx = tabs.findIndex((x) => x.id === id)
    if (idx < 0) return
    tabs = tabs.filter((x) => x.id !== id)
    if (tabs.length === 0) {
      void getCurrentWindow().close()
      return
    }
    if (activeId === id) selectTab(tabs[Math.min(idx, tabs.length - 1)].id)
  }

  $effect(() => {
    void loadLocale()
    void drainTabs()
    const un = getCurrentWindow().listen('preview-add-tab', () => { void drainTabs() })
    // Re-drain once the listener is ready: the backend may emit before it
    // resolves. drain is idempotent (payloads cleared on take; upsert dedupes).
    void un.then(() => drainTabs())
    // Follow live language switches from the main window's Settings.
    const unLocale = watchLocaleChanges()
    return () => { void un.then((f) => f()); void unLocale.then((f) => f()) }
  })
</script>

<main class="preview-root">
  {#if tabs.length > 0}
    <div class="tabbar" role="tablist">
      {#each tabs as tt (tt.id)}
        <div class="tab" class:active={tt.id === activeId}>
          <button class="tab-label" title={tt.title} onclick={() => selectTab(tt.id)}>{tt.title}</button>
          <button class="tab-close" aria-label={t('previewWindow.closeTab')} onclick={() => closeTab(tt.id)}>×</button>
        </div>
      {/each}
    </div>
    <div class="body">
      {#if active?.kind === 'diff'}
        <DiffView content={active.content} />
      {:else if active?.kind === 'rich'}
        <!-- srcdoc is self-generated, self-contained themed HTML (no scripts); allow-same-origin without allow-scripts cannot escalate. -->
        <iframe class="rich-frame" title={active.title} srcdoc={active.content} sandbox="allow-same-origin"></iframe>
      {/if}
    </div>
  {:else}
    <div class="empty">{t('previewWindow.empty')}</div>
  {/if}
</main>

<style>
  /* Independent window: declare its own color-scheme so system canvas colors
     (used by DiffView) track light/dark, instead of being stuck light. */
  :global(:root) { color-scheme: light dark; }
  :global(html), :global(body) { margin: 0; height: 100%; }
  .preview-root {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: Canvas;
    color: CanvasText;
    /* Same UI font stack as the main window (app.css) — without it the window
       chrome falls back to the WebKit default serif. */
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
    overflow: hidden;
  }
  .tabbar {
    display: flex;
    gap: 2px;
    padding: 4px 6px 0;
    overflow-x: auto;
    border-bottom: 1px solid var(--border-color, #3333);
    flex-shrink: 0;
  }
  .tab {
    display: flex; align-items: center;
    max-width: 220px;
    border: 1px solid var(--border-color, #3333);
    border-bottom: 0;
    border-radius: 6px 6px 0 0;
    background: color-mix(in srgb, CanvasText 5%, Canvas);
  }
  .tab.active { background: Canvas; }
  .tab-label {
    border: 0; background: transparent; color: inherit; cursor: pointer;
    font-size: 12px; padding: 5px 8px;
    max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tab-close {
    border: 0; background: transparent; color: inherit; cursor: pointer;
    font-size: 13px; line-height: 1; padding: 4px 6px 4px 0; opacity: 0.6;
  }
  .tab-close:hover { opacity: 1; }
  .body { flex: 1; display: flex; min-height: 0; overflow: hidden; }
  .rich-frame { flex: 1; width: 100%; border: 0; background: Canvas; }
  .empty { padding: 24px; opacity: 0.6; font-size: 13px; }
</style>
