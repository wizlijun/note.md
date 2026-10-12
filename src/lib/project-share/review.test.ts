import { afterEach, expect, it, vi } from 'vitest'
import { anchor, propose, sha256Hex, type MergeProposal } from '../share-merge'
import type { LocalFeedback, ProjectFeedbackV1 } from './types'
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
  const h = fixture(); (h.f.envelope.payload as ProjectFeedbackV1).name = '名字<<}\n'
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


it.each(['a.md', 'b.md'])('restores the freshly flushed draft when reopening via %s', async nextPath => {
  const h = fixture()
  h.f.envelope.payload.edits.push({ ...h.f.envelope.payload.edits[0], path: 'b.md' })
  await h.session.open(h.f, 'a.md')
  h.session.acceptAll()
  const accepted = { ...h.session.decisions }
  await h.session.open(h.f, nextPath)
  await h.session.open(h.f, 'a.md')
  expect(h.session.decisions).toEqual(accepted)
  expect(h.session.feedback!.review!['a.md'].hunks).toEqual(accepted)
  await h.session.destroy()
})

it('restores manual edits made during an in-flight save on same-file reopen', async () => {
  const h = fixture(); h.setCurrent('甲。主人。丙。')
  await h.session.open(h.f, 'a.md')
  const id = h.session.proposal!.hunks[0].id
  h.session.decide(id, { kind: 'conflict', choice: 'edited', text: 'first' })
  const gate = deferred<void>(), command = h.deps.command
  h.deps.command = async (op, args) => { if (op === 'review-save') await gate.promise; return command(op, args) }
  const saving = h.session.flush()
  h.session.decide(id, { kind: 'conflict', choice: 'edited', text: 'latest' })
  const opening = h.session.open(h.f, 'a.md')
  gate.resolve(); await saving; await opening
  expect(h.session.decisions[id]).toMatchObject({ choice: 'edited', text: 'latest' })
  expect(h.session.feedback!.review!['a.md'].hunks[id]).toMatchObject({ text: 'latest' })
  await h.session.destroy()
})

it.each(['\n', '\r\n', '\r'].flatMap(eol => ['', '\uFEFF'].flatMap(bom => ['---', '...'].map(close => ({ eol, bom, close })))))('protects trust frontmatter using kernel boundaries %j', async ({ eol, bom, close }) => {
  const text = bom + ['---', 'verified: true', close, '正文。'].join(eol)
  const h = fixture(feedback('trust', text, text), text)
  h.f.envelope.payload.annotations = [{ path: 'a.md', quote: 'true', comment: 'test' }]
  await h.session.open(h.f, 'a.md')
  expect(h.session.annotations[0]).toMatchObject({ canPromote: false, manualReason: '信任字段需手工处理' })
  h.session.stageAnnotation(0)
  expect(h.session.annotations[0].staged).toBe(false)
  await h.session.writeFile()
  expect(h.current).toBe(text)
  await h.session.destroy()
})

it('rechecks trust ranges when composed text moves a staged body quote into frontmatter', async () => {
  const base = '---\rtitle: old\r---\rtrue'
  const after = '---\rverified: true\r---\r正文。'
  const h = fixture(feedback('trust', base, after), base)
  h.f.envelope.payload.annotations = [{ path: 'a.md', quote: 'true', comment: 'test' }]
  await h.session.open(h.f, 'a.md'); h.session.stageAnnotation(0)
  for (const hunk of h.session.proposal!.hunks) h.session.decide(hunk.id, { kind: 'theirs-only', choice: 'accept' })
  await h.session.writeFile()
  expect(h.session.error).toContain('信任字段批注需手工处理')
  expect(h.calls.filter(c => c.op === 'apply')).toHaveLength(0)
  await h.session.destroy()
})

it('disposes loading annotations without waiting and ignores their late result', async () => {
  const h = fixture(), gate = deferred<Awaited<ReturnType<ReviewDependencies['locateAnnotations']>>>()
  h.f.envelope.payload.annotations = [{ path: 'a.md', quote: '乙', comment: 'old' }]
  h.deps.locateAnnotations = vi.fn(() => gate.promise)
  const opening = h.session.open(h.f, 'a.md')
  await vi.waitFor(() => expect(h.deps.locateAnnotations).toHaveBeenCalledOnce())
  await h.session.destroy()
  expect(h.deps.cancelAnnotations).toHaveBeenCalledTimes(2)
  gate.resolve([{ index: 0, result: { status: 'exact', start: 2, end: 3 } }]); await opening
  expect(h.session.phase).toBe('destroyed'); expect(h.session.annotations).toEqual([])
})

