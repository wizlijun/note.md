import { afterEach, expect, it, vi } from 'vitest'
import { anchor, propose, sha256Hex, type MergeProposal } from '../share-merge'
import type { LocalFeedback } from './types'
import type { IndexedSelector } from './merge-client'
import { createProjectReview, type ReviewDependencies } from './review.svelte'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function feedback(id = 'one', base = '甲。乙。丙。', theirs = '甲。乙改。丙。'): LocalFeedback {
  return { envelope: { payload: { schemaVersion: 1, project_id: 'p', snapshotId: 'old-S1', submissionId: id,
    edits: [{ path: 'a.md', baseHash: 'base', afterMarkdown: theirs }], annotations: [], name: '访客' }, requestHash: 'r', receivedAt: 'now' },
  status: 'pending', decisions: {}, review: {}, annotation_decisions: {} }
}
function fixture(f = feedback(), base = '甲。乙。丙。') {
  let current = base, latest = f
  const calls: { op: string; args: any }[] = []
  const deps: ReviewDependencies = {
    command: vi.fn(async (op, args: any) => {
      calls.push({ op, args })
      if (op === 'review') return { path: args.path, sourcePath: '/trusted/a.md', base, current,
        after: latest.envelope.payload.edits.find(e => e.path === args.path)?.afterMarkdown ?? base,
        currentHash: await sha256Hex(current), status: latest.decisions[args.path]?.status ?? 'pending' } as any
      if (op === 'review-save') latest = { ...latest, review: { ...latest.review, [args.path]: args.draft } }
      if (op === 'apply') {
        current = args.content
        latest = { ...latest, status: 'accepted', decisions: { ...latest.decisions, [args.path]: { status: 'accepted', resultHash: await sha256Hex(current), hunkSummary: args.summary } }, review: {} }
      }
      if (op === 'annotation-decide') latest = { ...latest, annotation_decisions: { ...latest.annotation_decisions, [args.index]: args.value } }
      if (op === 'reject') latest = { ...latest, status: 'rejected', decisions: { ...latest.decisions, [args.path]: { status: 'rejected' } } }
      if (op === 'resolve') latest = { ...latest, status: 'resolved' }
      return latest as any
    }),
    prepareSource: vi.fn(async () => {}), refreshSource: vi.fn(async () => {}),
    confirmWrite: vi.fn(async () => true), compute: vi.fn(async input => propose(input)),
    locateAnnotations: vi.fn(async (text: string, selectors: IndexedSelector[]) => selectors.map(({ index, selector }) => ({ index, result: anchor(text, selector) }))),
    cancelAnnotations: vi.fn(), dispose: vi.fn(), onUpdated: vi.fn(),
  }
  return { f, deps, calls, session: createProjectReview('p', deps), setCurrent: (text: string) => { current = text },
    setFeedback: (value: LocalFeedback) => { latest = value }, get current() { return current } }
}
afterEach(() => vi.useRealTimers())

it('opens the declared old baseline, saves the trusted source first and debounces snake_case drafts for 500ms', async () => {
  vi.useFakeTimers()
  const h = fixture()
  h.deps.prepareSource = vi.fn(async path => { expect(path).toBe('/trusted/a.md'); h.setCurrent('甲新。乙。丙。') })
  await h.session.open(h.f, 'a.md')
  expect(h.calls.map(c => c.op)).toEqual(['review', 'review'])
  expect(h.session.proposal?.baseHash).toBe(await sha256Hex('甲。乙。丙。'))
  expect(h.session.file?.current).toBe('甲新。乙。丙。')
  const id = h.session.proposal!.hunks.find(h => h.kind === 'theirs-only')!.id
  h.session.decide(id, { kind: 'theirs-only', choice: 'accept' })
  await vi.advanceTimersByTimeAsync(499)
  expect(h.calls.filter(c => c.op === 'review-save')).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(h.calls.at(-1)?.args.draft).toMatchObject({ kernel_version: 1, ours_hash: h.session.file!.currentHash, hunks: { [id]: { kind: 'theirs-only', choice: 'accept' } } })
  expect(h.session.dirty).toBe(false)
  await h.session.destroy()
})

