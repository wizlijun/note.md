<script lang="ts">
  import { vaultStore, syncNow, configureVault, disconnectVault, refreshStatus, fetchGitHubLogin } from '../lib/vault.svelte'
  import { pushToast } from '../lib/toast.svelte'
  import { ask } from '@tauri-apps/plugin-dialog'
  import { openUrl } from '@tauri-apps/plugin-opener'

  let remoteUrl = $state('')
  let branch = $state('main')
  let pat = $state('')
  let authorName = $state('mdeditor on iOS')
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
      showPatInput = false
      pat = ''
      pushToast({ level: 'success', message: '✓ Vault 已连接，仓库克隆完成' })
    } catch (e) {
      const raw = typeof e === 'string' ? e : String(e)
      saveError = raw
      // Map known error patterns to friendlier Chinese toast text.
      let friendly = `❌ Vault 连接失败：${raw}`
      if (raw.includes('keychain') || raw.includes('plugin:keychain')) {
        friendly = '❌ Vault 连接失败：Keychain 桥未就绪（Swift 端 Keychain.swift 还没加入 Xcode 目标）'
      } else if (raw.includes('auth') || raw.includes('鉴权') || raw.includes('401')) {
        friendly = '❌ Vault 连接失败：PAT 鉴权失败，请确认 token 有 contents:read/write 权限'
      } else if (raw.includes('404') || raw.includes('not found')) {
        friendly = '❌ Vault 连接失败：仓库不存在或 PAT 无访问权'
      } else if (raw.includes('network') || raw.includes('网络')) {
        friendly = '❌ Vault 连接失败：网络错误'
      }
      pushToast({ level: 'error', message: friendly, detail: raw })
    } finally {
      busy = false
    }
  }

  async function onDisconnect() {
    const ok = await ask('断开 Vault 将删除本机 Vault 副本和 Keychain 中的 PAT，远端仓库不受影响。继续？', {
      title: 'Disconnect Vault', kind: 'warning',
    })
    if (!ok) return
    busy = true
    try {
      await disconnectVault()
      pushToast({ level: 'success', message: '✓ 已断开 Vault' })
    } catch (e) {
      pushToast({ level: 'error', message: `❌ 断开失败：${e}`, detail: String(e) })
    } finally {
      busy = false
    }
  }

  function formatLastSync(ms: number | null): string {
    if (!ms) return '从未'
    const diff = Date.now() - ms
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
    return new Date(ms).toLocaleString()
  }

  async function openTokenPage() {
    try { await openUrl('https://github.com/settings/personal-access-tokens/new') } catch {}
  }
</script>

<section class="vault-settings">
  <div class="status-block">
    <div class="status-row">
      <span class="label">Status:</span>
      <span class="state state-{vaultStore.state}">
        {#if vaultStore.state === 'syncing'}同步中…
        {:else if vaultStore.state === 'cloning'}克隆中…
        {:else if vaultStore.state === 'idle'}✓ 上次同步：{formatLastSync(vaultStore.lastSync)}
        {:else if vaultStore.state === 'error'}❌ {vaultStore.errorMsg ?? '未知错误'}
        {:else if vaultStore.state === 'conflict'}⚠️ 有冲突文件
        {:else}未配置
        {/if}
      </span>
    </div>
    {#if vaultStore.configured}
      <div class="actions">
        <button onclick={() => syncNow()} disabled={busy || vaultStore.state === 'syncing'}>
          {vaultStore.state === 'syncing' ? '同步中…' : '立即同步'}
        </button>
        <button class="danger" onclick={onDisconnect} disabled={busy}>断开 Vault</button>
      </div>
    {/if}
  </div>

  <hr />

  <div class="form">
    <label>
      <span>Remote URL</span>
      <input type="text" bind:value={remoteUrl} placeholder="https://github.com/user/repo.git" />
    </label>
    <label>
      <span>Branch</span>
      <input type="text" bind:value={branch} placeholder="main" />
    </label>
    <label class="pat-row">
      <span>Personal Access Token</span>
      {#if !showPatInput && vaultStore.configured}
        <div>
          <span class="badge ok">✓ 已配置</span>
          <button type="button" class="link" onclick={() => (showPatInput = true)}>更新…</button>
        </div>
      {:else}
        <input type="password" bind:value={pat} placeholder="github_pat_..." />
      {/if}
      <button type="button" class="link" onclick={openTokenPage}>📖 如何生成 Token</button>
    </label>
    <label>
      <span>Author Name</span>
      <input type="text" bind:value={authorName} />
    </label>
    <label>
      <span>Author Email</span>
      <input type="text" bind:value={authorEmail} placeholder="user@users.noreply.github.com" />
    </label>
    <button class="primary" onclick={onSave} disabled={busy || !remoteUrl || (!vaultStore.configured && !pat)}>
      {busy ? '保存中…' : '保存配置'}
    </button>
    {#if saveError}
      <p class="error">❌ {saveError}</p>
    {/if}
  </div>

  <hr />

  <p class="note">⚠️ 请勿在 Files App 内修改或删除 Documents/Vault/ 目录，否则同步状态会损坏。</p>
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
