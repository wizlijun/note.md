<script lang="ts">
  import { onMount } from 'svelte'
  import { taskHook, loadTaskHook, selectTaskHook, clearTaskHook } from '../lib/task-hook.svelte'
  import { t } from '../lib/strings'

  let busy = $state(false)
  let error = $state(false)
  onMount(() => { void loadTaskHook() })

  async function change(select: boolean) {
    busy = true
    error = false
    try { await (select ? selectTaskHook() : clearTaskHook()) }
    catch { error = true }
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
  .error { color: var(--danger); }
</style>
