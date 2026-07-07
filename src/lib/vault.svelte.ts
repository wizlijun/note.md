import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { pushToast } from './toast.svelte'
import { t } from './i18n/store.svelte'

export type VaultState = 'idle' | 'cloning' | 'syncing' | 'error' | 'conflict' | 'not_configured'

interface VaultStatusFromRust {
  state: string
  last_sync: number | null
  error_message: string | null
  has_conflicts: boolean
  configured: boolean
}

export const vaultStore = $state<{
  configured: boolean
  state: VaultState
  lastSync: number | null
  errorMsg: string | null
  hasConflicts: boolean
}>({ configured: false, state: 'not_configured', lastSync: null, errorMsg: null, hasConflicts: false })

const SYNC_COOLDOWN_MS = 30_000

export function _resetForTests() {
  vaultStore.configured = false
  vaultStore.state = 'not_configured'
  vaultStore.lastSync = null
  vaultStore.errorMsg = null
  vaultStore.hasConflicts = false
}

function applyStatus(s: VaultStatusFromRust) {
  vaultStore.configured = s.configured
  vaultStore.state = (s.state as VaultState)
  vaultStore.lastSync = s.last_sync
  vaultStore.errorMsg = s.error_message
  vaultStore.hasConflicts = s.has_conflicts
}

export async function refreshStatus(): Promise<void> {
  try {
    const s = await invoke<VaultStatusFromRust>('vault_status')
    applyStatus(s)
  } catch (e) {
    vaultStore.errorMsg = String(e)
  }
}

async function readPat(): Promise<string | null> {
  try {
    const r = await invoke<{ value: string | null }>('plugin:keychain|get', { account: 'pat' })
    return r.value
  } catch {
    return null
  }
}

export async function syncNow(): Promise<void> {
  if (vaultStore.state === 'idle' && vaultStore.lastSync !== null) {
    if (Date.now() - vaultStore.lastSync < SYNC_COOLDOWN_MS) return
  }
  if (vaultStore.state === 'syncing' || vaultStore.state === 'cloning') return
  if (!vaultStore.configured) return

  const pat = await readPat()
  if (!pat) {
    vaultStore.errorMsg = 'PAT not in Keychain'
    return
  }

  const before = vaultStore.lastSync
  try {
    const s = await invoke<VaultStatusFromRust>('vault_sync_now', { pat })
    applyStatus(s)
    const after = s.last_sync
    if (s.has_conflicts) {
      pushToast({ level: 'warn', message: t('vault.syncedWithConflicts') })
    } else if (after !== before) {
      pushToast({ level: 'success', message: t('vault.syncComplete') })
    }
  } catch (e) {
    const msg = typeof e === 'string' ? e : String(e)
    vaultStore.errorMsg = msg
    vaultStore.state = 'error'
    let friendly = `❌ Vault: ${msg}`
    if (msg.includes('auth') || msg.includes('鉴权')) friendly = t('vault.authFailed')
    else if (msg.includes('network') || msg.includes('网络')) friendly = t('vault.networkError')
    else if (msg.includes('not found') || msg.includes('404')) friendly = t('vault.repoNotFound')
    else if (msg.includes('rebase')) friendly = t('vault.mergeFailed')
    pushToast({ level: msg.includes('rebase') ? 'warn' : 'error', message: friendly, detail: msg })
    throw e
  }
}

export async function configureVault(opts: {
  remoteUrl: string
  branch: string
  pat: string
  authorName: string
  authorEmail: string
}): Promise<void> {
  await invoke('plugin:keychain|set', { account: 'pat', value: opts.pat })

  await invoke('vault_configure', {
    cfg: {
      remote_url: opts.remoteUrl,
      branch: opts.branch,
      pat: opts.pat,
      author_name: opts.authorName,
      author_email: opts.authorEmail,
    },
  })

  try {
    const { documentDir } = await import('@tauri-apps/api/path')
    const docs = await documentDir()
    const vaultPath = `${docs.replace(/\/$/, '')}/Vault`
    await invoke('plugin:keychain|markExcludedFromBackup', { path: vaultPath })
  } catch (e) {
    console.warn('[vault] mark exclude-from-backup failed:', e)
  }

  await refreshStatus()
}

export async function fetchGitHubLogin(pat: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' },
    })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data.login === 'string' ? data.login : null
  } catch {
    return null
  }
}

export async function disconnectVault(): Promise<void> {
  await invoke('plugin:keychain|delete', { account: 'pat' })
  await invoke('vault_disconnect')
  await refreshStatus()
}

let listenerAttached = false
export function attachStatusListener(): void {
  if (listenerAttached) return
  listenerAttached = true
  listen('vault-status-changed', () => { refreshStatus() })
}
