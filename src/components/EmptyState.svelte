<script lang="ts">
  import { onMount } from 'svelte'
  import { platform } from '../lib/platform.svelte'
  import VaultOverview from './VaultOverview.svelte'
  import HomeApps from './HomeApps.svelte'
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
    if (event.target instanceof Element && event.target.closest('.vault-overview, .home-apps, button')) return
    void action(newFile)
  }
</script>
<div class="empty" role="presentation" ondblclick={onDblClick}>
  <div class="welcome">
    <div class="identity"><span class="wordmark">note.md</span><span class="version">v{version}</span></div>
    <div class="home-create home-grid">
      <button class="home-tile" title={t('emptyState.new')} onclick={() => void action(newFile)}><AppIcon glyph="note" tone="blue"/><span class="tile-label">{t('homeApps.newNote')}</span></button>
      <button class="home-tile" onclick={() => void action(newCanvas)}><AppIcon glyph="canvas" tone="teal"/><span class="tile-label">{t('homeApps.newCanvas')}</span></button>
      <button class="home-tile" onclick={() => void action(onOpen)}><AppIcon glyph="folder" tone="ochre"/><span class="tile-label">{t('homeApps.openFile')}</span></button>
    </div>
    {#if desktop}<HomeApps /><section class="home-settings" aria-label={t('homeApps.settings')}><div class="home-section-heading"><h2>{t('homeApps.settings')}</h2><button class="home-control" onclick={() => openSettings()}>{t('homeApps.allSettings')}</button></div><VaultOverview /></section>{/if}
  </div>
</div>
<style>
  .empty { flex:1; display:flex; min-width:0; min-height:0; padding:32px 24px; box-sizing:border-box; overflow:auto; container-type:inline-size; color:CanvasText; }
  .welcome { width:560px; max-width:100%; margin:auto; }
  .identity { display:flex; align-items:baseline; gap:12px; margin-bottom:32px; user-select:none; }
  .wordmark { font-size:24px; font-weight:650; letter-spacing:-.06em; }
  .version { color:GrayText; font:11px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .home-create { margin-bottom:32px; }
  .home-settings { margin-top:32px; }
  .home-settings :global(.vault-overview) { margin-top:0; }
</style>