it('preserves owner changes, rejects pure refusals without apply and reads new current for the next submission', async () => {
  const h = fixture()
  h.setCurrent('甲新。乙。丙。')
  await h.session.open(h.f, 'a.md'); h.session.acceptAll(); await h.session.writeFile()
  expect(h.current).toBe('甲新。乙改。丙。')
  expect(h.calls.find(c => c.op === 'apply')?.args.summary).toEqual({ accepted: 1, total: 1 })
  const second = feedback('two', undefined, '甲。乙改。丙新。'); h.setFeedback(second)
  await h.session.open(second, 'a.md')
  expect(h.session.file!.current).toBe('甲新。乙改。丙。')
  for (const hunk of h.session.proposal!.hunks) {
    if (hunk.kind === 'theirs-only') h.session.decide(hunk.id, { kind: 'theirs-only', choice: 'reject' })
    if (hunk.kind === 'conflict') h.session.decide(hunk.id, { kind: 'conflict', choice: 'ours' })
  }
  await h.session.writeFile()
  expect(h.calls.filter(c => c.op === 'apply')).toHaveLength(1)
  expect(h.calls.at(-1)?.op).toBe('reject')
  await h.session.destroy()
})

it('blocks unresolved conflicts, preserves decisions when confirmation is cancelled and locks navigation during writes', async () => {
  const h = fixture(feedback('one', undefined, '乙。'), '甲。'); h.setCurrent('丙。')
  await h.session.open(h.f, 'a.md'); await h.session.writeFile()
  expect(h.deps.confirmWrite).not.toHaveBeenCalled()
  const id = h.session.proposal!.hunks[0].id
  h.session.decide(id, { kind: 'conflict', choice: 'edited', text: '结果。' })
  const confirmation = deferred<boolean>(); h.deps.confirmWrite = vi.fn(() => confirmation.promise)
  const writing = h.session.writeFile()
  await vi.waitFor(() => expect(h.deps.confirmWrite).toHaveBeenCalled())
  await expect(h.session.open(feedback('two'), 'a.md')).rejects.toThrow('写回')
  h.session.decide(id, { kind: 'conflict', choice: 'ours' })
  confirmation.resolve(false); await writing
  expect(h.session.decisions[id]).toMatchObject({ choice: 'edited' })
  expect(h.calls.filter(c => c.op === 'apply')).toHaveLength(0)
  await h.session.destroy()
})

it('refreshes once after CAS failure without retrying apply', async () => {
  const h = fixture(); const original = h.deps.command
  h.deps.command = async (op, args) => {
    if (op === 'apply') { h.calls.push({ op, args }); h.setCurrent('新原件。'); throw new Error('source changed; review again') }
    return original(op, args)
  }
  await h.session.open(h.f, 'a.md'); h.session.acceptAll(); await h.session.writeFile()
  expect(h.calls.filter(c => c.op === 'apply')).toHaveLength(1)
  expect(h.calls.at(-1)?.op).toBe('review')
  expect(h.session.notice).toContain('原件已变化')
  expect(h.session.staleDecisions).toBeGreaterThan(0)
  await h.session.destroy()
})

