import { describe, expect, it } from 'vitest'
import { TerrainWorkerClient } from './worker-client'
import type { TerrainResult, TerrainWorkerRequest, TerrainWorkerResponse } from './types-terrain'

class FakeWorker {
  onmessage: ((event: MessageEvent<TerrainWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  requests: TerrainWorkerRequest[] = []
  postMessage(request: TerrainWorkerRequest) { this.requests.push(request) }
  terminate() { this.terminated = true }
}

describe('module worker request lifecycle', () => {
  it('carries current-cohort names through warm renders without changing the cached full atlas', async () => {
    const worker = new FakeWorker(), client = new TerrainWorkerClient(() => worker as unknown as Worker)
    const layout: TerrainResult['layout'] = { version: 'strata-atlas/2', epoch: 'epoch', worldSize: 4096, nodes: [], domains: [], topics: [], idf: {}, diagnostics: { graphEdges: 0, crowdedNodes: 0, rebuildSuggested: false, elapsedMs: 0 } }
    const geometry: Omit<TerrainResult, 'layout'> = { field: new Float32Array(4), grid: { width: 2, height: 2, bounds: { x: 0, y: 0, width: 1, height: 1 } }, contours: [], levels: [], peakAnchors: [], visibleIds: [], masses: new Float32Array(0), stats: { elapsedMs: 0, selectedNodes: 0, totalMass: 0, fieldIntegral: 0, kernelBytes: 0, contourVertices: 0, contoursTruncated: false, unresolvedPeaks: 0 } }
    const first = client.build([], 'epoch', { from: '2026-09-01', to: '2026-09-30' }, { surface: 'meeting' })
    worker.onmessage!(new MessageEvent<TerrainWorkerResponse>('message', { data: { id: worker.requests[0].id, result: { ...geometry, layout, clusterNames: { cluster: '九月代表概念' } } } }))
    expect((await first).clusterNames).toEqual({ cluster: '九月代表概念' })
    const next = client.render({ from: '2026-09-20', to: '2026-09-30' }, { surface: 'meeting' })
    worker.onmessage!(new MessageEvent<TerrainWorkerResponse>('message', { data: { id: worker.requests[1].id, result: { ...geometry, clusterNames: { cluster: '当前代表概念' } } } }))
    const current = await next
    expect(current.clusterNames).toEqual({ cluster: '当前代表概念' })
    expect(current.layout).toBe(layout)
    expect(current.layout).not.toHaveProperty('clusterNames')
    client.dispose()
  })
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
