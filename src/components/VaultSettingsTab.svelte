<script lang="ts">
  import { vaultStore, syncNow, configureVault, disconnectVault, refreshStatus, fetchGitHubLogin } from '../lib/vault.svelte'
  import { pushToast } from '../lib/toast.svelte'
  import { ask } from '@tauri-apps/plugin-dialog'
  import { openUrl } from '@tauri-apps/plugin-opener'
  import { t } from '../lib/i18n/store.svelte'

  let remoteUrl = $state('')
  let branch = $state('main')
  let pat = $state('')
  let authorName = $state('note.md on iOS')
  let authorEmail = $state('')
  let busy = $state(false)
  let saveError = $state<string | null>(null)
  let showPatInput = $state(false)

  $effect(() => { refreshStatus() })

  // When the user finishes typing a PAT, try to fetch their GitHub login
  // and auto-fill the noreply email (spec §2.5). Debounced 800ms; only
  // overwrite empty email field, never clobber user-entered value.
  let emailFetchTimer: ReturnType<typeof setTimeout> | null = null
  $effect(() => {
    if (!pat || pat.length < 20) return
    if (emailFetchTimer) clearTimeout(emailFetchTimer)
    emailFetchTimer = setTimeout(async () => {
      if (authorEmail.trim() !== '') return
      const login = await fetchGitHubLogin(pat)
      if (login && authorEmail.trim() === '') {
        authorEmail = `${login}@users.noreply.github.com`
      }
    }, 800)
  })

  async function onSave() {
    saveError = null
    busy = true
    try {
      await configureVault({ remoteUrl, branch, pat, authorName, authorEmail })
      // 配好 vault 后进程内即时生效:刷新前端 vault 状态,分享/徽标等无需重启 app。
      const { refreshSotvault } = await import('../lib/sotvault.svelte')
      await refreshSotvault()
      showPatInput = false
      pat = ''
      pushToast({ level: 'success', message: t('vault.connected') })
    } catch (e) {
      const raw = typeof e === 'string' ? e : String(e)
      saveError = raw
      // Map known error patterns to friendlier toast text.
      let friendly = t('vault.err.generic', { error: raw })
      if (raw.includes('keychain') || raw.includes('plugin:keychain')) {
        friendly = t('vault.err.keychain')
      } else if (raw.includes('auth') || raw.includes('鉴权') || raw.includes('401')) {
        friendly = t('vault.err.authConnect')
      } else if (raw.includes('404') || raw.includes('not found')) {
        friendly = t('vault.err.notFoundConnect')
      } else if (raw.includes('network') || raw.includes('网络')) {
        friendly = t('vault.err.networkConnect')
      }
      pushToast({ level: 'error', message: friendly, detail: raw })
    } finally {
      busy = false
    }
  }

  async function onDisconnect() {
    const ok = await ask(t('vault.disconnectConfirm'), {
      title: t('vault.disconnectTitle'), kind: 'warning',
    })
    if (!ok) return
    busy = true
    try {
      await disconnectVault()
      pushToast({ level: 'success', message: t('vault.disconnected') })
    } catch (e) {
      pushToast({ level: 'error', message: t('vault.disconnectFailed', { error: String(e) }), detail: String(e) })
    } finally {
      busy = false
    }
  }

  function formatLastSync(ms: number | null): string {
    if (!ms) return t('time.never')
    const diff = Date.now() - ms
    if (diff < 60_000) return t('time.justNow')
    if (diff < 3_600_000) return t('time.minutesAgo', { n: Math.round(diff / 60_000) })
    if (diff < 86_400_000) return t('time.hoursAgo', { n: Math.round(diff / 3_600_000) })
    return new Date(ms).toLocaleString()
  }

  async function openTokenPage() {
    try { await openUrl('https://github.com/settings/personal-access-tokens/new') } catch {}
  }
</script>

