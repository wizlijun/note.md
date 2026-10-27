<script lang="ts">
  import { onMount } from 'svelte'
  import { taskHook, loadTaskHook, selectTaskHook, clearTaskHook, setTaskHookEnvironment } from '../lib/task-hook.svelte'
  import { t } from '../lib/strings'

  let busy = $state(true)
  let error = $state(false)
  let environmentDraft = $state('')
  let environmentError = $state(false)
  let environmentFeedback = $state<'saved' | 'cleared' | null>(null)
  onMount(() => { void loadTaskHook().finally(() => { busy = false }) })

  async function change(select: boolean) {
    if (busy) return
    busy = true
    error = false
    try { await (select ? selectTaskHook() : clearTaskHook()) }
    catch { error = true }
    finally { busy = false }
  }

  async function saveEnvironment(clear: boolean) {
    if (busy) return
    busy = true
    environmentError = false
    environmentFeedback = null
    try {
      await setTaskHookEnvironment(clear ? '' : environmentDraft)
      environmentDraft = ''
      environmentFeedback = clear ? 'cleared' : 'saved'
    } catch { environmentError = true }
    finally { busy = false }
  }
</script>

<section class="hook-settings" aria-labelledby="hook-title">
  <strong id="hook-title">{t('hook.settings.title')}</strong>
  <p>{t('hook.settings.help')}</p>
  {#if taskHook.config.available}
    <p class="path" data-hook-path>{taskHook.config.scriptPath ?? t('hook.settings.none')}</p>
    <div class="actions">
      <button type="button" onclick={() => change(true)} disabled={busy}>{t('hook.settings.select')}</button>
      {#if taskHook.config.configured}
        <button type="button" onclick={() => change(false)} disabled={busy}>{t('hook.settings.clear')}</button>
      {/if}
    </div>
    <p>{t('hook.settings.local')}</p>
    <div class="environment">
      <label for="hook-environment">{t('hook.environment.title')}</label>
      {#if taskHook.config.environmentSupported}
        <p>{t('hook.environment.help')}</p>
        <p data-environment-keys>{taskHook.config.environmentKeys?.length
          ? t('hook.environment.configured', { keys: taskHook.config.environmentKeys.join(', ') })
          : t('hook.environment.none')}</p>
        <textarea id="hook-environment" bind:value={environmentDraft} rows="3" maxlength="16384"
          spellcheck="false" autocomplete="off" autocapitalize="off" disabled={busy}
          placeholder={'DESK_DISPLAY_URL=https://example.invalid\nDESK_DISPLAY_TOKEN=your-token'}></textarea>
        <div class="actions">
          <button type="button" onclick={() => saveEnvironment(false)} disabled={busy || !environmentDraft.trim()}>{t('hook.environment.save')}</button>
          <button type="button" onclick={() => saveEnvironment(true)} disabled={busy || !taskHook.config.environmentKeys?.length}>{t('hook.environment.clear')}</button>
        </div>
        <p>{t('hook.environment.local')}</p>
        {#if environmentFeedback}<p role="status">{t(environmentFeedback === 'saved' ? 'hook.environment.saved' : 'hook.environment.cleared')}</p>{/if}
        {#if environmentError}<p class="error" role="alert">{t('hook.environment.error')}</p>{/if}
      {:else}
        <p role="status">{t('hook.environment.unavailable')}</p>
      {/if}
    </div>
  {:else}
    <p role="status">{t('hook.settings.unavailable')}</p>
  {/if}
  {#if error}<p class="error" role="alert">{t('hook.settings.error')}</p>{/if}
</section>

<style>
  .hook-settings { padding: 18px 0; border-bottom: 1px solid var(--line); }
  strong { font-size: 13px; }
  p { margin: 7px 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
  .path { overflow-wrap: anywhere; color: var(--fg); }
  .actions { display: flex; gap: 8px; margin: 10px 0; }
  button { border: 1px solid var(--line-strong); border-radius: 8px; background: var(--card); color: var(--fg); padding: 7px 11px; font: inherit; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--hover); }
  button:disabled { opacity: .5; cursor: default; }
  .environment { margin-top: 18px; }
  label { display: block; font-size: 13px; font-weight: 600; }
  textarea { display: block; box-sizing: border-box; width: 100%; resize: vertical; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--card); color: var(--fg); padding: 9px 11px; font: 12px/1.5 monospace; }
  .error { color: var(--danger); }
</style>
