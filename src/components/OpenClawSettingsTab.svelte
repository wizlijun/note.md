<script lang="ts">
  import { getPluginScopedKey, mergePluginScoped } from '../lib/settings.svelte'
  import { t } from '../lib/i18n/store.svelte'

  let showToken = $state(false)
  let copyHint = $state<string | null>(null)

  function read<T>(key: string, fallback: T): T {
    const v = getPluginScopedKey(`openclaw-chat.${key}`)
    return (v === undefined ? fallback : v) as T
  }

  let mode = $state(read<'auto'|'host'|'remote'>('mode', 'auto'))
  let socketPath = $state(read<string>('socketPath', ''))
  let accessToken = $state(read<string>('accessToken', ''))
  let relayUrl = $state(read<string>('relayUrl', ''))
  let autoSyncBeforeResolve = $state(read<boolean>('autoSyncBeforeResolve', true))

  async function persist() {
    await mergePluginScoped({
      'openclaw-chat.mode': mode,
      'openclaw-chat.socketPath': socketPath,
      'openclaw-chat.accessToken': accessToken,
      'openclaw-chat.relayUrl': relayUrl,
      'openclaw-chat.autoSyncBeforeResolve': autoSyncBeforeResolve,
    })
  }

  async function copyToken() {
    if (!accessToken) return
    try {
      await navigator.clipboard.writeText(accessToken)
      copyHint = t('openclaw.copied')
      setTimeout(() => { copyHint = null }, 1500)
    } catch (e) {
      copyHint = t('openclaw.copyFailed')
      setTimeout(() => { copyHint = null }, 2000)
    }
  }
</script>

<section class="block">
  <h3>{t('openclaw.heading')}</h3>

  <label class="row">
    <span class="lbl">{t('openclaw.connectMode')}</span>
    <select bind:value={mode} onchange={persist}>
      <option value="auto">{t('openclaw.autoDetect')}</option>
      <option value="host">{t('openclaw.modeHost')}</option>
      <option value="remote">{t('openclaw.modeRemote')}</option>
    </select>
  </label>

  <label class="row">
    <span class="lbl">{t('openclaw.socketPath')}</span>
    <input
      type="text"
      bind:value={socketPath}
      placeholder="~/.openclaw/mdeditor.sock"
      onchange={persist}
    />
  </label>

  <label class="row">
    <span class="lbl">{t('openclaw.accessToken')}</span>
    <input
      type={showToken ? 'text' : 'password'}
      bind:value={accessToken}
      placeholder={t('openclaw.runToGenerate')}
      onchange={persist}
    />
    <button type="button" class="mini" onclick={() => showToken = !showToken}>{showToken ? t('openclaw.hide') : t('openclaw.show')}</button>
    <button type="button" class="mini" onclick={copyToken} disabled={!accessToken}>{copyHint ?? t('openclaw.copy')}</button>
  </label>

  <label class="row">
    <span class="lbl">{t('openclaw.relayUrl')}</span>
    <input
      type="text"
      bind:value={relayUrl}
      placeholder="wss://mdrelay.example.com"
      onchange={persist}
    />
  </label>

  <label class="row" style="margin-top: 6px;">
    <input
      type="checkbox"
      bind:checked={autoSyncBeforeResolve}
      onchange={persist}
    />
    {t('openclaw.autoSync')}
  </label>
</section>

<style>
  .block {
    padding: 12px 0;
    border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
  }
  .block:first-of-type { border-top: 0; padding-top: 0; }
  h3 {
    margin: 0 0 8px 0;
    font-size: 13px;
    font-weight: 600;
  }
  .row { display: flex; gap: 8px; align-items: center; font-size: 13px; margin-bottom: 10px; }
  .row .lbl {
    width: 80px;
    flex-shrink: 0;
  }
  .row input[type="text"],
  .row input[type="password"],
  .row select {
    flex: 1;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: Canvas;
    color: CanvasText;
    font-size: 13px;
  }
  .row input[type="checkbox"] { width: auto; }
  .mini {
    flex-shrink: 0;
    padding: 4px 8px;
    font-size: 12px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: Canvas;
    color: CanvasText;
    cursor: pointer;
  }
  .mini:disabled { opacity: 0.4; cursor: default; }
</style>
