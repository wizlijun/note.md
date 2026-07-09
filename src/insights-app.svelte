<!-- src/insights-app.svelte — standalone Reading Insights window (opened from
     the View ▸ Reading Insights menu). Bootstraps its own webview state. -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { loadSettings } from './lib/settings.svelte'
  import { loadLocale, t } from './lib/i18n/store.svelte'
  import { initActivePluginIds } from './lib/plugins/registry'
  import { refreshSotvault, sotvaultStore } from './lib/sotvault.svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import InsightsPanel from './components/InsightsPanel.svelte'

  let ready = $state(false)

  onMount(async () => {
    try {
      await loadSettings()
      await loadLocale()
      try { await getCurrentWindow().setTitle(t('insights.windowTitle')) } catch { /* no-op */ }
      await initActivePluginIds()
      await refreshSotvault()
    } catch (e) {
      console.error('[insights] init failed:', e)
    }
    ready = true
  })
</script>

<main>
  {#if !ready}
    <p class="msg">…</p>
  {:else if sotvaultStore.vaultRoot === null}
    <p class="msg">{t('plugins.needsVault')}</p>
  {:else}
    <InsightsPanel />
  {/if}
</main>

<style>
  /* Opt into both schemes so the Canvas/CanvasText system colors the panel is
     built on follow the OS appearance — WKWebView keeps them light-only without
     this. Mirrors the main window's src/styles/app.css. */
  :global(:root) { color-scheme: light dark; }
  :global(body) { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: Canvas; color: CanvasText; }
  main { height: 100vh; overflow: auto; padding: 12px 16px; box-sizing: border-box; }
  .msg { color: color-mix(in srgb, CanvasText 55%, transparent); font-size: 13px; padding: 20px; }
</style>
