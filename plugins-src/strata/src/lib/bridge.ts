import type { MeetingSnapshotInput } from './meetings'
import type { Atlas, BrowserSettings, Budget, Dataset, DateRange, Job, Preferences, Providers, Snapshot } from './types'
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
  settings: () => request<{ settings: BrowserSettings }>('host.settings.get'),
  saveSettings: (value: Preferences, datasets?: BrowserSettings['datasets']) => request('host.settings.set', datasets ? { key: 'datasets', value: datasets } : { key: 'browser', value }),
  loadAtlas: (vaultKey: string, dataset: Dataset = 'vault_index') => request<{ atlas: Atlas | null }>(dataset === 'meetings_knowledge' ? 'plugin.meetings.atlas.load' : 'plugin.atlas.load', { vaultKey }),
  saveAtlas: (vaultKey: string, atlas: Atlas, dataset: Dataset = 'vault_index') => request(dataset === 'meetings_knowledge' ? 'plugin.meetings.atlas.save' : 'plugin.atlas.save', { vaultKey, atlas: atlasGeometry(atlas) }),
  meetings: () => request<MeetingSnapshotInput>('plugin.meetings.snapshot'),
  openMeetingSource: async (vaultKey: string, path: string, contentHash: string, sourceId?: string) => {
    const target = await request<{ path: string }>('plugin.meetings.open_source', { vaultKey, path, contentHash, sourceId })
    return request('host.editor.open', { path: target.path })
  },
  indexStatus: (snapshotId: string) => request<{ valid: boolean; freshness: string; reason?: string }>('host.index.status', { version: 1, snapshotId }),
  openSource: async (nodeId: string, range: DateRange, evidenceId?: string) => {
    const target = await request<{ path: string; lineStart?: number; lineEnd?: number }>('plugin.open_source', { nodeId, evidenceId, ...range })
    return request('host.editor.open', { path: target.path })
  },
}

/** Persist layout only; fresh snapshots supply titles, source support and evidence. */
export function atlasGeometry(atlas: Atlas) {
  const clusters = (items: Atlas['domains']) => items.map(({ id, name, parentId, x, y, radius, memberIds }) => ({ id, name, parentId, x, y, radius, memberIds }))
  return {
    version: atlas.version, epoch: atlas.epoch, worldSize: atlas.worldSize,
    nodes: atlas.nodes.map(({ id, x, y, radius, parentTopic, parentDomain, crowded }) => ({ id, x, y, radius, parentTopic, parentDomain, crowded })),
    domains: clusters(atlas.domains), topics: clusters(atlas.topics), idf: atlas.idf,
    diagnostics: atlas.diagnostics,
  }
}
