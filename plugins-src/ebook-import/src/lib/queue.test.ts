import { describe, it, expect } from 'vitest'
import {
  addPaths,
  assignTopic,
  setReadingReason,
  hasUnclassifiedPending,
  hasPending,
  isRunComplete,
  nextToStart,
  onAiEvent,
  onJobEvent,
  replayPending,
  reserve,
  retryItem,
  stashOrApply,
  type AiEvent,
  type ItemStatus,
  type PendingJobEvent,
  type Queue,
  type QueueItem,
} from './queue'

const empty: Queue = { items: [], activeId: null }

describe('retryItem', () => {
  function failed(): Queue {
    return {
      items: [{
        id: 1, path: '/books/a.pdf', name: 'a.pdf', topicId: 'communication',
        status: 'failed', jobId: 7, error: 'OCR incomplete', cancelled: true,
        stage: 'ocr', page: 19, total: 188, logs: ['page 20 failed'],
        importOptions: { ocr: true, provider: 'wechat' },
      }],
      activeId: null,
    }
  }

  it('requeues the original row with its inputs, cached progress and logs', () => {
    const q = failed()
    const next = retryItem(q, 1)
    expect(next.items).toHaveLength(1)
    expect(next.items[0]).toMatchObject({
      id: 1, path: '/books/a.pdf', topicId: 'communication', status: 'pending',
      page: 19, total: 188, logs: ['page 20 failed'],
      importOptions: { ocr: true, provider: 'wechat' },
    })
    expect(next.items[0].jobId).toBeUndefined()
    expect(next.items[0].error).toBeUndefined()
    expect(next.items[0].cancelled).toBeUndefined()
    expect(next.items[0].stage).toBeUndefined()
    expect(q.items[0].status).toBe('failed')
    expect(onJobEvent(next, 7, { event: 'failed', error: 'late' })).toBe(next)
    expect(retryItem(next, 1)).toBe(next)
  })

  it('leaves finished, active and unknown rows untouched', () => {
    for (const status of ['done', 'running', 'pending'] as const) {
      const q = failed()
      q.items[0].status = status
      expect(retryItem(q, 1)).toBe(q)
    }
    const q = failed()
    expect(retryItem(q, 999)).toBe(q)
  })

  it('does not add a duplicate pending/running path or disturb another active item', () => {
    for (const status of ['pending', 'running'] as const) {
      const q = failed()
      q.items.push({ ...q.items[0], id: 2, status, jobId: 8 })
      q.activeId = status === 'running' ? 2 : null
      expect(retryItem(q, 1)).toBe(q)
    }
    const q = failed()
    q.items.push({ id: 2, path: '/books/b.pdf', name: 'b.pdf', status: 'running', jobId: 8, logs: [] })
    q.activeId = 2
    expect(retryItem(q, 1).activeId).toBe(2)
    expect(nextToStart(retryItem(q, 1))).toBeNull()
  })

  it('records per-item OCR options when the scheduler reserves a job', () => {
    const q = addPaths(empty, ['/a.pdf'], 'communication')
    const options = { ocr: true, provider: 'wechat' as const }
    expect(reserve(q, 1, options).items[0].importOptions).toEqual(options)
  })
})