it('does not start compute after a disposed loading review returns late', async () => {
  const h = fixture(), command = h.deps.command, gate = deferred<void>()
  let reads = 0
  h.deps.command = async (op, args) => {
    if (op === 'review' && ++reads === 2) await gate.promise
    return command(op, args)
  }
  const opening = h.session.open(h.f, 'a.md')
  await vi.waitFor(() => expect(reads).toBe(2))
  await Promise.all([h.session.destroy(), h.session.destroy()])
  gate.resolve(); await opening
  expect(h.deps.compute).not.toHaveBeenCalled()
  expect(h.deps.dispose).toHaveBeenCalledOnce()
  expect(h.session.phase).toBe('destroyed')
})

it('Git targets read only, persist target snapshots, and dismiss without promoting or saving buffers', async () => {
  const f = feedback(); f.envelope.payload.annotations = [{ path: 'a.md', quote: '甲。', comment: 'note' }]
  const h = fixture(f), original = h.deps.command
  h.deps.command = vi.fn(async (op, args) => original<any>(op === 'review-readonly' ? 'review' : op, args))
  h.deps.gitCommand = vi.fn(async op => op === 'branch-state' ? null : ({ git: true, team: true, prefix: '', target: 'branch' })) as any
  await h.session.initializeTarget()
  await h.session.open(f, 'a.md'); h.session.acceptAll(); await h.session.flush()
  expect(h.session.target).toBe('branch')
  expect(h.deps.prepareSource).not.toHaveBeenCalled()
  expect(h.deps.command).toHaveBeenCalledWith('review-readonly', expect.anything())
  expect(h.calls.find(c => c.op === 'review-save')?.args.draft.target).toBe('branch')
  expect(h.session.annotations[0].canPromote).toBe(false)
  await h.session.dismissAnnotation(0)
  expect(h.calls.at(-1)?.args.target).toBe('branch')
  await h.session.writeFile()
  expect(h.calls.some(c => c.op === 'apply')).toBe(false)
  await h.session.setTarget('worktree')
  expect(h.deps.prepareSource).toHaveBeenCalledOnce()
  await h.session.destroy()
})

