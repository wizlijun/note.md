<!-- src/daily-notes-app.svelte — standalone Daily Notes window. Bootstraps its
     own webview state, then hosts the toolbar + feed/page views. -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { loadSettings } from './lib/settings.svelte'
  import { loadLocale, t } from './lib/i18n/store.svelte'
  import { loadOutlineDirs } from './lib/outline/dirs.svelte'
  import { refreshSotvault, sotvaultStore } from './lib/sotvault.svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'

  let ready = $state(false)

  onMount(async () => {
    try {
      await loadSettings()
      await loadLocale()
      await loadOutlineDirs()
      try { await getCurrentWindow().setTitle(t('daily.windowTitle')) } catch { /* no-op */ }
      await refreshSotvault()
    } catch (e) {
      console.error('[daily-notes] init failed:', e)
    }
    ready = true
  })
</script>

<main>
  {#if !ready}
    <p class="msg">…</p>
  {:else if sotvaultStore.vaultRoot === null}
    <p class="msg">{t('daily.needsVault')}</p>
  {:else}
    <p class="msg">Daily Notes 窗口就绪（feed 待接入）</p>
  {/if}
</main>

<style>
  :global(:root) { color-scheme: light dark; }
  :global(body) { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: Canvas; color: CanvasText; }
  main { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  .msg { color: color-mix(in srgb, CanvasText 55%, transparent); font-size: 13px; padding: 20px; }
</style>
