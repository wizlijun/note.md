<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import {
    reloadFromDisk, overwriteOnDisk, dismissExternalBanner,
    saveActive, saveAs, closeTab, activate,
  } from '../lib/tabs.svelte'
  import { pickSaveFile, confirmDirtyClose } from '../lib/dialogs'

  let { tab }: { tab: Tab } = $props()

  async function onSaveAs() {
    const path = await pickSaveFile(tab.filePath)
    if (path) await saveAs(tab.id, path)
  }

  async function onRecreate() {
    activate(tab.id)
    await saveActive()
  }

  async function onCloseTab() {
    await closeTab(tab.id, confirmDirtyClose)
  }
</script>

{#if !tab.externalBannerDismissed}
  {#if tab.externalState === 'changed'}
    <div class="banner changed" role="status" aria-live="polite">
      <span class="msg">"{tab.title}" was modified by another application.</span>
      <button class="action" onclick={() => reloadFromDisk(tab.id)}>Reload from disk</button>
      <button class="action" onclick={() => overwriteOnDisk(tab.id)}>Overwrite with my changes</button>
      <button class="action" onclick={onSaveAs}>Save as…</button>
      <button class="dismiss" aria-label="Dismiss"
              onclick={() => dismissExternalBanner(tab.id)}>×</button>
    </div>
  {:else if tab.externalState === 'deleted'}
    <div class="banner deleted" role="status" aria-live="polite">
      <span class="msg">"{tab.title}" was deleted on disk.</span>
      <button class="action" onclick={onRecreate}>Recreate on Save (⌘S)</button>
      <button class="action" onclick={onSaveAs}>Save as…</button>
      <button class="action" onclick={onCloseTab}>Close tab</button>
      <button class="dismiss" aria-label="Dismiss"
              onclick={() => dismissExternalBanner(tab.id)}>×</button>
    </div>
  {/if}
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    font-size: 12px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
  }
  .banner.changed {
    background: #fff3cd;
    color: #664d03;
  }
  .banner.deleted {
    background: #fff3cd;
    color: #842029;
    border-left: 3px solid #d33;
  }
  .msg { flex: 1; }
  .action {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    background: rgba(255,255,255,0.5);
    color: inherit;
    cursor: pointer;
    font-size: 11px;
  }
  .action:hover { background: rgba(255,255,255,0.85); }
  .dismiss {
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    font-size: 16px;
    padding: 0 4px;
    opacity: 0.6;
  }
  .dismiss:hover { opacity: 1; }
</style>
