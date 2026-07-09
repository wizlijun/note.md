<!-- src/insights-app.svelte — standalone Reading Insights window (opened from
     the View ▸ Reading Insights menu). Bootstraps its own webview state. -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { loadSettings, settings } from './lib/settings.svelte'
  import { loadLocale, t } from './lib/i18n/store.svelte'
  import { initActivePluginIds } from './lib/plugins/registry'
  import { refreshSotvault, sotvaultStore } from './lib/sotvault.svelte'
  import { loadThemes, findThemeById } from './lib/themes.svelte'
  import { computeActiveThemeId, observePrefersColorScheme } from './lib/theme-loader'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import InsightsPanel from './components/InsightsPanel.svelte'

  let ready = $state(false)

  /** Match the main app's resolved light/dark by flipping the document's
   *  color-scheme (which drives the Canvas/CanvasText system colors the panel is
   *  built on). Follows the app's theme setting — its chosen theme's appearance,
   *  or the OS when it follows the system — not just the raw OS preference. */
  function applyAppearance(systemDark: boolean): void {
    const meta = findThemeById(computeActiveThemeId(settings.theme, systemDark))
    document.documentElement.style.colorScheme = meta?.appearance ?? (systemDark ? 'dark' : 'light')
  }

  onMount(() => {
    let stopAppearance = () => {}
    void (async () => {
      try {
        await loadSettings()
        await loadLocale()
        await loadThemes()
        stopAppearance = observePrefersColorScheme(applyAppearance)
        try { await getCurrentWindow().setTitle(t('insights.windowTitle')) } catch { /* no-op */ }
        await initActivePluginIds()
        await refreshSotvault()
      } catch (e) {
        console.error('[insights] init failed:', e)
      }
      ready = true
    })()
    return () => stopAppearance()
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
  :global(body) { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: Canvas; color: CanvasText; }
  main { height: 100vh; overflow: auto; padding: 12px 16px; box-sizing: border-box; }
  .msg { color: color-mix(in srgb, CanvasText 55%, transparent); font-size: 13px; padding: 20px; }
</style>
