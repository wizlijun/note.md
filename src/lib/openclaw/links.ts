// src/lib/openclaw/links.ts
import { invoke } from '@tauri-apps/api/core'
import { send } from './commands'
import { state } from './client.svelte'

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const VAULT_TOKEN = '{{vault}}'

export interface ResolveOpts {
  vaultRoot: string | null
  isBoundMode: boolean
  currentSession: string | null
  autoSync: boolean
}

export function isVaultLink(href: string): boolean {
  if (SCHEME_RE.test(href)) return false
  if (href.startsWith('/')) return false
  if (href.startsWith(VAULT_TOKEN)) return true
  return href.endsWith('.md') || href.includes('/')
}

export async function openVaultLink(href: string, opts: ResolveOpts): Promise<void> {
  if (!opts.isBoundMode) {
    // Web mode: defer to host.
    if (!opts.currentSession) throw new Error('no active session')
    await send({ type: 'user.request_file', session: opts.currentSession, path: href })
    return
  }
  if (!opts.vaultRoot) throw new Error('vault root not configured')

  let rel = href
  if (rel.startsWith(VAULT_TOKEN)) rel = rel.slice(VAULT_TOKEN.length).replace(/^[/]+/, '')
  rel = rel.replace(/^\.\//, '')
  const fullPath = `${opts.vaultRoot.replace(/\/$/, '')}/${rel}`

  let exists = await invoke<boolean>('file_exists', { path: fullPath })
  if (!exists && opts.autoSync) {
    await invoke('vault_sync_now')
    exists = await invoke<boolean>('file_exists', { path: fullPath })
  }
  if (!exists) {
    state.error = `not found in local vault: ${href}`
    return
  }
  await invoke('editor_show_and_open_path', { path: fullPath })
}
