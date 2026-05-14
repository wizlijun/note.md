<script lang="ts">
  import {
    updater, downloadAndInstall, dismissCurrent, restartApp,
  } from '../lib/updater.svelte'

  let { open = $bindable(false) }: { open: boolean } = $props()

  let percent = $derived.by(() => {
    if (!updater.contentLength || updater.contentLength <= 0) return null
    return Math.min(100, Math.round((updater.downloaded / updater.contentLength) * 100))
  })

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  }

  async function onUpdateNow() {
    try {
      await downloadAndInstall()
    } catch (e) {
      console.warn('[UpdateDialog] downloadAndInstall:', e)
    }
  }

  async function onSkip() {
    await dismissCurrent()
    open = false
  }

  async function onRestart() {
    try {
      await restartApp()
    } catch (e) {
      console.warn('[UpdateDialog] relaunch:', e)
    }
  }

  function close() { open = false }
</script>

{#if open}
  <div class="overlay" role="presentation" onclick={close}>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="updater-title"
         onclick={(e) => e.stopPropagation()}>

      {#if updater.state === 'checking'}
        <h2 id="updater-title">正在检查更新…</h2>
        <p class="meta">当前版本：v{updater.currentVersion}</p>
        <div class="progress-wrap">
          <div class="progress">
            <div class="bar indeterminate" style:width="30%"></div>
          </div>
        </div>
        <footer>
          <button class="ghost" onclick={close}>关闭</button>
        </footer>

      {:else if updater.state === 'available'}
        <h2 id="updater-title">M↓ {updater.latestVersion} 可用</h2>
        <p class="meta">当前版本：v{updater.currentVersion}</p>
        {#if updater.notes}
          <div class="notes">
            <h3>更新内容</h3>
            <pre>{updater.notes}</pre>
          </div>
        {:else}
          <p class="meta">暂无更新说明。</p>
        {/if}
        <footer>
          <button class="ghost" onclick={onSkip}>跳过此版本</button>
          <button class="ghost" onclick={close}>稍后</button>
          <button class="primary" onclick={onUpdateNow}>立即更新</button>
        </footer>

      {:else if updater.state === 'downloading'}
        <h2 id="updater-title">正在下载 {updater.latestVersion}…</h2>
        <div class="progress-wrap">
          <div class="progress">
            <div class="bar" style:width={percent !== null ? `${percent}%` : '30%'} class:indeterminate={percent === null}></div>
          </div>
          <p class="progress-text">
            {#if percent !== null && updater.contentLength}
              {formatBytes(updater.downloaded)} / {formatBytes(updater.contentLength)} ({percent}%)
            {:else}
              {formatBytes(updater.downloaded)}
            {/if}
          </p>
        </div>
        <footer>
          <button class="ghost" onclick={close}>后台运行</button>
        </footer>

      {:else if updater.state === 'ready'}
        <h2 id="updater-title">准备就绪</h2>
        <p>M↓ {updater.latestVersion} 已下载完成。重启 App 即可完成更新。</p>
        <footer>
          <button class="ghost" onclick={close}>稍后重启</button>
          <button class="primary" onclick={onRestart}>立即重启</button>
        </footer>

      {:else if updater.state === 'error'}
        <h2 id="updater-title">更新出错</h2>
        <p class="error">{updater.error ?? '未知错误'}</p>
        <footer>
          <button class="ghost" onclick={close}>关闭</button>
        </footer>

      {:else}
        <h2 id="updater-title">M↓ 已是最新版本</h2>
        <p class="meta">当前版本：v{updater.currentVersion}</p>
        <footer>
          <button class="primary" onclick={close}>关闭</button>
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex; align-items: center; justify-content: center;
    z-index: 9999;
  }
  .dialog {
    background: Canvas;
    color: CanvasText;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
    width: min(520px, 92vw);
    max-height: 80vh;
    overflow: auto;
    padding: 20px 22px;
    font-size: 13px;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 16px;
    font-weight: 600;
  }
  h3 {
    margin: 14px 0 6px;
    font-size: 13px;
    font-weight: 600;
  }
  .meta {
    margin: 4px 0;
    color: color-mix(in srgb, CanvasText 60%, transparent);
    font-size: 12px;
  }
  .notes {
    margin: 12px 0;
    max-height: 280px;
    overflow: auto;
    background: color-mix(in srgb, CanvasText 5%, transparent);
    border-radius: 6px;
    padding: 10px 12px;
  }
  .notes pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.5;
  }
  .progress-wrap { margin: 18px 0; }
  .progress {
    height: 10px;
    background: color-mix(in srgb, CanvasText 12%, transparent);
    border-radius: 999px;
    overflow: hidden;
  }
  .bar {
    height: 100%;
    background: #4f8cff;
    transition: width 0.2s ease-out;
  }
  .bar.indeterminate {
    animation: slide 1.4s linear infinite;
  }
  @keyframes slide {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(300%); }
  }
  .progress-text {
    margin: 8px 0 0;
    font-size: 11px;
    color: color-mix(in srgb, CanvasText 60%, transparent);
    text-align: center;
  }
  .error {
    color: tomato;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  footer {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 18px;
  }
  button {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    cursor: pointer;
    font-size: 12px;
  }
  button.ghost {
    background: transparent;
    color: inherit;
  }
  button.ghost:hover {
    background: color-mix(in srgb, CanvasText 8%, transparent);
  }
  button.primary {
    background: #4f8cff;
    color: white;
    border-color: #4f8cff;
  }
  button.primary:hover {
    background: #3d78ee;
  }
</style>
