<script lang="ts">
  import {
    updater, downloadAndInstall, dismissCurrent, restartApp,
  } from '../lib/updater.svelte'
  import { t } from '../lib/i18n/store.svelte'

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
        <h2 id="updater-title">{t('updateDialog.checking')}</h2>
        <p class="meta">{t('updateDialog.currentVersion', { version: updater.currentVersion ?? '' })}</p>
        <div class="progress-wrap">
          <div class="progress">
            <div class="bar indeterminate" style:width="30%"></div>
          </div>
        </div>
        <footer>
          <button class="ghost" onclick={close}>{t('common.close')}</button>
        </footer>

      {:else if updater.state === 'available'}
        <h2 id="updater-title">{t('updateDialog.available', { version: updater.latestVersion ?? '' })}</h2>
        <p class="meta">{t('updateDialog.currentVersion', { version: updater.currentVersion ?? '' })}</p>
        {#if updater.notes}
          <div class="notes">
            <h3>{t('updateDialog.whatsNew')}</h3>
            <pre>{updater.notes}</pre>
          </div>
        {:else}
          <p class="meta">{t('updateDialog.noNotes')}</p>
        {/if}
        <footer>
          <button class="ghost" onclick={onSkip}>{t('updateDialog.skip')}</button>
          <button class="ghost" onclick={close}>{t('updateDialog.later')}</button>
          <button class="primary" onclick={onUpdateNow}>{t('updateDialog.updateNow')}</button>
        </footer>

      {:else if updater.state === 'downloading'}
        <h2 id="updater-title">{t('updateDialog.downloading', { version: updater.latestVersion ?? '' })}</h2>
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
          <button class="ghost" onclick={close}>{t('updateDialog.runInBackground')}</button>
        </footer>

      {:else if updater.state === 'ready'}
        <h2 id="updater-title">{t('updateDialog.ready')}</h2>
        <p>{t('updateDialog.readyBody', { version: updater.latestVersion ?? '' })}</p>
        <footer>
          <button class="ghost" onclick={close}>{t('updateDialog.restartLater')}</button>
          <button class="primary" onclick={onRestart}>{t('updateDialog.restartNow')}</button>
        </footer>

      {:else if updater.state === 'error'}
        <h2 id="updater-title">{t('updateDialog.error')}</h2>
        <p class="error">{updater.error ?? t('updateDialog.unknownError')}</p>
        <footer>
          <button class="ghost" onclick={close}>{t('common.close')}</button>
        </footer>

      {:else}
        <h2 id="updater-title">{t('updateDialog.upToDate')}</h2>
        <p class="meta">{t('updateDialog.currentVersion', { version: updater.currentVersion ?? '' })}</p>
        <footer>
          <button class="primary" onclick={close}>{t('common.close')}</button>
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
