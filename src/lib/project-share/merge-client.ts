import MergeWorker from './merge-worker?worker'
import { propose, type MergeInput, type MergeProposal } from '../share-merge'
import type { IndexedSelector, LocatedAnnotation, MergeWorkerReply, MergeWorkerRequest } from './merge-worker'

export type { IndexedSelector, LocatedAnnotation } from './merge-worker'

export function createMergeClient() {
  let worker: Worker | undefined
  let nextId = 0
  let destroyed = false
  const pending = new Map<number, { op: 'proposal' | 'anchors'; resolve(value: any): void; reject(error: Error): void }>()
  function fail(error: Error) {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    worker?.terminate()
    worker = undefined
  }
  function getWorker() {
    if (!worker) {
      worker = new MergeWorker()
      worker.onmessage = ({ data }: MessageEvent<MergeWorkerReply>) => {
        const request = pending.get(data.id)
        if (!request) return
        pending.delete(data.id)
        if ('error' in data) request.reject(new Error(data.error))
        else if (request.op === 'proposal' && 'proposal' in data) request.resolve(data.proposal)
        else if (request.op === 'anchors' && 'anchors' in data) request.resolve(data.anchors)
        else request.reject(new Error('合并 Worker 返回类型不匹配'))
      }
      worker.onerror = event => fail(new Error(event.message || '合并 Worker 失败'))
      worker.onmessageerror = () => fail(new Error('合并 Worker 消息读取失败'))
    }
    return worker
  }
  function request<T>(input: { op: 'proposal'; input: MergeInput } | { op: 'anchors'; text: string; selectors: IndexedSelector[] }): Promise<T> {
    if (destroyed) return Promise.reject(new Error('合并任务已销毁'))
    const id = ++nextId
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { op: input.op, resolve, reject })
      try { getWorker().postMessage({ id, ...input } satisfies MergeWorkerRequest) }
      catch (error) { pending.delete(id); reject(error) }
    })
  }
  return {
    async compute(input: MergeInput): Promise<MergeProposal> {
      if (destroyed) throw new Error('合并任务已销毁')
      const encoder = new TextEncoder()
      const bytes = encoder.encode(input.base).byteLength + encoder.encode(input.ours).byteLength + encoder.encode(input.theirs).byteLength
      return bytes <= 256 * 1024 ? propose(input) : request({ op: 'proposal', input })
    },
    locateAnnotations(text: string, selectors: IndexedSelector[]): Promise<LocatedAnnotation[]> {
      return request({ op: 'anchors', text, selectors })
    },
    cancelAnnotations() {
      for (const [id, request] of pending) {
        if (request.op !== 'anchors') continue
        pending.delete(id)
        request.reject(new Error('批注定位已取消'))
        try { worker?.postMessage({ op: 'cancel', requestId: id } satisfies MergeWorkerRequest) }
        catch (error) { fail(new Error(String(error))) }
      }
    },
    destroy() { destroyed = true; fail(new Error('合并任务已销毁')) },
  }
}
