import type { Diff, History, Job, Locator, Snapshot, State } from './types'

export interface Bridge { request(method: string, params?: unknown): Promise<unknown> }
declare global { interface Window { notemd?: Bridge } }
export function request<T>(method: string, params: unknown = {}): Promise<T> {
  if (!window.notemd) return Promise.reject(new Error('请从 note.md 的「插件 → 思考 → 打开心城」进入。'))
  return window.notemd.request(method, params) as Promise<T>
}
export const api = {
  state: () => request<State>('plugin.state'),
  generate: (windowDays?: 7 | 30 | 90) => request<Job>('plugin.generate', windowDays ? { windowDays } : {}),
  job: () => request<Job | null>('plugin.job'),
  cancel: () => request<Job | null>('plugin.cancel'),
  retrySave: () => request<{ status: string }>('plugin.retry_save'),
  discardPending: () => request<{ status: string }>('plugin.discard_pending'),
  history: () => request<History>('plugin.history'),
  version: (commit: string) => request<{ snapshot: Snapshot }>('plugin.read_version', { commit }),
  diff: (fromCommit: string, toCommit?: string) => request<Diff>('plugin.diff', { fromCommit, ...(toCommit ? { toCommit } : {}) }),
  open: async (evidenceId: string, commit?: string, preview = false) => {
    const target = await request<{ path: string; locator: Locator }>('plugin.open_source', { evidenceId, ...(commit ? { commit } : {}), ...(preview ? { preview: true } : {}) })
    await request('host.editor.open', { path: target.path })
    return target
  },
}
