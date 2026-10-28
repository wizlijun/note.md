import type { AgentProviders } from './agent-picker/types'
import { isWebSource } from './kickoff/source'

export interface NotemdBridge {
  pluginId: string
  locale: string
  theme: string
  request(method: string, params?: unknown): Promise<any>
  onMessage(cb: (payload: unknown) => void): void
}

declare global {
  interface Window {
    notemd: NotemdBridge
  }
}

export function bridge(): NotemdBridge {
  const value = window.notemd
  if (!value) throw new Error('window.notemd bridge missing (not running inside a plugin window)')
  return value
}

export interface VaultEntry {
  name: string
  is_dir: boolean
}

export function vaultRead(path: string): Promise<{ content: string }> {
  return bridge().request('host.vault.read', { path })
}

export function vaultWrite(path: string, content: string): Promise<{ ok: true }> {
  return bridge().request('host.vault.write', { path, content })
}

export function vaultRename(from: string, to: string): Promise<{ ok: true }> {
  return bridge().request('host.vault.rename', { from, to })
}

export function vaultRemove(path: string): Promise<{ ok: true }> {
  return bridge().request('host.vault.remove', { path })
}

export function vaultExists(path: string): Promise<{ exists: boolean }> {
  return bridge().request('host.vault.exists', { path })
}

export function vaultList(path: string): Promise<{ entries: VaultEntry[] }> {
  return bridge().request('host.vault.list', { path })
}

export function editorOpen(path: string): Promise<{ ok: true }> {
  return bridge().request('host.editor.open', { path })
}

export async function linkOpen(url: string): Promise<'opened' | 'copied'> {
  if (!isWebSource(url)) throw new Error('Invalid source link')
  try {
    await bridge().request('host.link.open', { url })
    return 'opened'
  } catch (error) {
    // The host bridge preserves JSON-RPC errors as "code: message".
    // Only an absent method identifies an older host; other failures must surface.
    if (!(error instanceof Error) || !/^-32601:/.test(error.message)) throw error
    await bridge().request('host.clipboard.write', { text: url })
    return 'copied'
  }
}

export async function toast(
  level: 'success' | 'info' | 'warn' | 'error',
  message: string,
  detail?: string,
): Promise<void> {
  try {
    await bridge().request('host.toast', { level, message, detail })
  } catch {
    // A toast must never turn a successful state transition into a failure.
  }
}

export interface VaultInfo {
  root: string | null
  author?: string
}

export interface AgentLimits {
  providers: { id: string; max_concurrency: number }[]
}

export interface AgentRunParams {
  task: string
  harness: string
  note_path: string
  prompt: string
  notify: {
    title_ok: string
    title_fail: string
    open_path?: string
    expect_file?: string
  }
}

export function vaultInfo(): Promise<VaultInfo> {
  return bridge().request('host.vault.info')
}

export function agentProviders(): Promise<AgentProviders> {
  return bridge().request('host.agent.providers', {})
}

export function agentLimits(): Promise<AgentLimits> {
  return bridge().request('host.agent.limits', {})
}

export function agentRun(params: AgentRunParams): Promise<{ run_id: string }> {
  return bridge().request('host.agent.run', params)
}

export function agentStatus(task: string, runId: string, harness: string): Promise<unknown> {
  return bridge().request('host.agent.status', { task, run_id: runId, harness })
}