describe('addPaths', () => {
  it('accepts epub/pdf/docx and filters everything else', () => {
    const q = addPaths(empty, [
      '/books/alice.epub',
      '/books/notes.txt',
      '/books/report.PDF',
      '/books/thesis.docx',
      '/books/image.png',
    ])
    expect(q.items.map((i) => i.path)).toEqual([
      '/books/alice.epub',
      '/books/report.PDF',
      '/books/thesis.docx',
    ])
  })

  it('derives a display name from the path', () => {
    const q = addPaths(empty, ['/a/b/c/alice.epub'])
    expect(q.items[0].name).toBe('alice.epub')
  })

  it('starts every new item pending with empty logs', () => {
    const q = addPaths(empty, ['/a.epub'])
    expect(q.items[0]).toMatchObject({ status: 'pending', logs: [] })
  })

  it('assigns the selected topic to every newly queued book', () => {
    const q = addPaths(empty, ['/a.epub', '/b.pdf'], 'software-engineering')
    expect(q.items.map((i) => i.topicId)).toEqual([
      'software-engineering',
      'software-engineering',
    ])
  })

  it('dedups the same path when an existing item is pending or running', () => {
    const q1 = addPaths(empty, ['/a.epub'])
    const q2 = addPaths(q1, ['/a.epub'])
    expect(q2.items).toHaveLength(1)

    const running: Queue = {
      items: [{ id: 1, path: '/b.epub', name: 'b.epub', status: 'running', logs: [] }],
      activeId: 1,
    }
    const q3 = addPaths(running, ['/b.epub'])
    expect(q3.items).toHaveLength(1)
  })

  it('allows re-adding a path whose previous item already finished', () => {
    const done: Queue = {
      items: [{ id: 1, path: '/a.epub', name: 'a.epub', status: 'done', logs: [], destRel: 'x' }],
      activeId: null,
    }
    const q = addPaths(done, ['/a.epub'])
    expect(q.items).toHaveLength(2)
    expect(q.items[1].status).toBe('pending')
  })

  it('assigns increasing ids across multiple calls', () => {
    const q1 = addPaths(empty, ['/a.epub'])
    const q2 = addPaths(q1, ['/b.epub'])
    expect(q2.items[0].id).not.toBe(q2.items[1].id)
  })

  it('does nothing for an empty path list', () => {
    const q = addPaths(empty, [])
    expect(q).toEqual(empty)
  })
})

describe('topic assignment', () => {
  it('updates one pending row without changing finished books', () => {
    let q = addPaths(empty, ['/a.epub', '/b.epub'], 'business')
    q = assignTopic(q, q.items[0].id, 'software')
    expect(q.items.map((i) => i.topicId)).toEqual(['software', 'business'])

    q = { ...q, items: q.items.map((i) => ({ ...i, status: 'done' as const })) }
    expect(assignTopic(q, q.items[0].id, 'history')).toBe(q)
  })

  it('detects pending rows without a topic', () => {
    const q = addPaths(empty, ['/a.epub'])
    expect(hasUnclassifiedPending(q)).toBe(true)
    expect(hasUnclassifiedPending(assignTopic(q, q.items[0].id, 'business'))).toBe(false)
  })
})

describe('nextToStart', () => {
  it('returns the first pending item when nothing is active', () => {
    const q = addPaths(empty, ['/a.epub', '/b.pdf'])
    const n = nextToStart(q)
    expect(n?.path).toBe('/a.epub')
  })

  it('returns null while an item is active', () => {
    const q = addPaths(empty, ['/a.epub'])
    const active: Queue = { ...q, activeId: q.items[0].id }
    expect(nextToStart(active)).toBeNull()
  })

  it('returns null when there is nothing pending', () => {
    const q: Queue = {
      items: [{ id: 1, path: '/a.epub', name: 'a.epub', status: 'done', logs: [] }],
      activeId: null,
    }
    expect(nextToStart(q)).toBeNull()
  })

  it('finds the next pending item once the active one clears', () => {
    let q = addPaths(empty, ['/a.epub', '/b.epub'])
    const first = q.items[0]
    q = {
      ...q,
      activeId: first.id,
      items: q.items.map((i) => (i.id === first.id ? { ...i, status: 'running', jobId: 42 } : i)),
    }
    expect(nextToStart(q)).toBeNull()

    q = onJobEvent(q, 42, { event: 'done', dest_rel: 'ssot/ebooks/2026-08/a/' })
    expect(q.activeId).toBeNull()
    const n = nextToStart(q)
    expect(n?.path).toBe('/b.epub')
  })
})

