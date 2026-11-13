<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { listen } from '@tauri-apps/api/event'
  import { open } from '@tauri-apps/plugin-dialog'
  import { writeText } from '@tauri-apps/plugin-clipboard-manager'
  import { openPath } from '@tauri-apps/plugin-opener'
  import { onMount, onDestroy, tick, type Snippet } from 'svelte'
  import { t } from '../lib/i18n/store.svelte'
  import { confirmDirtyClose } from '../lib/dialogs'
  import { prepareVaultChange } from '../lib/tabs.svelte'
  import { modalFocus } from '../lib/ui/modal-focus'
  import {
    vaultManagement, refreshVaultManagement, openVaultManagement, abbreviateHome,
    applyVaultInspection, activateVault, type VaultInspection,
  } from '../lib/vault-management.svelte'

  let { onBusyChange, collection, advanced, externalBusy = false }: {
    onBusyChange?: (busy: boolean) => void
    externalBusy?: boolean
    collection?: Snippet
    advanced?: Snippet
  } = $props()
  let busy = $state(false)
  const locked = $derived(busy || externalBusy)
  let error = $state<string | null>(null)
  let feedback = $state<string | null>(null)
  let confirmation = $state<'change' | 'git' | 'sync' | null>(null)
  let expectedRoot = $state<string | null>(null)
  let candidate = $state('')
  let advancedOpen = $state(false)
  let cancelButton: HTMLButtonElement | undefined = $state()
  let sync = $state<{ repo_path: string | null; state: string; last_sync: string | null; error_message: string | null } | null>(null)
  const info = $derived(vaultManagement.info)
  const syncLabel = $derived.by(() => {
    if (busy) return t('vaultManage.busy')
    if (!sync || sync.repo_path !== info?.root) return t('vaultManage.loading')
    switch (sync.state) {
      case 'running': return t('vaultManage.running')
      case 'syncing': return t('vault.syncing')
      case 'stopped': return t('vaultManage.paused')
      case 'not_configured': return t('vault.notConfigured')
      case 'git_unavailable': return t('vaultManage.gitMissing')
      case 'conflict': return t('vault.hasConflicts')
      default: return t('vault.unknownError')
    }
  })
  const displayPath = (path: string) => abbreviateHome(path, info?.homeDir)
  const canSync = $derived(!!info?.accessible && info.git.state === 'ready' && !!info.git.remote
    && info.git.branch === 'main' && info.git.hasCommits && info.git.authorConfigured)
  $effect(() => { onBusyChange?.(busy) })
  onDestroy(() => onBusyChange?.(false))

  async function refresh() {
    try {
      await refreshVaultManagement()
      await refreshSync()
    } catch (e) { error = String(e) }
  }
  async function refreshSync() {
    const status = await invoke<typeof sync>('vault_sync_status')
    if (status?.repo_path === vaultManagement.info?.root) sync = status
  }
  onMount(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void refresh()
    void listen('vault-sync-state-changed', () => { void refreshSync().catch(() => {}) })
      .then(stop => { if (disposed) stop(); else unlisten = stop })
      .catch(() => {})
    return () => { disposed = true; unlisten?.() }
  })

  async function run(action: () => Promise<void>) {
    if (locked) return
    busy = true
    error = null
    feedback = null
    try { await action() }
    catch (e) { error = String(e) }
    finally { busy = false }
  }

  async function chooseLocation() {
    if (!info?.root) return
    const root = info.root
    await run(async () => {
      const path = await open({ directory: true, multiple: false, title: t('vaultManage.chooseFolder'), defaultPath: root })
      if (typeof path !== 'string' || path === root) return
      expectedRoot = root
      candidate = path
      confirmation = 'change'
    })
    await tick()
    cancelButton?.focus()
  }
  async function requestConfirmation(kind: 'git' | 'sync') {
    if (locked || !info?.root) return
    expectedRoot = info.root
    confirmation = kind
    error = null
    await tick()
    cancelButton?.focus()
  }
  async function confirm() {
    if (!expectedRoot || !confirmation) return
    const root = expectedRoot, action = confirmation
    await run(async () => {
      if (action === 'change') {
        if (!await prepareVaultChange(confirmDirtyClose)) { error = t('vaultManage.saveFirst'); return }
        await activateVault(candidate, root)
      } else {
        const updated = await invoke<VaultInspection>(action === 'git' ? 'vault_init_git' : 'vault_set_sync', {
          expectedRoot: root, ...(action === 'sync' ? { enabled: true } : {}),
        })
        await applyVaultInspection(updated)
      }
      confirmation = null
      sync = null
      await refreshSync()
      feedback = t('vaultManage.saved')
    })
  }
  async function pause() {
    const root = info?.root
    if (!root) return
    await run(async () => {
      await applyVaultInspection(await invoke<VaultInspection>('vault_set_sync', { expectedRoot: root, enabled: false }))
      await refreshSync()
      feedback = t('vaultManage.saved')
    })
  }
  async function syncNow() {
    const root = info?.root
    if (!root) return
    await run(async () => {
      await invoke('vault_sync_now_for_root', { expectedRoot: root })
      await refreshSync()
    })
  }