it('strictly filters opaque decisions and invalidates kernel versions and changed hunk kinds', async () => {
  const h = fixture(), proposal = propose({ path: 'a.md', base: '甲。乙。丙。', ours: '甲。乙。丙。', theirs: '甲。乙改。丙。' })
  const id = proposal.hunks[0].id
  for (const value of [{ kind: 'theirs-only', choice: 'unsafe' }, { kind: 'conflict', choice: 'theirs' }, { kind: 'conflict', choice: 'edited', text: 2 },
    { kind: 'conflict', choice: ['theirs'] }, { kind: 'conflict', choice: 'edited', text: 'unsafe', source: 'unknown' }]) {
    h.f.review = { 'a.md': { kernel_version: 1, ours_hash: proposal.oursHash, hunks: { [id]: value }, updated_at: 'now' } }
    await h.session.open(h.f, 'a.md')
    expect(h.session.decisions).toEqual({}); expect(h.session.staleDecisions).toBe(1)
  }
  h.f.review!['a.md'] = { kernel_version: 2, ours_hash: proposal.oursHash, hunks: { [id]: { kind: 'theirs-only', choice: 'accept' } }, updated_at: 'now' }
  await h.session.open(h.f, 'a.md'); expect(h.session.decisions).toEqual({}); expect(h.session.notice).toContain('规则已更新')
  await h.session.destroy()
})

it('does not coerce opaque conflict choices into valid string choices', async () => {
  const h = fixture(feedback('one', undefined, '乙。'), '甲。'); h.setCurrent('丙。')
  const p = propose({ path: 'a.md', base: '甲。', ours: '丙。', theirs: '乙。' })
  h.f.review = { 'a.md': { kernel_version: 1, ours_hash: p.oursHash, hunks: { [p.hunks[0].id]: { kind: 'conflict', choice: ['theirs'] } }, updated_at: 'now' } }
  await h.session.open(h.f, 'a.md')
  expect(h.session.decisions).toEqual({})
  expect(h.session.result!.pendingConflicts).toHaveLength(1)
  await h.session.destroy()
})

it('rechecks the writing lock after an awaited navigation flush', async () => {
  const h = fixture(); await h.session.open(h.f, 'a.md'); h.session.acceptAll()
  const original = h.deps.command, gate = deferred<LocalFeedback>(); let saveStarted = false
  h.deps.command = async (op, args) => {
    if (op === 'review-save' && !saveStarted) { saveStarted = true; return gate.promise as any }
    return original(op, args)
  }
  const saving = h.session.flush()
  await vi.waitFor(() => expect(saveStarted).toBe(true))
  const opening = h.session.open(feedback('next'), 'a.md')
  const blocked = expect(opening).rejects.toThrow('写回')
  const writing = h.session.writeFile()
  gate.resolve(h.f)
  await saving; await blocked; await writing
  expect(h.session.feedback!.envelope.payload.submissionId).toBe('one')
  expect(h.calls.filter(c => c.op === 'apply')).toHaveLength(1)
  await h.session.destroy()
})

it('flushes on file/project departure and destroy, retaining unsaved decisions on save failure', async () => {
  const h = fixture(); await h.session.open(h.f, 'a.md'); h.session.acceptAll()
  const original = h.deps.command; let fail = true
  h.deps.command = async (op, args) => { if (op === 'review-save' && fail) throw new Error('disk full'); return original(op, args) }
  await expect(h.session.destroy()).rejects.toThrow('disk full')
  expect(h.session.dirty).toBe(true); expect(h.session.phase).not.toBe('destroyed')
  fail = false; await h.session.destroy()
  expect(h.session.dirty).toBe(false); expect(h.deps.dispose).toHaveBeenCalledOnce()
})

it('does not lose a decision made during saving and cannot resurrect a draft after apply', async () => {
  const h = fixture(); await h.session.open(h.f, 'a.md'); h.session.acceptAll()
  const original = h.deps.command, gate = deferred<LocalFeedback>(); let wait = true
  h.deps.command = async (op, args) => { if (op === 'review-save' && wait) { wait = false; return gate.promise as any }; return original(op, args) }
  const saving = h.session.flush()
  await vi.waitFor(() => expect(wait).toBe(false))
  const id = h.session.proposal!.hunks[0].id
  h.session.decide(id, { kind: 'theirs-only', choice: 'reject' }); gate.resolve(h.f); await saving
  expect(h.calls.at(-1)?.args.draft.hunks[id].choice).toBe('reject')
  h.session.acceptAll(); await h.session.writeFile(); await h.session.flush()
  expect(h.calls.findLastIndex(c => c.op === 'review-save')).toBeLessThan(h.calls.findIndex(c => c.op === 'apply'))
  await h.session.destroy()
})