describe('reserve', () => {
  it('flips the item to running and sets activeId, without a jobId', () => {
    const q = addPaths(empty, ['/a.epub'])
    const r = reserve(q, q.items[0].id)
    expect(r.activeId).toBe(q.items[0].id)
    expect(r.items[0]).toMatchObject({ status: 'running' })
    expect(r.items[0].jobId).toBeUndefined()
  })

  it('closes the double-schedule race: nextToStart is null immediately after reserve, before any RPC resolves', () => {
    // Simulates two schedule() calls racing across the import_start await:
    // the fix is that reserve() happens synchronously right after
    // nextToStart(), so a second call (still holding the pre-reserve `q`
    // conceptually, but in practice reading the shared state after the
    // first call's synchronous reserve) never gets the same item twice.
    let q = addPaths(empty, ['/a.epub', '/b.epub'])
    const first = nextToStart(q)
    expect(first?.path).toBe('/a.epub')
    q = reserve(q, first!.id)

    // A second, re-entrant schedule() call reads nextToStart on the SAME
    // (already-reserved) queue — it must not see /a.epub again, and must
    // not see /b.epub either (only one item may be active at a time).
    expect(nextToStart(q)).toBeNull()
  })

  it('leaves other items and the rest of the reserved item untouched', () => {
    let q = addPaths(empty, ['/a.epub', '/b.epub'])
    const first = q.items[0]
    q = reserve(q, first.id)
    expect(q.items[1]).toMatchObject({ status: 'pending', path: '/b.epub' })
    expect(q.items[0]).toMatchObject({ path: first.path, name: first.name, logs: [] })
  })
})

describe('onJobEvent', () => {
  function running(): Queue {
    return { items: [{ id: 1, path: '/a.epub', name: 'a.epub', status: 'running', jobId: 7, logs: [] }], activeId: 1 }
  }

  it('appends log lines', () => {
    let q = running()
    q = onJobEvent(q, 7, { event: 'log', line: 'converting…' })
    q = onJobEvent(q, 7, { event: 'log', line: 'done stage 1' })
    expect(q.items[0].logs).toEqual(['converting…', 'done stage 1'])
    expect(q.items[0].status).toBe('running')
  })

  it('records progress (stage/page/total)', () => {
    let q = running()
    q = onJobEvent(q, 7, { event: 'progress', stage: 'ocr', page: 3, total: 10 })
    expect(q.items[0]).toMatchObject({ stage: 'ocr', page: 3, total: 10, status: 'running' })
  })

  it('marks done, writes destRel, and clears activeId', () => {
    let q = running()
    q = onJobEvent(q, 7, { event: 'done', dest_rel: 'ssot/ebooks/2026-08/a/' })
    expect(q.items[0]).toMatchObject({ status: 'done', destRel: 'ssot/ebooks/2026-08/a/' })
    expect(q.activeId).toBeNull()
  })

  it('marks failed, writes the error, and clears activeId', () => {
    let q = running()
    q = onJobEvent(q, 7, { event: 'failed', error: 'calibre not found' })
    expect(q.items[0]).toMatchObject({ status: 'failed', error: 'calibre not found' })
    expect(q.items[0].cancelled).toBeFalsy()
    expect(q.activeId).toBeNull()
  })

  // Design decision: a user-cancelled job arrives as event:"failed",
  // error:"cancelled" (see backend import_cancel). We surface this as
  // status:"failed" + cancelled:true rather than a distinct ItemStatus, so
  // the ItemStatus union stays exactly {pending,running,done,failed} per
  // the task-9 brief, while the UI can still render a neutral "cancelled"
  // badge instead of an error by checking item.cancelled first.
  it('maps error:"cancelled" to a distinguishable cancelled state, not an error', () => {
    let q = running()
    q = onJobEvent(q, 7, { event: 'failed', error: 'cancelled' })
    expect(q.items[0].status).toBe('failed')
    expect(q.items[0].cancelled).toBe(true)
    expect(q.items[0].error).toBeUndefined()
    expect(q.activeId).toBeNull()
  })

  it('ignores events for an unknown job id', () => {
    const q = running()
    const q2 = onJobEvent(q, 999, { event: 'log', line: 'nope' })
    expect(q2).toEqual(q)
  })
})

