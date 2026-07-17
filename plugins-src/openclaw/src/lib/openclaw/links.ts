// src/lib/openclaw/links.ts — v2 port of the vault-link resolver.
//
// v1's "bound mode" branch called host-app Tauri commands (file_exists /
// vault_sync_now / editor_show_and_open_path) that a standalone plugin window
// does NOT have. MessageBubble.getOpts() always passes `isBoundMode: false`
// (bound-mode UX ships with the P2.9 settings tab, not yet in v2), so only the
// web-mode branch — which asks the backend for the file over the bridge — is
// reachable. The bound-mode branch is kept for parity but errors clearly if
// ever reached, since the host commands it needs are unavailable here.

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
    // Web mode: defer to the backend, which owns the vault link resolution.
    if (!opts.currentSession) throw new Error('no active session')
    await send({ type: 'user.request_file', session: opts.currentSession, path: href })
    return
  }
  // Bound mode needs host-app editor/vault commands the plugin window lacks.
  // Unreachable while getOpts() returns isBoundMode:false (until P2.9).
  state.error = 'opening local vault files is not available in the v2 chat window yet'
}
