<script lang="ts">
  import { updater, shouldShowBanner, dismissCurrent } from '../lib/updater.svelte'

  let { onShowDetails }: { onShowDetails: () => void } = $props()

  let visible = $derived(shouldShowBanner())

  let percent = $derived.by(() => {
    if (!updater.contentLength || updater.contentLength <= 0) return null
    return Math.min(100, Math.round((updater.downloaded / updater.contentLength) * 100))
  })
</script>

{#if visible}
  {#if updater.state === 'available'}
    <div class="banner available" role="status" aria-live="polite">
      <span class="msg">✨ M↓ {updater.latestVersion} 可用</span>
      <button class="action" onclick={onShowDetails}>查看详情</button>
      <button class="dismiss" aria-label="关闭" onclick={() => dismissCurrent()}>×</button>
    </div>
  {:else if updater.state === 'downloading'}
    <div class="banner downloading" role="status" aria-live="polite">
      <span class="msg">
        正在下载 {updater.latestVersion}…
        {#if percent !== null}({percent}%){/if}
      </span>
      <button class="action" onclick={onShowDetails}>显示进度</button>
    </div>
  {:else if updater.state === 'ready'}
    <div class="banner ready" role="status" aria-live="polite">
      <span class="msg">✅ {updater.latestVersion} 已下载，重启即可完成更新</span>
      <button class="action" onclick={onShowDetails}>重启…</button>
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
  .banner.available {
    background: color-mix(in srgb, #4f8cff 18%, transparent);
    color: color-mix(in srgb, #1c4ea8 70%, CanvasText);
  }
  .banner.downloading {
    background: color-mix(in srgb, #4f8cff 14%, transparent);
    color: color-mix(in srgb, #1c4ea8 70%, CanvasText);
  }
  .banner.ready {
    background: color-mix(in srgb, #2bb673 22%, transparent);
    color: color-mix(in srgb, #0f6b3e 70%, CanvasText);
  }
  .msg { flex: 1; }
  .action {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    background: rgba(255, 255, 255, 0.55);
    color: inherit;
    cursor: pointer;
    font-size: 11px;
  }
  .action:hover { background: rgba(255, 255, 255, 0.9); }
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