// Finding 1 (final review): the backend spawns a job's thread before
// answering import_start's RPC, so a fast failure's job push can arrive
// before the UI has folded that job_id into its item. stashOrApply/
// replayPending are the fix: stash such events instead of dropping them,
// then replay once schedule() learns the jobId.
describe('stashOrApply / replayPending', () => {
  function reservedButUnresolved(): Queue {
    // Mirrors reserve()'s output: activeId set, item running, jobId unset.
    const q = addPaths({ items: [], activeId: null }, ['/a.epub'])
    return reserve(q, q.items[0].id)
  }

  it('applies immediately when the job_id already matches an item', () => {
    const q: Queue = {
      items: [{ id: 1, path: '/a.epub', name: 'a.epub', status: 'running', jobId: 7, logs: [] }],
      activeId: 1,
    }
    const pending: PendingJobEvent[] = []
    const result = stashOrApply(q, pending, 7, { event: 'log', line: 'hi' })
    expect(result.applied).toBe(true)
    expect(result.pending).toEqual([])
    expect(result.q.items[0].logs).toEqual(['hi'])
  })

  it('stashes a failed event that arrives before the active item has a jobId, then replay marks it failed and clears activeId', () => {
    let q = reservedButUnresolved()
    let pending: PendingJobEvent[] = []

    // The fast-failure push races ahead of import_start's RPC response.
    const stashResult = stashOrApply(q, pending, 99, { event: 'failed', error: 'calibre not found' })
    expect(stashResult.applied).toBe(false)
    q = stashResult.q
    pending = stashResult.pending
    expect(pending).toEqual([{ jobId: 99, ev: { event: 'failed', error: 'calibre not found' } }])
    // Nothing applied yet — the item is still "running", activeId still set.
    expect(q.items[0].status).toBe('running')
    expect(q.activeId).not.toBeNull()

    // import_start resolves: schedule() folds job_id=99 into the item, then replays.
    const withJobId = { ...q, items: q.items.map((i) => ({ ...i, jobId: 99 })) }
    const replay = replayPending(withJobId, pending, 99)

    expect(replay.pending).toEqual([])
    expect(replay.q.items[0]).toMatchObject({ status: 'failed', error: 'calibre not found' })
    expect(replay.q.activeId).toBeNull()
  })

  it('drops events for a genuinely unknown job id (no active-unresolved item)', () => {
    const q: Queue = {
      items: [{ id: 1, path: '/a.epub', name: 'a.epub', status: 'done', jobId: 7, logs: [] }],
      activeId: null,
    }
    const result = stashOrApply(q, [], 999, { event: 'log', line: 'stale' })
    expect(result.applied).toBe(false)
    expect(result.pending).toEqual([])
    expect(result.q).toEqual(q)
  })
})

describe('run gating (Start button)', () => {
  const item = (id: number, status: ItemStatus): QueueItem => ({
    id,
    path: `/b/${id}.epub`,
    name: `${id}.epub`,
    status,
    logs: [],
  })

  it('hasPending is true only while something still waits to start', () => {
    expect(hasPending({ items: [], activeId: null })).toBe(false)
    expect(hasPending({ items: [item(1, 'pending')], activeId: null })).toBe(true)
    expect(hasPending({ items: [item(1, 'running')], activeId: 1 })).toBe(false)
    expect(hasPending({ items: [item(1, 'done'), item(2, 'failed')], activeId: null })).toBe(false)
  })

  it('a run is not complete while the last item is still in flight', () => {
    // The case that would otherwise re-enable Start mid-run: no pending
    // successors left, but the active item hasn't landed.
    expect(isRunComplete({ items: [item(1, 'running')], activeId: 1 })).toBe(false)
    expect(isRunComplete({ items: [item(1, 'pending')], activeId: null })).toBe(false)
    expect(isRunComplete({ items: [item(1, 'done')], activeId: null })).toBe(true)
    expect(isRunComplete({ items: [], activeId: null })).toBe(true)
  })
})

