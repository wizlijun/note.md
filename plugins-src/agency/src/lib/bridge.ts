import type { Batch, Job, Providers, Scan, Snapshot } from './types'

interface Bridge { request(method: string, params?: unknown): Promise<unknown> }
declare global { interface Window { notemd: Bridge } }
function request<T>(method: string, params: unknown = {}): Promise<T> {
  if (!window.notemd) return Promise.reject(new Error('请在 note.md 中打开 Agency 插件。'))
  return window.notemd.request(method, params) as Promise<T>
}
export const api = {
  snapshot: (date: string) => request<Snapshot>('plugin.snapshot', { date }),
  scan: (date: string) => request<Scan>('plugin.scan', { date }),
  observe: (date: string, harness: string) => request<Job>('plugin.observe', { date, harness }),
  observeRange: (start_date: string, end_date: string, harness: string) => request<Job>('plugin.observe_range', { start_date, end_date, harness }),
  stopQueue: () => request<Job>('plugin.stop_queue'),
  job: () => request<Job | null>('plugin.job'),
  providers: () => request<Providers>('host.agent.providers'),
  review: (date: string, batch_id: string, episode_id: string, excluded: boolean, note: string) =>
    request<Batch>('plugin.review', { date, batch_id, episode_id, excluded, note }),
  openSource: async (date: string, source_id: string, line: number) => {
    const target = await request<{ path: string; line: number }>('plugin.open_source', { date, source_id, line })
    await request('host.editor.open', { path: target.path })
  },
}