function gitFixture(target: 'branch' | 'patch' = 'branch') {
  const f = feedback('s'); f.envelope.payload.edits.push({ path: 'b.md', baseHash: 'base', afterMarkdown: '甲。乙改。丙。' })
  const h = fixture(f), original = h.deps.command
  h.deps.command = vi.fn(async (op, args) => original<any>(op === 'review-readonly' ? 'review' : op, args))
  h.deps.gitCommand = vi.fn(async (op: string) => {
    if (op === 'probe') return { git: true, team: true, prefix: '', remote: "team's repo", target }
    if (op === 'branch-state') return null
    if (op === 'prepare') return { head: 'H', entry: 'a.md', feedback: h.session.feedback, commitMessage: 'trusted', files: f.envelope.payload.edits.map(e => ({ path: e.path, base: '甲。乙。丙。', current: '甲新。乙。丙。', after: e.afterMarkdown })) }
    if (op === 'branch') return { branch: 'share/topic', commit: 'oid', feedback: { ...h.session.feedback, status: 'branched', decisions: Object.fromEntries(f.envelope.payload.edits.map(e => [e.path, { status: 'branched' }])) } }
    if (op === 'export-patch') return { patch: 'From oid\r\n中文\n' }
    throw new Error(op)
  }) as any
  h.deps.confirmGit = vi.fn(async () => true)
  h.deps.pickPatch = vi.fn(async () => '/tmp/result.patch')
  h.deps.savePatch = vi.fn(async () => {})
  return h
}
async function reviewGit(h: ReturnType<typeof gitFixture>) {
  await h.session.initializeTarget()
  for (const edit of h.f.envelope.payload.edits) { await h.session.open(h.f, edit.path); h.session.acceptAll() }
}
it('branches every edit in one command at fixed HEAD, locks navigation and never calls A', async () => {
  const h = gitFixture(); await reviewGit(h)
  const confirmation = deferred<boolean>(); h.deps.confirmGit = vi.fn(() => confirmation.promise)
  const job = h.session.executeGit()
  await vi.waitFor(() => expect(h.deps.confirmGit).toHaveBeenCalled())
  expect(h.session.phase).toBe('writing')
  await expect(h.session.destroy()).rejects.toThrow('写回')
  await expect(h.session.setTarget('worktree')).rejects.toThrow('写回')
  expect(vi.mocked(h.deps.confirmGit!).mock.calls[0][0].files).toHaveLength(2)
  confirmation.resolve(true); await job
  expect(h.deps.gitCommand).toHaveBeenCalledWith('branch', { project_id: 'p', submissionId: 's', expectedHead: 'H', results: { 'a.md': '甲新。乙改。丙。', 'b.md': '甲新。乙改。丙。' } })
  expect(h.deps.prepareSource).not.toHaveBeenCalled(); expect(h.deps.refreshSource).not.toHaveBeenCalled()
  expect(h.calls.some(c => c.op === 'apply')).toBe(false)
  expect(h.session.branchResult?.branch).toBe('share/topic')
  await h.session.executeGit()
  expect(vi.mocked(h.deps.gitCommand!).mock.calls.filter(([op]) => op === 'branch')).toHaveLength(1)
  await h.session.destroy()
})
it('retries only trusted per-file branch state after stateError, preserving the real branch', async () => {
  const h = gitFixture(); await reviewGit(h)
  const original = h.deps.gitCommand!
  h.deps.gitCommand = vi.fn(async (op, args) => op === 'branch' ? { branch: 'real', commit: 'oid', feedback: h.session.feedback, stateError: '未完整记录' } : original(op, args)) as any
  await h.session.executeGit(); expect(h.session.branchResult?.stateError).toBe('未完整记录')
  await h.session.executeGit(); await h.session.retryBranchState()
  expect(vi.mocked(h.deps.gitCommand!).mock.calls.filter(([op]) => op === 'branch')).toHaveLength(1)
  expect(h.calls.filter(c => c.op === 'git-branched').map(c => c.args.path)).toEqual(['a.md', 'b.md'])
  expect(h.session.branchResult?.branch).toBe('real'); expect(h.session.branchResult?.stateError).toBeUndefined()
  await h.session.destroy()
})
it.each(['cancel', 'saved', 'write-failed', 'head-changed'] as const)('patch %s preserves decisions and never retries export', async kind => {
  const h = gitFixture('patch'); await reviewGit(h)
  if (kind === 'cancel') h.deps.pickPatch = vi.fn(async () => null)
  if (kind === 'write-failed') h.deps.savePatch = vi.fn(async () => { throw new Error('write failed') })
  if (kind === 'head-changed') {
    const original = h.deps.gitCommand!
    h.deps.gitCommand = vi.fn(async (op, args) => { if (op === 'export-patch') throw new Error('HEAD changed'); return original(op, args) }) as any
  }
  await h.session.executeGit()
  const exports = vi.mocked(h.deps.gitCommand!).mock.calls.filter(([op]) => op === 'export-patch')
  expect(exports).toHaveLength(kind === 'cancel' ? 0 : 1)
  if (kind === 'saved') expect(h.deps.savePatch).toHaveBeenCalledWith('/tmp/result.patch', 'From oid\r\n中文\n')
  if (kind === 'head-changed' || kind === 'cancel') expect(h.deps.savePatch).not.toHaveBeenCalled()
  expect(h.session.feedback?.decisions).toEqual({})
  expect(Object.keys(h.session.feedback?.review ?? {})).toHaveLength(2)
  expect(h.deps.prepareSource).not.toHaveBeenCalled(); expect(h.deps.refreshSource).not.toHaveBeenCalled()
  await h.session.destroy()
})

