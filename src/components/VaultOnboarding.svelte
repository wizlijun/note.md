<script lang="ts">
  import { open } from '@tauri-apps/plugin-dialog'
  import { t } from '../lib/i18n/store.svelte'
  import { modalFocus } from '../lib/ui/modal-focus'
  import { openSettings } from '../lib/ui-state.svelte'
  import {
    vaultManagement, abbreviateHome, vaultChildPath, validVaultName,
    createVault, activateVault, skipVaultOnboarding,
  } from '../lib/vault-management.svelte'

  let step = $state<'welcome' | 'create' | 'existing' | 'done'>('welcome')
  let name = $state('My Vault')
  let parent = $state('')
  let pickedPath = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let wasOpen = false
  $effect(() => {
    if (vaultManagement.onboardingOpen && !wasOpen) {
      step = 'welcome'
      name = 'My Vault'
      parent = vaultManagement.info?.documentsDir ?? ''
      pickedPath = ''
      error = null
    }
    wasOpen = vaultManagement.onboardingOpen
  })
  const displayPath = (path: string) => abbreviateHome(path, vaultManagement.info?.homeDir)
  const target = $derived(parent ? vaultChildPath(parent, name) : '')
  const canCreate = $derived(!busy && !!parent && validVaultName(name) && !vaultManagement.info?.root)

  async function chooseFolder(forCreation: boolean) {
    if (busy) return
    busy = true
    error = null
    try {
      const path = await open({ directory: true, multiple: false, title: t('vaultManage.chooseFolder'), defaultPath: parent || undefined })
      if (typeof path === 'string') {
        if (forCreation) parent = path
        else { pickedPath = path; step = 'existing' }
      }
    } catch (e) { error = String(e) }
    finally { busy = false }
  }

  async function submit() {
    if (busy || (step === 'create' && !canCreate) || vaultManagement.info?.root) return
    if (step !== 'create' && step !== 'existing') return
    busy = true
    error = null
    try {
      if (step === 'create') await createVault(parent, name)
      else await activateVault(pickedPath, null)
      step = 'done'
    } catch (e) { error = String(e) }
    finally { busy = false }
  }

  async function close() {
    if (busy) return
    if (step === 'done') { vaultManagement.onboardingOpen = false; return }
    busy = true
    error = null
    try { await skipVaultOnboarding() }
    catch (e) { error = String(e) }
    finally { busy = false }
  }

  function finish(settings = false) {
    vaultManagement.onboardingOpen = false
    if (settings) openSettings('vault')
  }
</script>

{#if vaultManagement.onboardingOpen}
  <div class="vault-onboarding-overlay">
    <div class="vault-onboarding ui-surface" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="vault-onboarding-title"
      aria-busy={busy} use:modalFocus={{ onClose: () => void close(), canClose: () => !busy }}>
      <p class="eyebrow">{t('vaultManage.welcome')}</p>
      <h2 id="vault-onboarding-title">{step === 'done' ? t('vaultManage.ready') : step === 'create' ? t('vaultManage.create') : t('vaultManage.start')}</h2>
      {#if step === 'welcome'}
        <p>{t('vaultManage.intro')}</p>
        <div class="actions">
          <button class="primary" disabled={busy} onclick={() => { step = 'create'; error = null }}>{t('vaultManage.create')}</button>
          <button disabled={busy} onclick={() => void chooseFolder(false)}>{t('vaultManage.openExisting')}</button>
        </div>
        <button class="quiet" disabled={busy} onclick={() => void close()}>{t('vaultManage.skip')}</button>
      {:else if step === 'create'}
        <form onsubmit={(event) => { event.preventDefault(); void submit() }}>
          <fieldset disabled={busy}>
            <label for="vault-create-name">{t('vaultManage.name')}</label>
            <input id="vault-create-name" bind:value={name} autocomplete="off" />
            {#if name && !validVaultName(name)}<p class="error">{t('vaultManage.invalidName')}</p>{/if}
            <span class="label">{t('vaultManage.location')}</span>
            <div class="path-row"><code title={parent}>{displayPath(parent) || '—'}</code><button type="button" onclick={() => void chooseFolder(true)}>{t('vaultManage.chooseFolder')}</button></div>
            <span class="label">{t('vaultManage.finalPath')}</span>
            <code class="full-path" title={target}>{displayPath(target) || '—'}</code>
            <div class="actions">
              <button type="button" onclick={() => { step = 'welcome'; error = null }}>{t('common.cancel')}</button>
              <button type="submit" class="primary" disabled={!canCreate}>{busy ? t('vaultManage.busy') : t('vaultManage.create')}</button>
            </div>
          </fieldset>
        </form>
      {:else if step === 'existing'}
        <code class="full-path" title={pickedPath}>{displayPath(pickedPath)}</code>
        <p>{t('vaultManage.existingHint')}</p>
        <div class="actions">
          <button disabled={busy} onclick={() => { step = 'welcome'; error = null }}>{t('common.cancel')}</button>
          <button class="primary" disabled={busy} onclick={() => void submit()}>{busy ? t('vaultManage.busy') : t('vaultManage.useFolder')}</button>
        </div>
      {:else}
        <code class="full-path" title={vaultManagement.info?.root ?? ''}>{displayPath(vaultManagement.info?.root ?? '')}</code>
        <p>{t('vaultManage.gitLater')}</p>
        <div class="actions">
          <button class="primary" onclick={() => finish()}>{t('vaultManage.begin')}</button>
          <button onclick={() => finish(true)}>{t('vaultManage.settings')}</button>
        </div>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if busy}<p role="status" aria-live="polite">{t('vaultManage.busy')}</p>{/if}
    </div>
  </div>
{/if}

<style>
  .vault-onboarding-overlay { position: fixed; inset: 0; z-index: 1600; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgb(0 0 0 / 30%); }
  .vault-onboarding { width: 480px; max-width: 100%; max-height: calc(100vh - 48px); overflow: auto; padding: 28px; border: 1px solid var(--ui-control-border); border-radius: 12px; background: var(--ui-surface, Canvas); color: CanvasText; box-shadow: 0 12px 48px rgb(0 0 0 / 20%); }
  .eyebrow { font-size: 12px; color: var(--ui-secondary); margin: 0 0 8px; }
  h2 { margin: 0 0 16px; font-size: 23px; }
  p { font-size: 13px; line-height: 1.6; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
  button { font: inherit; font-size: 13px; padding: 8px 12px; border: 1px solid var(--ui-control-border); border-radius: 6px; background: var(--ui-surface, Canvas); color: CanvasText; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--ui-hover); }
  button.primary { background: var(--ui-accent); color: var(--ui-accent-foreground, white); border-color: var(--ui-accent); }
  button.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--ui-accent) 88%, black); }
  button:disabled { opacity: 0.5; cursor: default; }
  .quiet { background: transparent; border: 0; padding: 8px 0; margin-top: 12px; color: var(--ui-secondary); }
  fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
  label, .label { display: block; font-size: 13px; margin: 16px 0 6px; }
  input { box-sizing: border-box; width: 100%; padding: 8px; border: 1px solid var(--ui-control-border); border-radius: 6px; font: inherit; background: var(--ui-surface, Canvas); color: CanvasText; }
  .path-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  code { overflow-wrap: anywhere; font-size: 12px; }
  .path-row code { flex: 1; min-width: 100px; }
  .full-path { display: block; padding: 10px; background: var(--ui-bg); border-radius: 6px; }
  .error { color: var(--ui-danger); overflow-wrap: anywhere; }
</style>
