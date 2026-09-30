import type { DateRange } from './types'
import type { MeetingSnapshot, MeetingSnapshotInput } from './meetings'

/** Always parse the aggregate in one cancellable, same-origin module Worker. */
export function parseMeetingSnapshot(input: MeetingSnapshotInput, range: DateRange, signal?: AbortSignal): Promise<MeetingSnapshot> {
  if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'))
  const worker = new Worker(new URL('./meetings.worker.ts', import.meta.url), { type: 'module', name: 'strata-meetings' })
  return new Promise((resolve, reject) => {
    const cleanup = () => { signal?.removeEventListener('abort', abort); worker.terminate() }
    const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
    worker.onerror = event => { cleanup(); reject(new Error(event.message || '会议知识解析 Worker 失败')) }
    worker.onmessage = (event: MessageEvent<{ result?: MeetingSnapshot; error?: string }>) => {
      cleanup()
      if (event.data.result) resolve(event.data.result)
      else reject(new Error(event.data.error || '会议知识解析失败'))
    }
    try { worker.postMessage({ input, range }) } catch (error) { cleanup(); reject(error) }
  })
}
