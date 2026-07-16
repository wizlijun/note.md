<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { noteSiblings, sotvaultStore, type NoteSibling } from '../lib/sotvault.svelte'
  import { openFile } from '../lib/tabs.svelte'
  import { t } from '../lib/i18n/store.svelte'

  let { tab }: { tab: Tab } = $props()

  let siblings = $state<NoteSibling[]>([])
  // Recompute when the tab path changes OR sotvault records/metas refresh (tick).
  $effect(() => {
    const path = tab.filePath
    void sotvaultStore.tick
    siblings = []
    if (!path) return
    noteSiblings(path).then((s) => { siblings = s })
  })
</script>

{#if siblings.length > 0}
  <div class="banner mirror-siblings" role="status" aria-live="polite">
    <span class="label">{t('mirrorSiblings.label', { n: siblings.length })}</span>
    {#each siblings as sib (sib.notePath)}
      <button class="action" onclick={() => openFile(sib.notePath)}>{t('mirrorSiblings.openNote', { device: sib.deviceName })}</button>
    {/each}
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 6px 10px;
    font-size: 12px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
  }
  .banner.mirror-siblings {
    background: #e2e3ff;
    color: #2f2b7a;
  }
  .label { white-space: nowrap; }
  .action {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    background: rgba(255, 255, 255, 0.5);
    color: inherit;
    cursor: pointer;
    font-size: 11px;
    white-space: nowrap;
  }
  .action:hover { background: rgba(255, 255, 255, 0.85); }
</style>
