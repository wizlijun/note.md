import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { anchor, propose, type MergeInput } from '../share-merge'

const workers = vi.hoisted(() => ({ instances: [] as any[] }))
vi.mock('./merge-worker?worker', () => ({ default: class {
  onmessage: any; onerror: any; onmessageerror: any
  messages: any[] = []
  terminate = vi.fn()
  constructor() { workers.instances.push(this) }
  postMessage(value: any) { this.messages.push(value) }
  reply(value: any) { this.onmessage?.({ data: value }) }
} }))
import { createMergeClient } from './merge-client'

const input = (bytes: number): MergeInput => ({ path: 'a.md', base: '', ours: '', theirs: 'a'.repeat(bytes) })
beforeEach(() => { workers.instances.length = 0 })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('merge client', () => {
  it('uses the same kernel through the exact UTF-8 threshold and sends only larger inputs to Worker', async () => {
    const client = createMergeClient()
    for (const bytes of [262143, 262144]) expect(await client.compute(input(bytes))).toEqual(propose(input(bytes)))
    expect(workers.instances).toHaveLength(0)
    const pending = client.compute(input(262145))
    const worker = workers.instances[0]
    expect(worker.messages[0]).toMatchObject({ op: 'proposal', input: input(262145) })
    worker.reply({ id: worker.messages[0].id, proposal: propose(input(262145)) })
    expect(await pending).toEqual(propose(input(262145)))
    client.destroy()
  })

  it('counts Chinese and surrogate input as UTF-8 bytes of each separate input', async () => {
    const client = createMergeClient()
    const p = client.compute({ path: 'a', base: '\ud800', ours: '\udc00', theirs: '中'.repeat(87380) })
    expect(workers.instances).toHaveLength(1)
    client.destroy()
    await expect(p).rejects.toThrow('销毁')
  })

  it('matches out-of-order replies by request ID and rejects only the request with a worker error', async () => {
    const client = createMergeClient()
    const a = client.compute(input(262145)), b = client.compute(input(262146))
    const worker = workers.instances[0]
    const [ma, mb] = worker.messages
    worker.reply({ id: mb.id, proposal: propose(mb.input) })
    worker.reply({ id: ma.id, error: 'kernel failed' })
    await expect(a).rejects.toThrow('kernel failed')
    expect(await b).toEqual(propose(mb.input))
    client.destroy()
  })

  it('always locates annotations in Worker, batches one text and cancels stale batches', async () => {
    const client = createMergeClient()
    const selectors = [{ index: 7, selector: { exact: 'hello' } }, { index: 2, selector: { exact: 'absent' } }]
    const pending = client.locateAnnotations('hello', selectors)
    const worker = workers.instances[0], message = worker.messages[0]
    expect(message).toEqual({ id: expect.any(Number), op: 'anchors', text: 'hello', selectors })
    client.cancelAnnotations()
    await expect(pending).rejects.toThrow('取消')
    expect(worker.messages.at(-1)).toEqual({ op: 'cancel', requestId: message.id })
    worker.reply({ id: message.id, anchors: [] })
    const next = client.locateAnnotations('hello', selectors)
    const m = worker.messages.at(-1)
    worker.reply({ id: m.id, anchors: selectors.map(s => ({ index: s.index, result: anchor('hello', s.selector) })) })
    expect(await next).toEqual([{ index: 7, result: { status: 'exact', start: 0, end: 5 } }, { index: 2, result: { status: 'orphan' } }])
    client.destroy()
  })

  it.each(['onerror', 'onmessageerror'])('rejects pending requests on %s without falling back to the main thread', async event => {
    const client = createMergeClient()
    const pending = client.compute(input(262145))
    const worker = workers.instances[0]
    worker[event]({ message: 'broken worker' })
    await expect(pending).rejects.toThrow()
    expect(worker.terminate).toHaveBeenCalledOnce()
    client.destroy()
    await expect(client.compute(input(1))).rejects.toThrow('销毁')
  })

  it('runs the actual worker kernel and yields between anchors so cancellation can stop the batch', async () => {
    vi.useFakeTimers()
    const messages: any[] = []
    const scope = { onmessage: null as any, postMessage: (m: any) => messages.push(m) }
    vi.stubGlobal('self', scope)
    await import('./merge-worker')
    await scope.onmessage({ data: { id: 1, op: 'proposal', input: { path: 'a', base: '甲。', ours: '甲。', theirs: '乙。' } } })
    expect(messages[0].proposal).toEqual(propose({ path: 'a', base: '甲。', ours: '甲。', theirs: '乙。' }))
    const job = scope.onmessage({ data: { id: 2, op: 'anchors', text: 'hello', selectors: [
      { index: 4, selector: { exact: 'hello' } }, { index: 8, selector: { exact: 'absent' } },
    ] } })
    expect(messages).toHaveLength(1)
    await scope.onmessage({ data: { op: 'cancel', requestId: 2 } })
    await vi.runAllTimersAsync()
    await job
    expect(messages).toHaveLength(1)
    const done = scope.onmessage({ data: { id: 3, op: 'anchors', text: 'hello', selectors: [{ index: 4, selector: { exact: 'hello' } }] } })
    await vi.runAllTimersAsync(); await done
    expect(messages.at(-1)).toEqual({ id: 3, anchors: [{ index: 4, result: anchor('hello', { exact: 'hello' }) }] })
  })
})