it('rejects a real HEAD conflict across the batch before confirmation or any Git execution', async () => {
  const h = gitFixture(); await reviewGit(h)
  const original = h.deps.gitCommand!
  h.deps.gitCommand = vi.fn(async (op, args) => {
    const value = await original<any>(op, args)
    if (op === 'prepare') value.files[1].current = '甲。主人冲突。丙。'
    return value
  })
  await h.session.executeGit()
  expect(h.session.error).toContain('相对 HEAD 有冲突或决定失效')
  expect(h.deps.confirmGit).not.toHaveBeenCalled()
  expect(vi.mocked(h.deps.gitCommand!).mock.calls.some(([op]) => op === 'branch' || op === 'export-patch')).toBe(false)
  await h.session.destroy()
})
it('keeps project choice isolated, ignores draft target and retains old target on config failure', async () => {
  const a = gitFixture('patch'), b = gitFixture('branch')
  await a.session.initializeTarget(); await b.session.initializeTarget()
  expect(a.session.target).toBe('patch'); expect(b.session.target).toBe('branch')
  await a.session.open(a.f, 'a.md'); a.session.acceptAll()
  const original = a.deps.command
  a.deps.command = vi.fn(async (op, args) => { if (op === 'git-target') throw new Error('config failed'); return original<any>(op, args) })
  await expect(a.session.setTarget('worktree')).rejects.toThrow('config failed')
  expect(a.session.target).toBe('patch')
  expect(a.calls.find(c => c.op === 'review-save')?.args.draft.target).toBe('patch')
  expect(a.deps.prepareSource).not.toHaveBeenCalled()
  await a.session.destroy(); await b.session.destroy()
})
it('isolates a late probe from a destroyed session', async () => {
  const h = gitFixture(), probe = deferred<any>()
  h.deps.gitCommand = vi.fn(() => probe.promise)
  const opening = h.session.initializeTarget()
  await h.session.destroy()
  probe.resolve({ git: true, remote: 'upstream', prefix: '', team: true })
  await opening
  expect(h.session.phase).toBe('destroyed'); expect(h.session.probe).toBeNull()
})

it('falls back to A when execution probe finds Git removed, without touching buffers or retrying', async () => {
  const h = gitFixture(); await reviewGit(h)
  h.deps.gitCommand = vi.fn(async () => ({ git: false, team: false, prefix: '', reason: 'Git unavailable' })) as any
  await h.session.executeGit()
  expect(h.session.target).toBe('worktree')
  expect(h.deps.gitCommand).toHaveBeenCalledExactlyOnceWith('probe', { project_id: 'p' })
  expect(h.deps.prepareSource).not.toHaveBeenCalled(); expect(h.deps.refreshSource).not.toHaveBeenCalled()
  await h.session.destroy()
})

it('treats a reopened all-branched submission as terminal even on an annotation-only path', async () => {
  const f = feedback(); f.status = 'branched'; f.decisions['a.md'] = { status: 'branched' }
  f.envelope.payload.annotations = [{ path: 'note.md', quote: '甲。', comment: 'note' }]
  const h = fixture(f)
  await h.session.open(f, 'note.md')
  expect(h.session.canWrite).toBe(false); expect(h.session.canReject).toBe(false)
  expect(h.session.annotations[0].canPromote).toBe(false)
  await h.session.destroy()
})


