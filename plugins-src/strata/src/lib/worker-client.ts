import type { Atlas, TerrainInputNode, TerrainRenderOptions, TerrainResult, TerrainSelection, TerrainWorkerRequest, TerrainWorkerResponse } from './types-terrain'

const cancelled = () => new DOMException('地形计算已取消', 'AbortError')

/** Module Worker only: no blob URL, eval, CDN, or CPU-heavy main-thread fallback. */
export class TerrainWorkerClient {
  private worker?: Worker
  private sequence = 0
  private nodes?: TerrainInputNode[]
  private epoch?: string
  private atlas?: Atlas
  private pending?: { reject: (reason: unknown) => void; cleanup: () => void }
  private disposed = false

  constructor(private readonly createWorker: () => Worker = () => new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module', name: 'strata-terrain' })) {}

  build(nodes: TerrainInputNode[], epoch: string, selection: TerrainSelection, options?: TerrainRenderOptions, previousAtlas?: Atlas, signal?: AbortSignal): Promise<TerrainResult> {
    this.nodes = nodes; this.epoch = epoch; this.atlas = previousAtlas
    return this.request('build', selection, options, signal)
  }

  render(selection: TerrainSelection, options?: TerrainRenderOptions, signal?: AbortSignal): Promise<TerrainResult> {
    if (!this.nodes || !this.epoch) return Promise.reject(new Error('请先构建知识地形布局'))
    return this.request(this.worker ? 'render' : 'build', selection, options, signal)
  }

  private request(action: 'build' | 'render', selection: TerrainSelection, options?: TerrainRenderOptions, signal?: AbortSignal): Promise<TerrainResult> {
    if (this.disposed) return Promise.reject(new Error('地形计算器已经关闭'))
    if (signal?.aborted) return Promise.reject(cancelled())
    // Terminating actually interrupts synchronous clustering/contours; a cancel message cannot.
    if (this.pending) { this.cancel(); action = 'build' }
    const id = ++this.sequence
    try { this.worker ||= this.createWorker() } catch (error) { return Promise.reject(error) }
    const worker = this.worker
    return new Promise<TerrainResult>((resolve, reject) => {
      const cleanup = () => { signal?.removeEventListener('abort', abort); if (id === this.sequence) this.pending = undefined }
      const abort = () => { if (id === this.sequence) this.cancel() }
      this.pending = { reject, cleanup }
      signal?.addEventListener('abort', abort, { once: true })
      worker.onerror = event => {
        if (id !== this.sequence) return
        cleanup(); worker.terminate(); this.worker = undefined
        reject(new Error(event.message || '地形 Worker 无法启动，请重新打开插件'))
      }
      worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
        if (id !== this.sequence || event.data.id !== id) return
        cleanup()
        const result = event.data.result
        if (!result) { reject(new Error(event.data.error || '地形计算失败')); return }
        this.atlas = result.layout || this.atlas
        if (!this.atlas) { reject(new Error('地形返回缺少布局')); return }
        resolve({ ...result, layout: this.atlas })
      }
      const request: TerrainWorkerRequest = { id, action, selection, options,
        ...(action === 'build' ? { nodes: this.nodes, epoch: this.epoch, previousAtlas: this.atlas } : {}) }
      try { worker.postMessage(request) } catch (error) {
        cleanup(); worker.terminate(); this.worker = undefined; reject(error)
      }
    })
  }

  cancel(): void {
    const pending = this.pending
    pending?.cleanup(); this.sequence++
    this.worker?.terminate(); this.worker = undefined; this.pending = undefined
    pending?.reject(cancelled())
  }

  dispose(): void { this.cancel(); this.disposed = true; this.nodes = undefined; this.atlas = undefined }
}