describe('onAiEvent', () => {
  function doneItem(id: number, jobId: number): Queue {
    let q: Queue = { items: [], activeId: null }
    q = addPaths(q, [`/tmp/book${id}.epub`])
    const item = { ...q.items[0], status: 'done' as const, jobId, destRel: `ssot/ebooks/2026-08/b${id}` }
    return { ...q, items: [item] }
  }

  it('started marks running with timestamps and target', () => {
    const q = onAiEvent(doneItem(1, 7), 7, {
      event: 'started',
      started_at: '2026-08-04T03:00:00Z',
      summary_rel: 'ssot/ebooks/2026-08/b1/2026-08-04-summary.md',
    })
    expect(q.items[0].aiStatus).toBe('running')
    expect(q.items[0].aiStartedAt).toBe('2026-08-04T03:00:00Z')
    expect(q.items[0].aiSummaryRel).toBe('ssot/ebooks/2026-08/b1/2026-08-04-summary.md')
  })

  it('queued then done keeps summary target and clears error', () => {
    let q = onAiEvent(doneItem(1, 7), 7, { event: 'queued' })
    expect(q.items[0].aiStatus).toBe('queued')
    q = onAiEvent(q, 7, { event: 'done', summary_rel: 'x/2026-08-04-summary.md' })
    expect(q.items[0].aiStatus).toBe('done')
    expect(q.items[0].aiSummaryRel).toBe('x/2026-08-04-summary.md')
  })

  it('failed records the error; retry via queued clears it', () => {
    let q = onAiEvent(doneItem(1, 7), 7, { event: 'failed', error: 'run lost' })
    expect(q.items[0].aiStatus).toBe('failed')
    expect(q.items[0].aiError).toBe('run lost')
    q = onAiEvent(q, 7, { event: 'queued' })
    expect(q.items[0].aiStatus).toBe('queued')
    expect(q.items[0].aiError).toBeUndefined()
  })

  it('unknown jobId is a no-op', () => {
    const q = doneItem(1, 7)
    expect(onAiEvent(q, 99, { event: 'started' })).toBe(q)
  })
})


describe('reading reason', () => {
  it('keeps each book independent and freezes its original context through retries', () => {
    const initial = addPaths(empty, ['/books/a.pdf', '/books/b.pdf'], 'communication')
    const first = setReadingReason(initial, 1, '同事推荐：讨论项目时\n希望学会沟通')
    const both = setReadingReason(first, 2, '朋友推荐第二本')
    expect(initial.items[0].readingReason).toBeUndefined()
    expect(both.items.map((item) => item.readingReason)).toEqual([
      '同事推荐：讨论项目时\n希望学会沟通', '朋友推荐第二本',
    ])
    const reserved = reserve(both, 1, { ocr: false, provider: 'wechat' })
    expect(setReadingReason(reserved, 1, 'changed')).toBe(reserved)
    const bound = { ...reserved, items: reserved.items.map((item) => item.id === 1 ? { ...item, jobId: 7 } : item) }
    const failed = onJobEvent(bound, 7, { event: 'failed', error: 'conversion failed' })
    expect(setReadingReason(failed, 1, 'changed')).toBe(failed)
    const retry = retryItem(failed, 1)
    expect(retry.items[0].readingReason).toBe(both.items[0].readingReason)
    expect(setReadingReason(retry, 1, 'changed')).toBe(retry)
    expect(setReadingReason(retry, 2, '仍可编辑').items[1].readingReason).toBe('仍可编辑')
    expect(setReadingReason(retry, 99, 'unknown')).toBe(retry)
  })
})