it('ignores obsolete compute and annotation batches while retaining usable state on locator failure', async () => {
  const h = fixture(), first = deferred<MergeProposal>(); let started = false
  h.deps.compute = vi.fn(async input => { if (!started) { started = true; return first.promise }; return propose(input) })
  const opening = h.session.open(h.f, 'a.md')
  await vi.waitFor(() => expect(started).toBe(true))
  const next = feedback('next'); h.setFeedback(next); await h.session.open(next, 'a.md')
  first.resolve(propose({ path: 'obsolete', base: '', ours: '', theirs: '' })); await opening
  expect(h.session.proposal!.path).toBe('a.md'); expect(h.session.feedback!.envelope.payload.submissionId).toBe('next')
  next.envelope.payload.annotations = [{ path: 'a.md', quote: '乙', comment: 'note' }]
  h.deps.locateAnnotations = vi.fn(async () => { throw new Error('worker unavailable') })
  await h.session.open(next, 'a.md')
  expect(h.session.error).toContain('定位'); expect(h.session.annotations[0].canPromote).toBe(false)
  await h.session.dismissAnnotation(0)
  expect(h.session.feedback!.annotation_decisions!['0']).toBe('dismissed')
  await h.session.destroy()
})

it('promotes annotations only after compose, sanitizes names/comments and retries only state after apply', async () => {
  const h = fixture(); h.f.envelope.payload.name = '名字<<}\n'
  h.f.envelope.payload.annotations = [{ path: 'a.md', quote: '乙', comment: '评论<<}\n' }]
  await h.session.open(h.f, 'a.md'); h.session.acceptAll()
  h.session.stageAnnotation(0)
  const original = h.deps.command; let fail = true
  h.deps.command = async (op, args) => { if (op === 'annotation-decide' && fail) throw new Error('state save failed'); return original(op, args) }
  await h.session.writeFile()
  expect(h.current).toBe('甲。{==乙==}{>>名字< <} ：评论< <} <<}改。丙。')
  expect(h.deps.confirmWrite).toHaveBeenCalledWith(expect.objectContaining({ current: '甲。乙。丙。', result: h.current }))
  expect(h.session.error).toContain('state save failed')
  fail = false; await h.session.writeFile()
  expect(h.calls.filter(c => c.op === 'apply')).toHaveLength(1)
  expect(h.session.feedback!.annotation_decisions!['0']).toBe('promoted')
  await h.session.destroy()
})

it('handles annotation-only files, caches current anchors and inserts overlapping owner notes as point comments', async () => {
  const base = '{==甲==}{>>主人<<}。乙。'
  const h = fixture(feedback(), base); h.f.envelope.payload.edits = []
  h.f.envelope.payload.annotations = [{ path: 'a.md', quote: '甲', comment: 'guest' }, { path: 'a.md', quote: '乙', comment: 'later' }]
  await h.session.open(h.f, 'a.md')
  const locates = vi.mocked(h.deps.locateAnnotations).mock.calls.length
  h.session.acceptAll(); h.session.stageAnnotation(0); h.session.stageAnnotation(1)
  expect(h.deps.locateAnnotations).toHaveBeenCalledTimes(locates)
  await h.session.writeFile()
  expect(h.current).toBe('{==甲==}{>>主人<<}{>>访客：guest<<}。{==乙==}{>>访客：later<<}。')
  expect(h.calls.filter(c => c.op === 'apply')).toHaveLength(1)
  expect(h.calls.filter(c => c.op === 'review-save')).toHaveLength(0)
  await h.session.resolve(); expect(h.calls.at(-1)?.op).toBe('resolve')
  await h.session.destroy()
})