<section class="vault-settings">
  <div class="status-block">
    <div class="status-row">
      <span class="label">{t('vault.statusLabel')}</span>
      <span class="state state-{vaultStore.state}">
        {#if vaultStore.state === 'syncing'}{t('vault.syncing')}
        {:else if vaultStore.state === 'cloning'}{t('vault.cloning')}
        {:else if vaultStore.state === 'idle'}{t('vault.lastSync', { time: formatLastSync(vaultStore.lastSync) })}
        {:else if vaultStore.state === 'error'}❌ {vaultStore.errorMsg ?? t('vault.unknownError')}
        {:else if vaultStore.state === 'conflict'}{t('vault.hasConflicts')}
        {:else}{t('vault.notConfigured')}
        {/if}
      </span>
    </div>
    {#if vaultStore.configured}
      <div class="actions">
        <button onclick={() => syncNow()} disabled={busy || vaultStore.state === 'syncing'}>
          {vaultStore.state === 'syncing' ? t('vault.syncing') : t('vault.syncNow')}
        </button>
        <button class="danger" onclick={onDisconnect} disabled={busy}>{t('vault.disconnect')}</button>
      </div>
    {/if}
  </div>

  <hr />

  <div class="form">
    <label>
      <span>{t('vault.remoteUrl')}</span>
      <input type="text" bind:value={remoteUrl} placeholder="https://github.com/user/repo.git" />
    </label>
    <label>
      <span>{t('vault.branch')}</span>
      <input type="text" bind:value={branch} placeholder="main" />
    </label>
    <label class="pat-row">
      <span>{t('vault.pat')}</span>
      {#if !showPatInput && vaultStore.configured}
        <div>
          <span class="badge ok">{t('vault.patConfigured')}</span>
          <button type="button" class="link" onclick={() => (showPatInput = true)}>{t('vault.patUpdate')}</button>
        </div>
      {:else}
        <input type="password" bind:value={pat} placeholder="github_pat_..." />
      {/if}
      <button type="button" class="link" onclick={openTokenPage}>{t('vault.howToToken')}</button>
    </label>
    <label>
      <span>{t('vault.authorName')}</span>
      <input type="text" bind:value={authorName} />
    </label>
    <label>
      <span>{t('vault.authorEmail')}</span>
      <input type="text" bind:value={authorEmail} placeholder="user@users.noreply.github.com" />
    </label>
    <button class="primary" onclick={onSave} disabled={busy || !remoteUrl || (!vaultStore.configured && !pat)}>
      {busy ? t('vault.saving') : t('vault.saveConfig')}
    </button>
    {#if saveError}
      <p class="error">❌ {saveError}</p>
    {/if}
  </div>

  <hr />

  <p class="note">{t('vault.filesWarning')}</p>
</section>

<style>
  .vault-settings { padding: 8px 0; }
  .status-block { padding: 12px; background: var(--bg-sub, rgba(0,0,0,0.03)); border-radius: 8px; }
  .status-row { display: flex; gap: 8px; margin-bottom: 8px; }
  .label { font-weight: 500; opacity: 0.7; }
  .state-error { color: var(--danger, #e01b24); }
  .state-conflict { color: var(--warn, #f5c211); }
  .actions { display: flex; gap: 8px; margin-top: 8px; }
  .actions button { padding: 6px 14px; }
  .danger { color: var(--danger, #e01b24); }
  hr { border: 0; border-top: 1px solid rgba(0,0,0,0.08); margin: 16px 0; }
  .form label { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .form label > span { font-size: 13px; opacity: 0.8; }
  .form input { padding: 6px 10px; border: 1px solid rgba(0,0,0,0.1); border-radius: 6px; font: inherit; }
  .badge.ok { color: var(--accent, #2ec27e); }
  .link { background: transparent; border: 0; padding: 0; color: var(--accent, #3584e4); text-decoration: underline; cursor: pointer; font-size: 12px; }
  .primary { padding: 8px 20px; background: var(--accent, #3584e4); color: white; border: 0; border-radius: 6px; font: inherit; cursor: pointer; }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .pat-row > div { display: flex; gap: 8px; align-items: center; }
  .error { color: var(--danger, #e01b24); margin-top: 8px; }
  .note { font-size: 12px; opacity: 0.6; }
</style>
