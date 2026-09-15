import { parseKnowledgeDataset } from './parser'
import type { ParseResult } from './types'

const WORKER_THRESHOLD = 1024 * 1024
let requestId = 0

/** Keep small snapshots fast; move expensive parse/validation/index work off the UI thread. */
export async function parseDatasetAsync(source: string, uri: string, signal?: AbortSignal): Promise<ParseResult> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
  if (new TextEncoder().encode(source).byteLength < WORKER_THRESHOLD || typeof Worker === 'undefined') {
    const result = await parseKnowledgeDataset(source, uri)
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    return result
  }
  const worker = new Worker(new URL('./dataset.worker.ts', import.meta.url), { type: 'module', name: 'knowledge-parser' })
  const id = ++requestId
  return new Promise<ParseResult>((resolve, reject) => {
    const cleanup = () => { signal?.removeEventListener('abort', abort); worker.terminate() }
    const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
    worker.onerror = (event) => { cleanup(); reject(new Error(event.message || 'Knowledge parser worker failed')) }
    worker.onmessage = (event: MessageEvent<{ id: number; result?: ParseResult; error?: string }>) => {
      if (event.data.id !== id) return
      cleanup()
      if (event.data.result) resolve(event.data.result)
      else reject(new Error(event.data.error || 'Knowledge parser worker failed'))
    }
    worker.postMessage({ id, source, uri })
  })
}