it.each(['accepted', 'mirror_pending', 'rejected', 'recovery_conflict'])('never applies or promotes terminal %s files', async status => {
  const h = fixture(); h.f.decisions['a.md'] = { status }
  h.f.envelope.payload.annotations = [{ path: 'a.md', quote: '乙', comment: 'note' }]
  await h.session.open(h.f, 'a.md'); h.session.acceptAll(); h.session.stageAnnotation(0); await h.session.writeFile()
  expect(h.calls.filter(c => c.op === 'apply')).toHaveLength(0)
  expect(h.session.annotations[0].canPromote).toBe(false)
  await h.session.destroy()
})

it('blocks trust frontmatter and orphan promotion but allows ignoring, copying and rejecting an unavailable target', async () => {
  const base = '---\nverified: true\n---\n正文。'
  const h = fixture(feedback(), base); h.f.envelope.payload.edits = []
  h.f.envelope.payload.annotations = [{ path: 'a.md', quote: 'true', comment: 'trust' }, { path: 'a.md', quote: 'absent', comment: 'orphan' }]
  await h.session.open(h.f, 'a.md')
  expect(h.session.annotations.every(a => !a.canPromote)).toBe(true)
  h.session.stageAnnotation(0); h.session.stageAnnotation(1); await h.session.dismissAnnotation(1)
  expect(h.session.annotations[1].decision).toBe('dismissed')
  const missing = fixture(); missing.deps.command = vi.fn(async (op, args) => { if (op === 'review') throw new Error('file outside baseline'); missing.calls.push({ op, args }); return missing.f as any })
  await missing.session.open(missing.f, 'a.md')
  expect(missing.session.canWrite).toBe(false); expect(missing.session.canReject).toBe(true)
  await missing.session.rejectFile(); expect(missing.calls.at(-1)?.op).toBe('reject')
  await h.session.destroy(); await missing.session.destroy()
})

it('preserves same-offset point annotation order and wraps overlapping visitor selections only once', async () => {
  const h = fixture(feedback(), '甲。'); h.f.envelope.payload.edits = []
  h.f.envelope.payload.annotations = [
    { path: 'a.md', quote: '', start: 0, end: 0, comment: 'first point' },
    { path: 'a.md', quote: '', start: 0, end: 0, comment: 'second point' },
    { path: 'a.md', quote: '甲', comment: 'first quote' },
    { path: 'a.md', quote: '甲', comment: 'second quote' },
  ]
  await h.session.open(h.f, 'a.md')
  for (const index of [3, 1, 2, 0]) h.session.stageAnnotation(index)
  await h.session.writeFile()
  expect(h.current).toBe('{>>访客：first point<<}{>>访客：second point<<}{==甲==}{>>访客：first quote<<}{>>访客：second quote<<}。')
  expect(h.calls.filter(c => c.op === 'apply')).toHaveLength(1)
  await h.session.destroy()
})

it('reanchors staged selections after composing shifted text and blocks an annotation removed by the selected edit', async () => {
  const h = fixture(feedback('one', undefined, '甲长长。乙。丙。'))
  h.f.envelope.payload.annotations = [{ path: 'a.md', quote: '丙', start: 4, end: 5, comment: 'last' }]
  await h.session.open(h.f, 'a.md'); h.session.stageAnnotation(0); h.session.acceptAll(); await h.session.writeFile()
  expect(h.current).toBe('甲长长。乙。{==丙==}{>>访客：last<<}。')
  const removed = fixture(feedback('remove', undefined, '甲。乙改。丙。'))
  removed.f.envelope.payload.annotations = [{ path: 'a.md', quote: '乙。', comment: 'gone' }]
  await removed.session.open(removed.f, 'a.md'); removed.session.stageAnnotation(0); removed.session.acceptAll(); await removed.session.writeFile()
  expect(removed.calls.filter(c => c.op === 'apply')).toHaveLength(0)
  expect(removed.session.error).toContain('定位')
  expect(removed.session.annotations[0].staged).toBe(true)
  await h.session.destroy(); await removed.session.destroy()
})