it.each(['branch', 'patch'] as const)('final I1: recovered not_applied reaches %s without A side effects', async target => {
  const h = gitFixture(target)
  h.f.decisions['a.md'] = { status: 'not_applied' }
  await reviewGit(h)
  expect(h.session.canGit).toBe(true)
  await h.session.executeGit()
  expect(h.deps.gitCommand).toHaveBeenCalledWith(target === 'branch' ? 'branch' : 'export-patch', expect.anything())
  expect(h.deps.prepareSource).not.toHaveBeenCalled()
  if (target === 'patch') expect(h.session.feedback?.decisions['a.md'].status).toBe('not_applied')
  await h.session.destroy()
})
it.each(['accepted', 'rejected', 'branched', 'pending', 'mirror_pending', 'recovery_conflict', 'source_changed', 'unknown'])('final I1: mixed %s remains blocked', async status => {
  const h = gitFixture(); h.f.decisions['a.md'] = { status }
  await h.session.initializeTarget(); await h.session.open(h.f, 'a.md')
  expect(h.session.canGit).toBe(false)
  await h.session.executeGit()
  expect(h.deps.confirmGit).not.toHaveBeenCalled()
  await h.session.destroy()
})
it.each(['branch', 'patch'] as const)('final I4: reject carries explicit %s and preserves late A intent failure', async target => {
  const h = gitFixture(target); await h.session.initializeTarget(); await h.session.open(h.f, 'a.md')
  const original = h.deps.command
  h.deps.command = vi.fn(async (op, args) => {
    if (op === 'reject') { expect(args.target).toBe(target); throw new Error('worktree apply recovery pending; switch to worktree review first') }
    return original<any>(op, args)
  })
  await expect(h.session.rejectFile()).rejects.toThrow('worktree')
  expect(h.session.feedback?.decisions).toEqual({})
  expect(h.deps.prepareSource).not.toHaveBeenCalled()
  await h.session.setTarget('worktree')
  expect(h.deps.prepareSource).toHaveBeenCalledOnce()
  await h.session.destroy()
})
it.each(['branch', 'patch'] as const)('final M2: both-same %s has no confirmation, picker, ref or saved patch', async target => {
  const h = gitFixture(target), original = h.deps.gitCommand!
  h.deps.gitCommand = vi.fn(async (op, args) => {
    const value = await original<any>(op, args)
    if (op === 'prepare') value.files.forEach((file: any) => { file.current = file.after })
    return value
  })
  await h.session.initializeTarget(); await h.session.open(h.f, 'a.md'); await h.session.executeGit()
  expect(h.session.error).toContain('已包含')
  expect(h.deps.confirmGit).not.toHaveBeenCalled(); expect(h.deps.pickPatch).not.toHaveBeenCalled(); expect(h.deps.savePatch).not.toHaveBeenCalled()
  expect(vi.mocked(h.deps.gitCommand!).mock.calls.some(([op]) => op === 'branch' || op === 'export-patch')).toBe(false)
  expect(h.session.feedback?.decisions).toEqual({})
  await h.session.destroy()
})
it.each([false, true])('final I2: new session restores owned branch with partial=%s and only records state', async partial => {
  const first = gitFixture(); await reviewGit(first)
  const saved = structuredClone(first.session.feedback!)
  await first.session.destroy()
  if (partial) saved.decisions['a.md'] = { status: 'branched', gitBranch: 'real', gitCommit: 'oid' }
  const h = fixture(saved), command = h.deps.command
  h.deps.command = vi.fn(async (op, args) => {
    if (op === 'git-branched') {
      saved.decisions[String(args.path)] = { status: 'branched', gitBranch: 'real', gitCommit: 'oid' }
      return structuredClone(saved) as any
    }
    return command(op === 'review-readonly' ? 'review' : op, args)
  })
  h.deps.gitCommand = vi.fn(async op => {
    if (op === 'probe') return { git: true, target: 'branch', head: 'advanced-H', team: true, prefix: '' }
    if (op === 'branch-state') return { branch: 'real', commit: 'oid', feedback: saved, stateError: 'retry state' }
    throw new Error('must not recreate a branch: ' + op)
  }) as any
  await h.session.initializeTarget(); await h.session.open(saved, 'a.md')
  expect(h.session.branchResult?.branch).toBe('real'); expect(h.session.canGit).toBe(false)
  await h.session.retryBranchState()
  expect(vi.mocked(h.deps.command).mock.calls.filter(([op]) => op === 'git-branched').map(([, args]) => args.path)).toEqual(['a.md', 'b.md'])
  expect(h.session.branchResult?.stateError).toBeUndefined()
  expect(h.deps.prepareSource).not.toHaveBeenCalled()
  await h.session.destroy()
})

it('final I2: failed owned branch query blocks B but permits deliberate A recovery', async () => {
  const h = gitFixture(), original = h.deps.gitCommand!
  h.deps.gitCommand = vi.fn(async (op, args) => {
    if (op === 'branch-state') throw new Error('worktree apply recovery pending; switch to worktree review first')
    return original<any>(op, args)
  })
  await h.session.initializeTarget(); await h.session.open(h.f, 'a.md')
  expect(h.session.error).toContain('worktree')
  expect(h.session.canGit).toBe(false)
  await h.session.setTarget('worktree')
  expect(h.session.target).toBe('worktree'); expect(h.deps.prepareSource).toHaveBeenCalledOnce()
  await h.session.destroy()
})

