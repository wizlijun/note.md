<script lang="ts">
  import { onMount } from 'svelte'
  import { platform } from '../lib/platform.svelte'
  import VaultOverview from './VaultOverview.svelte'
  import HomeApps from './HomeApps.svelte'
  import HomeContent from './HomeContent.svelte'
  import AppIcon from './AppIcon.svelte'
  import '../styles/home-apps.css'
  import { version } from '../../package.json'
  import { pickOpenFile, showError } from '../lib/dialogs'
  import { openFile, newCanvas, newFile } from '../lib/tabs.svelte'
  import { openSettings } from '../lib/ui-state.svelte'
  import { t } from '../lib/i18n/store.svelte'
  let desktop = $state(false)
  onMount(() => { void platform().then(value => { desktop = value !== 'ios' }).catch(e => showError(String(e))) })
  async function action(run: () => unknown) { try { await run() } catch (e) { showError(String(e)) } }
  async function onOpen() { const path = await pickOpenFile(); if (path) await openFile(path) }
  function onDblClick(event: MouseEvent) {
    if (event.target instanceof Element && event.target.closest('.vault-overview, .home-apps, .home-content, .home-ai, .home-footer, button')) return
    void action(newFile)
  }
</script>
<div class="empty" role="presentation" ondblclick={onDblClick}>
  <div class="welcome">
    <div class="identity"><span class="wordmark">note.md</span><span class="version">v{version}</span></div>
    {#if desktop}
      <HomeApps />
      <HomeContent />
      <section class="home-ai" aria-labelledby="home-ai-title">
        <div class="home-section-heading"><h2 id="home-ai-title">{t('homeAi.title')}</h2></div>
        <div class="ai-empty">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/></svg>
          <p>{t('homeAi.empty')}</p>
        </div>
      </section>
      <footer class="home-footer" aria-label={t('homeApps.settings')}>
        <VaultOverview compact />
        <button class="home-control settings-button" onclick={() => openSettings()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 4 3 2 3-1 2 3 4-1 1-3 3-1 1-4-3-2V6l-4-1-2 2z"/><circle cx="12" cy="12" r="3"/></svg>
          {t('homeApps.allSettings')}
        </button>
      </footer>
    {:else}<div class="home-create home-grid">
      <button class="home-tile" title={t('emptyState.new')} onclick={() => void action(newFile)}><AppIcon glyph="note" tone="blue"/><span class="tile-label">{t('homeApps.newNote')}</span></button>
      <button class="home-tile" onclick={() => void action(newCanvas)}><AppIcon glyph="canvas" tone="teal"/><span class="tile-label">{t('homeApps.newCanvas')}</span></button>
      <button class="home-tile" onclick={() => void action(onOpen)}><AppIcon glyph="folder" tone="ochre"/><span class="tile-label">{t('homeApps.openFile')}</span></button>
    </div>{/if}
  </div>
</div>
<style>
  .empty { flex:1; display:flex; min-width:0; min-height:0; padding:32px 16px; box-sizing:border-box; overflow:auto; container-type:inline-size; color:CanvasText; }
  .welcome { width:760px; max-width:100%; margin:auto; }
  .identity { display:flex; align-items:baseline; gap:12px; margin-bottom:32px; user-select:none; }
  .wordmark { font-size:20px; font-weight:650; letter-spacing:-.06em; }
  .version { color:GrayText; font:11px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .home-create { margin-bottom:32px; }
  .welcome :global(.home-apps) { margin-bottom:28px; }
  .home-ai { margin-top:28px; }
  .home-ai .home-section-heading { margin-bottom:12px; }
  .ai-empty { display:flex; align-items:center; justify-content:center; gap:10px; min-height:80px; padding:12px 16px; box-sizing:border-box; border:1px solid color-mix(in srgb,CanvasText 9%,transparent); border-radius:10px; color:GrayText; background:color-mix(in srgb,CanvasText 3%,Canvas); }
  .ai-empty svg { flex:none; }
  .ai-empty p { margin:0; font-size:12px; line-height:1.6; }
  .home-footer { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:start; gap:16px; margin-top:28px; padding-top:18px; border-top:1px solid color-mix(in srgb,CanvasText 12%,transparent); }
  .settings-button { display:flex; align-items:center; gap:6px; white-space:nowrap; }
  @container(max-width:420px) { .home-footer { gap:10px; } }
</style>