it('cannot overwrite promoted state by dismissing and cannot replay apply after a refresh failure', async () => {
  const h = fixture(); h.f.envelope.payload.annotations = [{ path: 'a.md', quote: '丙', comment: 'note' }]
  h.deps.refreshSource = vi.fn(async () => { throw new Error('refresh failed') })
  await h.session.open(h.f, 'a.md'); h.session.stageAnnotation(0); h.session.acceptAll(); await h.session.writeFile()
  expect(h.session.error).toContain('refresh failed')
  await h.session.dismissAnnotation(0); await h.session.writeFile()
  expect(h.calls.filter(c => c.op === 'apply')).toHaveLength(1)
  expect(h.session.feedback!.annotation_decisions!['0']).toBe('promoted')
  await h.session.destroy()
})

it('flushes decisions before opening a new file and keeps pending counts in the full confirmation input', async () => {
  const h = fixture(); h.f.envelope.payload.annotations = [{ path: 'a.md', quote: '丙', comment: 'pending' }]
  await h.session.open(h.f, 'a.md'); h.session.acceptAll()
  const next = feedback('next'); h.setFeedback(next)
  await h.session.open(next, 'a.md')
  expect(h.calls.findIndex(c => c.op === 'review-save')).toBeLessThan(h.calls.findLastIndex(c => c.op === 'review'))
  h.setFeedback(h.f); await h.session.open(h.f, 'a.md'); await h.session.writeFile()
  expect(h.deps.confirmWrite).toHaveBeenLastCalledWith({ path: 'a.md', current: '甲。乙。丙。', result: '甲。乙。丙。', pendingTheirs: 1, pendingAnnotations: 1 })
  await h.session.destroy()
})

it('records already included visitor changes as accepted with zero pending hunks, rather than falsely rejecting V5', async () => {
  const h = fixture(); h.setCurrent('甲。乙改。丙。')
  await h.session.open(h.f, 'a.md')
  expect(h.session.proposal!.hunks.some(hunk => hunk.kind === 'both-same')).toBe(true)
  await h.session.writeFile()
  expect(h.calls.filter(c => c.op === 'reject')).toHaveLength(0)
  expect(h.calls.find(c => c.op === 'apply')?.args).toMatchObject({ content: '甲。乙改。丙。', summary: { accepted: 0, total: 0 } })
  expect(h.session.feedback!.decisions['a.md'].status).toBe('accepted')
  await h.session.destroy()
})

it('keeps points and nested selections inside a visitor highlight outside its generated markup', async () => {
  const h = fixture(feedback(), 'ABCDE'); h.f.envelope.payload.edits = []
  h.f.envelope.payload.annotations = [
    { path: 'a.md', quote: 'ABCDE', comment: 'whole' },
    { path: 'a.md', quote: 'BC', comment: 'inside' },
    { path: 'a.md', quote: '', start: 2, end: 2, comment: 'point' },
  ]
  await h.session.open(h.f, 'a.md'); [0, 1, 2].forEach(index => h.session.stageAnnotation(index)); await h.session.writeFile()
  expect(h.current).toBe('{==ABCDE==}{>>访客：whole<<}{>>访客：inside<<}{>>访客：point<<}')
  await h.session.destroy()
})