it('preserves v2 selector context through anchoring and promotes with the v2 contributor name', async () => {
  const f = feedback(), selector = { exact: '甲', prefix: '乙。', suffix: '。' }
  f.envelope.payload = { schemaVersion: 2, project_id: 'p', snapshotId: 'old-S1', submissionId: 'v2', edits: [],
    annotations: [{ path: 'a.md', selector, comment: '检查<<}', kind: 'question' }], contributor: { name: '名字<<}' }, message: '说明' }
  const original = JSON.stringify(f.envelope)
  const h = fixture(f, '甲。乙。甲。')
  await h.session.open(f, 'a.md')
  expect(h.deps.locateAnnotations).toHaveBeenCalledWith('甲。乙。甲。', [{ index: 0, selector }])
  expect(h.session.annotations[0].annotation.kind).toBe('question')
  expect(h.session.annotations[0].anchor).toMatchObject({ start: 4, end: 5 })
  h.session.stageAnnotation(0); await h.session.writeFile()
  expect(h.current).toBe('甲。乙。{==甲==}{>>名字< <}：检查< <}<<}。')
  expect(JSON.stringify(h.session.feedback!.envelope)).toBe(original)
  await h.session.destroy()
})

it('syncs receipt after a successful apply and does not turn a network failure into a source failure', async () => {
  const h = fixture()
  h.deps.syncReceipt = vi.fn(async id => { expect(id).toBe('one'); expect(h.current).toBe('甲。乙改。丙。'); throw new Error('offline') })
  await h.session.open(h.f, 'a.md'); h.session.acceptAll(); await h.session.writeFile()
  expect(h.deps.syncReceipt).toHaveBeenCalledWith('one')
  expect(h.session.error).toBe(''); expect(h.session.notice).toBe('此文件已写回')
  await h.session.destroy()
})
it('explicit superseded decisions honor the selected target without replacing the selected submission', async () => {
  const h = fixture()
  h.deps.gitCommand = vi.fn(async op => op === 'branch-state' ? null : ({ git: true, team: true, prefix: '', target: 'patch' }) as any)
  h.deps.syncReceipt = vi.fn(async () => feedback('old'))
  const command = h.deps.command
  h.deps.command = (op, args) => command(op === 'review-readonly' ? 'review' : op, args)
  await h.session.initializeTarget(); await h.session.open(h.f, 'a.md')
  await h.session.rejectSuperseded([feedback('old')])
  expect(h.calls.find(c => c.op === 'reject')?.args).toMatchObject({ submissionId: 'old', reason: 'superseded', target: 'patch' })
  expect(h.session.feedback?.envelope.payload.submissionId).toBe('one')
  await h.session.destroy()
})
it('syncs annotation decisions, resolution, rejection and branch completion after persistence', async () => {
  const f = feedback(); f.envelope.payload.edits = []; f.envelope.payload.annotations = [{ path: 'a.md', quote: '乙', comment: '评论', start: 2, end: 3 }]
  const h = fixture(f)
  h.deps.syncReceipt = vi.fn(async () => h.session.feedback!)
  await h.session.open(h.f, 'a.md'); await h.session.dismissAnnotation(0)
  expect(h.deps.syncReceipt).toHaveBeenCalledOnce()
  await h.session.resolve(); expect(h.deps.syncReceipt).toHaveBeenCalledTimes(2)
  expect(h.session.feedback?.status).toBe('resolved'); await h.session.destroy()
  const rejected = fixture(); rejected.deps.syncReceipt = vi.fn(async () => rejected.session.feedback!)
  await rejected.session.open(rejected.f, 'a.md'); await rejected.session.rejectFile()
  expect(rejected.deps.syncReceipt).toHaveBeenCalledOnce(); await rejected.session.destroy()
  const branch = gitFixture(); branch.deps.syncReceipt = vi.fn(async () => branch.session.feedback!)
  await reviewGit(branch); await branch.session.executeGit()
  expect(branch.deps.syncReceipt).toHaveBeenCalledOnce(); await branch.session.destroy()
})
