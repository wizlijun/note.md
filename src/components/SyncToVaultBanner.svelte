<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { canSyncActive, syncCurrentToVault } from '../lib/sotvault.svelte'

  let { tab }: { tab: Tab } = $props()

  // canSyncActive reads sotvaultStore (vault root + records), so this re-derives
  // when those refresh or the tab's path changes. True only when the plugin is
  // enabled, the Vault is configured, the file is saved, outside the Vault, and
  // not already tracked.
  const canSync = $derived(canSyncActive(tab.filePath || null))
</script>

{#if canSync}
  <div class="banner sync-offer" role="status" aria-live="polite">
    <span class="msg"
      >💡 此文件在 Vault 之外。同步到 Vault 会在 Vault 留一份副本，随 git 自动备份、多设备同步；来源更新时还能一键刷新。</span
    >
    <button class="action" onclick={() => syncCurrentToVault()}>同步到 Vault</button>
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
  .banner.sync-offer {
    background: #d1e7dd;
    color: #0f5132;
  }
  .msg {
    flex: 1;
    min-width: 0;
  }
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
  .action:hover {
    background: rgba(255, 255, 255, 0.85);
  }
</style>