it.each(['destroy', 'open', 'switch-project'] as const)('drains decisions made while %s awaits annotation persistence', async leave => {
  const h = fixture()
  h.f.envelope.payload.annotations = [{ path: 'a.md', quote: '丙', comment: 'note' }]
  await h.session.open(h.f, 'a.md')
  const original = h.deps.command, annotationGate = deferred<void>(), draftGate = deferred<void>()
  let annotationStarted = false, draftStarted = false, left = false
  h.deps.command = async (op, args) => {
    if (op === 'annotation-decide') { annotationStarted = true; await annotationGate.promise }
    if (op === 'review-save') { draftStarted = true; await draftGate.promise }
    return original(op, args)
  }
  const dismissing = h.session.dismissAnnotation(0)
  await vi.waitFor(() => expect(annotationStarted).toBe(true))
  const leaving = (async () => {
    if (leave === 'open') await h.session.open(feedback('next'), 'a.md')
    else await h.session.destroy()
    left = true
  })()
  // The annotation IPC is outstanding; edits are still allowed in the old session.
  const id = h.session.proposal!.hunks.find(hunk => hunk.kind === 'theirs-only')!.id
  h.session.decide(id, { kind: 'theirs-only', choice: 'accept' })
  annotationGate.resolve(); await dismissing
  await vi.waitFor(() => expect(draftStarted).toBe(true))
  expect(left).toBe(false)
  expect(h.session.feedback!.envelope.payload.submissionId).toBe('one')
  draftGate.resolve(); await leaving
  const saves = h.calls.filter(call => call.op === 'review-save')
  expect(saves).toHaveLength(1)
  expect(saves[0].args).toMatchObject({ project_id: 'p', submissionId: 'one', path: 'a.md', draft: { hunks: { [id]: { kind: 'theirs-only', choice: 'accept' } } } })
  expect(h.session.dirty).toBe(false)
  if (leave === 'open') {
    expect(h.session.feedback!.envelope.payload.submissionId).toBe('next')
    await h.session.destroy()
  } else {
    expect(h.session.phase).toBe('destroyed')
    if (leave === 'switch-project') {
      const next = createProjectReview('next-project', h.deps)
      expect(next.phase).toBe('idle')
      await next.destroy()
    }
  }
})

it('integrates an S1 suggestion with owner edits, persisted decisions and a promoted annotation in one apply', async () => {
  const base = '甲。\n\n乙。\n\n丙。\n'
  const h = fixture(feedback('one', base, base.replace('乙。', '乙改。')), base)
  h.setCurrent(base.replace('甲。', '甲改。'))
  h.f.envelope.payload.annotations = [{ path: 'a.md', quote: '丙', comment: '复核' }]
  await h.session.open(h.f, 'a.md')
  const id = h.session.proposal!.hunks.find(row => row.kind === 'theirs-only')!.id
  h.session.decide(id, { kind: 'theirs-only', choice: 'accept' })
  await h.session.flush()
  const saved = await h.deps.command<LocalFeedback>('inbox', {})
  await h.session.destroy()
  const reopened = createProjectReview('p', h.deps)
  await reopened.open(saved, 'a.md')
  expect(reopened.decisions[id]).toEqual({ kind: 'theirs-only', choice: 'accept' })
  reopened.stageAnnotation(0)
  await reopened.writeFile()
  expect(h.current).toBe('甲改。\n\n乙改。\n\n{==丙==}{>>访客：复核<<}。\n')
  expect(h.calls.filter(call => call.op === 'apply')).toHaveLength(1)
  expect(h.calls.find(call => call.op === 'apply')!.args.summary).toEqual({ accepted: 1, total: 1 })
  const completed = await h.deps.command<LocalFeedback>('inbox', {})
  expect(completed.annotation_decisions!['0']).toBe('promoted')
  const second = feedback('same-change', base, base.replace('乙。', '乙改。'))
  h.setFeedback(second)
  await reopened.open(second, 'a.md')
  expect(reopened.proposal!.hunks.some(row => row.kind === 'both-same')).toBe(true)
  await reopened.destroy()
})

it('keeps a repeated suggestion unresolved when an inline promoted annotation makes its paragraph atomic', () => {
  const proposal = propose({ path: 'a.md', base: '甲。乙。丙。',
    ours: '甲改。乙改。{==丙==}{>>访客：复核<<}。', theirs: '甲。乙改。丙。' })
  expect(proposal.hunks).toHaveLength(1)
  expect(proposal.hunks[0]).toMatchObject({ kind: 'conflict', base: '甲。乙。丙。',
    ours: '甲改。乙改。{==丙==}{>>访客：复核<<}。', theirs: '甲。乙改。丙。' })
})
