import type { Atlas, Budget, DateRange, Job, Preferences, Providers, Snapshot } from './types'
export interface Bridge { request(method: string, params?: unknown): Promise<unknown> }
declare global { interface Window { notemd?: Bridge } }
export function request<T>(method: string, params: unknown = {}): Promise<T> {
  if (!window.notemd) return Promise.reject(new Error('请从 note.md 的「插件 → 思考 → 打开层峦」进入。'))
  return window.notemd.request(method, params) as Promise<T>
}
export const api = {
  snapshot: (range: DateRange) => request<Snapshot>('plugin.snapshot', range),
  extract: (range: DateRange, harness: string, budget: Budget, includeConfidential: boolean) => request<Job>('plugin.extract', { ...range, harness, budget, includeConfidential }),
  job: () => request<Job | null>('plugin.job'),
  stop: () => request<Job>('plugin.stop'),
  dismissJob: (jobId: string) => request<Job>('plugin.dismiss_job', { jobId }),
  providers: () => request<Providers>('host.agent.providers'),
  settings: () => request<{ settings: { browser?: Partial<Preferences> } }>('host.settings.get'),
  saveSettings: (value: Preferences) => request('host.settings.set', { key: 'browser', value }),
  loadAtlas: (vaultKey: string) => request<{ atlas: Atlas | null }>('plugin.atlas.load', { vaultKey }),
  saveAtlas: (vaultKey: string, atlas: Atlas) => request('plugin.atlas.save', { vaultKey, atlas }),
  indexStatus: (snapshotId: string) => request<{ valid: boolean; freshness: string; reason?: string }>('host.index.status', { version: 1, snapshotId }),
  openSource: async (nodeId: string, range: DateRange, evidenceId?: string) => {
    const target = await request<{ path: string; lineStart?: number; lineEnd?: number }>('plugin.open_source', { nodeId, evidenceId, ...range })
    return request('host.editor.open', { path: target.path })
  },
}
