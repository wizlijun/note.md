<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { sourceForVaultPath, revealVaultSource } from '../lib/sotvault.svelte'

  let { tab }: { tab: Tab } = $props()

  // sourceForVaultPath reads sotvaultStore.records, so this re-derives whenever
  // the records refresh or the tab's path changes.
  const source = $derived(sourceForVaultPath(tab.filePath || null))
</script>

{#if source}
  <div class="banner sync-origin" role="status" aria-live="polite">
    <span class="label">📎 已从来源同步：</span>
    <button
      class="origin-link"
      title="打开来源所在目录"
      onclick={() => revealVaultSource(source)}
    >{source}</button>
    <button class="action" onclick={() => revealVaultSource(source)}>打开来源目录</button>
  </div>
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
  .banner.sync-origin {
    background: #cfe2ff;
    color: #084298;
  }
  .label { white-space: nowrap; }
  .origin-link {
    flex: 1;
    min-width: 0;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: transparent;
    border: 0;
    padding: 0;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
  .origin-link:hover { opacity: 0.8; }
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
