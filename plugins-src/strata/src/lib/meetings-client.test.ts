import { afterEach, expect, it, vi } from 'vitest'
import { parseMeetingSnapshot } from './meetings-client'
import type { MeetingSnapshotInput } from './meetings'

const input: MeetingSnapshotInput = { schema: 'notemd.strata/meetings/v1', vaultKey: 'v', datasetKey: 'meetings', snapshotId: 's', documents: [], diagnostics: [] }
const range = { from: '2026-09-01', to: '2026-09-30' }
class MockWorker {
  static instances: MockWorker[] = []
  onmessage?: (event: { data: unknown }) => void
  onerror?: (event: { message: string }) => void
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor(readonly url: URL, readonly options: WorkerOptions) { MockWorker.instances.push(this) }
}
afterEach(() => { vi.unstubAllGlobals(); MockWorker.instances = [] })
it('always uses a module Worker and releases it after parsing', async () => {
  vi.stubGlobal('Worker', MockWorker)
  const promise = parseMeetingSnapshot(input, range), worker = MockWorker.instances[0]
  expect(worker.options.type).toBe('module'); expect(worker.url.pathname).toContain('meetings.worker.ts')
  expect(worker.postMessage).toHaveBeenCalledWith({ input, range })
  worker.onmessage?.({ data: { result: { nodes: [] } } })
  await expect(promise).resolves.toEqual({ nodes: [] }); expect(worker.terminate).toHaveBeenCalledOnce()
})
it('terminates parsing on cancellation and does not start an already cancelled request', async () => {
  vi.stubGlobal('Worker', MockWorker)
  const abort = new AbortController(), promise = parseMeetingSnapshot(input, range, abort.signal)
  abort.abort(); await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  expect(MockWorker.instances[0].terminate).toHaveBeenCalledOnce()
  await expect(parseMeetingSnapshot(input, range, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(MockWorker.instances).toHaveLength(1)
})
it('surfaces parser and Worker failures instead of silently showing an empty dataset', async () => {
  vi.stubGlobal('Worker', MockWorker)
  const a = parseMeetingSnapshot(input, range); MockWorker.instances[0].onmessage?.({ data: { error: 'invalid snapshot' } })
  await expect(a).rejects.toThrow('invalid snapshot')
  const b = parseMeetingSnapshot(input, range); MockWorker.instances[1].onerror?.({ message: 'worker failed' })
  await expect(b).rejects.toThrow('worker failed')
  expect(MockWorker.instances.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true)
})