</script>

<div class="desktop-vault-settings" aria-busy={busy}>
  {#if error || vaultManagement.error}<p class="error" role="alert">{error ?? vaultManagement.error}</p>{/if}
  {#if feedback}<p class="feedback" role="status">{feedback}</p>{/if}
  {#if !info}
    <p>{t('vaultManage.loading')}</p>
    <button disabled={locked || vaultManagement.loading} onclick={() => void run(refresh)}>{t('vaultManage.recheck')}</button>
  {:else if !info.root}
    <section>
      <h3>{t('vaultManage.none')}</h3>
      <p>{t('vaultManage.intro')}</p>
      <button class="primary" disabled={locked} onclick={() => void openVaultManagement()}>{t('vaultManage.setup')}</button>
    </section>
  {:else}
    <section>
      <h3>{t('vaultManage.current')}</h3>
      <code class="path" title={info.root}>{displayPath(info.root)}</code>
      <div class="actions">
        <button disabled={locked} onclick={() => void run(async () => { await writeText(info!.root!) })}>{t('vaultManage.copy')}</button>
        <button disabled={locked || !info.accessible} onclick={() => void run(async () => { await openPath(info!.root!) })}>{t('vaultManage.reveal')}</button>
        <button disabled={locked} onclick={() => void run(refresh)}>{t('vaultManage.recheck')}</button>
      </div>
      {#if !info.accessible}
        <p class="error" role="alert">{t('vaultManage.unavailable')}{info.error ? `: ${info.error}` : ''}</p>
        <button disabled={locked} onclick={() => advancedOpen = true}>{t('vaultManage.moved')}</button>
      {/if}
    </section>
    <section>
      <h3>{t('vaultManage.gitHeading')}</h3>
      {#if info.git.state === 'unavailable'}<p>{t('vaultManage.gitMissing')}</p>
      {:else if info.git.state === 'none'}
        <p>{t('vaultManage.gitNone')}</p>
        <button disabled={locked || !info.accessible} onclick={() => void requestConfirmation('git')}>{t('vaultManage.initGit')}</button>
      {:else if info.git.state === 'ready'}
        <p>{info.git.hasCommits ? t('vaultManage.gitReady') : t('vaultManage.gitNoCommits')}</p>
        <dl><dt>{t('vaultManage.branch')}</dt><dd>{info.git.branch ?? '—'}</dd></dl>
      {:else}<p class="error">{info.git.error}</p>{/if}
    </section>
    <section>
      <h3>{info.syncEnabled && !info.git.remote ? t('vaultManage.localHistory') : t('vaultManage.syncHeading')}</h3>
      <dl><dt>{t('vaultManage.remote')}</dt><dd>{info.git.remote ?? t('vaultManage.noRemote')}</dd></dl>
      <p role="status">{syncLabel}</p>
      {#if sync?.last_sync}<p>{t('vault.lastSync', { time: sync.last_sync })}</p>{/if}
      {#if sync?.error_message}<p class="error" role="alert">{sync.error_message}</p>{/if}
      {#if !canSync && !info.syncEnabled}<p>{t('vaultManage.gitSetupHint')}</p>{/if}
      <div class="actions">
        {#if info.syncEnabled}<button disabled={locked} onclick={() => void pause()}>{t('vaultManage.pauseSync')}</button>
        {:else}<button disabled={locked || !canSync} onclick={() => void requestConfirmation('sync')}>{t('vaultManage.enableSync')}</button>{/if}
        <button disabled={locked || !info.syncEnabled || sync?.state === 'syncing'} onclick={() => void syncNow()}>{t('vault.syncNow')}</button>
        <button disabled={locked} onclick={() => void run(async () => { await invoke('open_vault_sync_logs') })}>{t('vaultManage.logs')}</button>
      </div>
    </section>
    {@render collection?.()}
    <details bind:open={advancedOpen}>
      <summary>{t('vaultManage.advanced')}</summary>
      <p>{t('vaultManage.changeHint')}</p>
      <button disabled={locked} onclick={() => void chooseLocation()}>{t('vaultManage.change')}</button>
      {@render advanced?.()}
    </details>
  {/if}
  {#if confirmation}
    <div class="confirmation-overlay">
      <div class="confirmation" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="vault-confirm-title"
        use:modalFocus={{ onClose: () => { confirmation = null }, canClose: () => !locked }}>
        <h3 id="vault-confirm-title">{confirmation === 'change' ? t('vaultManage.change') : confirmation === 'git' ? t('vaultManage.initGit') : t('vaultManage.enableSync')}</h3>
        {#if confirmation === 'change'}
          <dl><dt>{t('vaultManage.oldPath')}</dt><dd title={expectedRoot ?? ''}>{displayPath(expectedRoot ?? '')}</dd>
            <dt>{t('vaultManage.newPath')}</dt><dd title={candidate}>{displayPath(candidate)}</dd></dl>
          <p>{t('vaultManage.changeWarning')}</p>
        {:else}
          <code class="path" title={expectedRoot ?? ''}>{displayPath(expectedRoot ?? '')}</code>
          <p>{confirmation === 'git' ? t('vaultManage.initConfirm') : t('vaultManage.syncConfirm')}</p>
          {#if confirmation === 'sync'}<code>{info?.git.remote}</code>{/if}
        {/if}
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <div class="actions">
          <button data-initial-focus bind:this={cancelButton} disabled={locked} onclick={() => { confirmation = null; error = null }}>{t('common.cancel')}</button>
          <button disabled={locked} onclick={() => void confirm()}>{busy ? t('vaultManage.busy') : confirmation === 'change' ? t('vaultManage.confirmChange') : confirmation === 'git' ? t('vaultManage.initialize') : t('vaultManage.enableSync')}</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  section { margin-bottom: 24px; }
  h3 { font-size: 14px; margin: 0 0 10px; }
  p { font-size: 12px; line-height: 1.6; color: var(--ui-secondary); }
  .path { display: block; overflow-wrap: anywhere; user-select: text; padding: 10px 0; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  button { padding: 7px 12px; font: inherit; font-size: 12px; color: CanvasText; background: var(--ui-surface, Canvas); border: 1px solid var(--ui-control-border); border-radius: 6px; cursor: pointer; }
  button:not(:disabled):hover { background: var(--ui-hover); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary { background: var(--ui-accent); color: var(--ui-accent-foreground, white); }
  button.primary:not(:disabled):hover { background: color-mix(in srgb, var(--ui-accent) 88%, black); }
  .error { color: var(--ui-danger); overflow-wrap: anywhere; }
  .feedback { color: var(--ui-success); }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; font-size: 12px; }
  dt { color: var(--ui-secondary); }
  dd { margin: 0; overflow-wrap: anywhere; user-select: text; }
  summary { cursor: pointer; font-size: 13px; font-weight: 600; }
  .confirmation-overlay { position: fixed; inset: 0; z-index: 1500; padding: 24px; display: flex; align-items: center; justify-content: center; background: rgb(0 0 0 / 30%); }
  .confirmation { width: 460px; max-width: 100%; max-height: calc(100vh - 48px); overflow: auto; margin: 0; padding: 24px; border: 1px solid var(--ui-control-border); border-radius: 10px; background: var(--ui-surface, Canvas); color: CanvasText; box-shadow: 0 12px 48px rgb(0 0 0 / 20%); }
</style>
