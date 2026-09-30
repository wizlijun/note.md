import { describe, expect, it } from 'vitest'
import { TerrainWorkerClient } from './worker-client'
import type { TerrainWorkerRequest, TerrainWorkerResponse } from './types-terrain'

class FakeWorker {
  onmessage: ((event: MessageEvent<TerrainWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  requests: TerrainWorkerRequest[] = []
  postMessage(request: TerrainWorkerRequest) { this.requests.push(request) }
  terminate() { this.terminated = true }
}

describe('module worker request lifecycle', () => {
  it('terminates superseded CPU work, rejects cancellation, and ignores stale responses', async () => {
    const workers: FakeWorker[] = [], client = new TerrainWorkerClient(() => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker })
    const first = client.build([], 'epoch', { from: '2026-09-01', to: '2026-09-30' })
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const second = client.render({ from: '2026-09-02', to: '2026-09-30' })
    await rejected
    expect(workers[0].terminated).toBe(true)
    expect(workers[1].requests[0].action).toBe('build')
    const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' })
    client.dispose(); await secondRejected
    expect(workers[1].terminated).toBe(true)
  })

  it('aborts synchronously running worker jobs and never falls back onto the UI thread', async () => {
    const worker = new FakeWorker(), client = new TerrainWorkerClient(() => worker as unknown as Worker), controller = new AbortController()
    const promise = client.build([], 'epoch', { from: '2026-09-01', to: '2026-09-30' }, undefined, undefined, controller.signal)
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await rejected
    expect(worker.terminated).toBe(true)
    const unavailable = new TerrainWorkerClient(() => { throw new Error('CSP blocked Worker') })
    await expect(unavailable.build([], 'epoch', { from: '2026-09-01', to: '2026-09-30' })).rejects.toThrow('CSP blocked Worker')
  })
})
