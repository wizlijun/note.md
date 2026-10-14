/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserMediaResolver } from '@moraya/core/adapters/browser-media-resolver'
import { createShareFileSession, type ShareFileSession } from './file-session'
import type { FileRecovery } from '../editor-kit-v2/file-contract'
import type { DraftV2 } from '../lib/project-share/types'
import { recoveryFromSnapshot } from '../editor-kit-v2/file-recovery'
import type { FileMountSession } from '../editor-kit-v2/file-main'

const sessions: ShareFileSession[] = []
afterEach(async () => { for (const session of sessions.splice(0)) await session.mounted.owner.close(); document.body.replaceChildren() })
function draft(): DraftV2 { return { v: 2, lineageId: 'L', snapshotId: 'S', base: {}, after: {}, annotationKinds: {} } }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function open(live = draft(), saveDraft: (d: DraftV2) => Promise<Readonly<DraftV2>> = async d => structuredClone(d), readOnly = false) {
  const mountTarget = document.createElement('div'); document.body.append(mountTarget)
  const session = await createShareFileSession({ path: 'a.md', snapshotId: 'S', raw: 'A', draft: live, policy: { acceptRawChange: () => true }, adapters: { mediaResolver: new BrowserMediaResolver() }, mountTarget, saveDraft, readOnly })
  sessions.push(session); return session
}
async function edited(session: ShareFileSession, raw: string) { expect(session.mounted.owner.restoreContent(raw).ok).toBe(true); await Promise.resolve() }

it('restores exact empty after and drops invalid caches without dropping raw', async () => {
  const live = draft(); live.after['a.md'] = ''
  live.editorFiles = { 'a.md': { v: 1, sourceHash: 'wrong', sourceRevision: 55, bindings: [{ rootOrdinal: 0, id: 'bad' }] } }
  const s = await open(live)
  expect(s.mounted.owner.snapshot()).toMatchObject({ raw: '', sourceRevision: 0, bindings: [] })
  expect(s.mounted.owner.canUndo()).toBe(false)
  await s.save(); expect(s.saved()?.hash).toBe(s.mounted.owner.snapshot().sourceHash)
})
it('old snapshot without its own base refuses mount; old base is the only fallback', async () => {
  const live = draft(); live.snapshotId = 'old'
  await expect(open(live)).rejects.toThrow('old-draft-missing-base')
  live.base['a.md'] = { hash: 'old', markdown: 'Old raw' }
  expect((await open(live)).mounted.owner.snapshot().raw).toBe('Old raw')
})
it('real restored bindings appear in first PM frame, history starts fresh and saving never clears it', async () => {
  const first = await open(); await edited(first, 'B')
  const snapshot = first.mounted.owner.snapshot(), live = draft()
  live.after['a.md'] = snapshot.raw; live.editorFiles = { 'a.md': recoveryFromSnapshot(snapshot) }
  const next = await open(live)
  expect(next.mounted.owner.snapshot().bindings).toEqual(snapshot.bindings)
  expect((next.mounted as FileMountSession).view.state.doc.firstChild!.attrs.cdrBlockId).toBe(snapshot.bindings[0].id)
  expect(next.mounted.owner.canUndo()).toBe(false)
  await edited(next, 'C'); await next.save(); expect(next.mounted.owner.undo()).toBe(true)
  expect(next.mounted.owner.snapshot().raw).toBe('B')
})
it('B atomic in flight confirms B only while C and its history remain live', async () => {
  const gate = deferred<Readonly<DraftV2>>(), live = draft(); let stored!: DraftV2
  const s = await open(live, async d => { stored = structuredClone(d); return gate.promise })
  await edited(s, 'B'); const b = s.mounted.owner.snapshot(), save = s.save()
  await vi.waitFor(() => expect(stored).toBeDefined())
  await edited(s, 'C'); gate.resolve(stored); await save
  expect(s.saved()).toEqual({ generation: b.generation, hash: b.sourceHash })
  expect(s.mounted.owner.snapshot().raw).toBe('C'); expect(s.mounted.owner.canUndo()).toBe(true)
  expect(live.after['a.md']).toBe('C')
})
it('queued live FIFO returns actual C; B cannot claim it; delivery clears pending before next clone', async () => {
  const live = draft(); live.pending = { submissionId: 'P', body: 'frozen bytes' }; live.previous = { snapshotId: 'old', base: {}, after: {} }
  const delivery = deferred<void>(); let tail = delivery.promise.then(() => { delete live.pending; delete live.previous; live.lastSubmissionId = 'P' })
  const writes: DraftV2[] = [], second = deferred<void>(); let requested = 0
  const s = await open(live, d => { requested++; const operation = tail.then(async () => { if (writes.length) await second.promise; const stored = structuredClone(d); writes.push(stored); return stored }); tail = operation.then(() => {}); return operation })
  await edited(s, 'B'); const b = s.save(); await vi.waitFor(() => expect(requested).toBe(1))
  await edited(s, 'C'); const c = s.save(); await Promise.resolve()
  expect(live.pending?.body).toBe('frozen bytes'); delivery.resolve(); await b
  expect(s.saved()).toBeUndefined(); second.resolve(); await c
  expect(s.saved()?.hash).toBe(s.mounted.owner.snapshot().sourceHash)
  expect(writes).toHaveLength(2)
  for (const d of writes) { expect(d.pending).toBeUndefined(); expect(d.previous).toBeUndefined(); expect(d.lastSubmissionId).toBe('P'); expect(d.after['a.md']).toBe('C') }
})
it.each(['same', 'ABA', 'lineage', 'wrong-raw', 'wrong-revision', 'wrong-bindings'] as const)('late receipt rejects %s even when value identities can repeat', async kind => {
  const gate = deferred<Readonly<DraftV2>>(), live = draft(); let stored!: DraftV2
  const s = await open(live, async d => { stored = structuredClone(d); return gate.promise })
  await edited(s, 'B'); const before = s.mounted.owner.snapshot(), save = s.save()
  await vi.waitFor(() => expect(stored).toBeDefined())
  if (kind === 'same' || kind === 'ABA') {
    if (kind === 'ABA') expect(s.mounted.owner.installBaseline({ documentId: 'a.md', authority: 'other', raw: 'X' }).ok).toBe(true)
    expect(s.mounted.owner.installBaseline({ documentId: 'a.md', authority: before.authority, raw: 'A' }).ok).toBe(true)
    await edited(s, 'B')
  } else if (kind === 'lineage') live.lineageId = 'other'
  else if (kind === 'wrong-raw') stored.after['a.md'] = 'C'
  else if (kind === 'wrong-revision') stored.editorFiles!['a.md'] = { ...stored.editorFiles!['a.md'], sourceRevision: 99 }
  else stored.editorFiles!['a.md'] = { ...stored.editorFiles!['a.md'], bindings: [{ rootOrdinal: 0, id: 'other' }] }
  gate.resolve(stored); await save; expect(s.saved()).toBeUndefined()
})
it('saved generations are scoped to actual controller, failed baseline and modes retain durable status', async () => {
  const s = await open(); for (let i = 0; i < 4; i++) await edited(s, `B${i}`)
  await s.save(); const old = s.saved()
  const update = vi.spyOn((s.mounted as FileMountSession).view, 'updateState').mockImplementationOnce(() => { throw new Error('candidate view failed') })
  expect(s.mounted.owner.installBaseline({ documentId: 'bad', authority: 'A', raw: 'Bad' }).ok).toBe(false)
  update.mockRestore()
  expect(s.saved()).toBe(old)
  await s.mounted.setMode('source'); await s.mounted.setMode('rich'); expect(s.saved()).toBe(old)
  expect(s.mounted.owner.installBaseline({ documentId: 'a', authority: s.mounted.owner.snapshot().authority, raw: 'New' }).ok).toBe(true)
  expect(s.saved()).toBeUndefined(); await s.save(); expect(s.saved()?.generation).toBe(0)
})
it('queued old notification reads the new baseline pair; recovery metadata never pairs with old raw', async () => {
  const live = draft(), s = await open(live)
  expect(s.mounted.owner.restoreContent('B').ok).toBe(true)
  expect(s.mounted.owner.installBaseline({ documentId: 'new', authority: 'same', raw: 'New' }).ok).toBe(true)
  await Promise.resolve(); expect(live.after['a.md']).toBe('New')
  expect(live.editorFiles!['a.md']).toEqual(recoveryFromSnapshot(s.mounted.owner.snapshot()))
})
it.each([false, true])('close failure preserves owner and actual previous readonly=%s, retry succeeds', async readOnly => {
  let fail = true
  const s = await open(draft(), async d => { if (fail) throw new Error('atomic failed'); return structuredClone(d) }, readOnly)
  await expect(s.close()).rejects.toThrow('atomic failed')
  expect((s.mounted as FileMountSession).view.editable).toBe(!readOnly)
  expect(s.mounted.owner.snapshot().raw).toBe('A'); fail = false; await s.close()
  expect((s.mounted as FileMountSession).view.isDestroyed).toBe(true)
})
it('close locks input until exact durability and rejects a mismatched durable result', async () => {
  let stored!: DraftV2; const gate = deferred<Readonly<DraftV2>>()
  const s = await open(draft(), async d => { stored = structuredClone(d); return gate.promise })
  const close = s.close(); await vi.waitFor(() => expect(stored).toBeDefined())
  expect(s.mounted.owner.restoreContent('C').ok).toBe(false)
  stored.after['a.md'] = 'wrong'; gate.resolve(stored)
  await expect(close).rejects.toThrow('file-save-not-confirmed'); expect((s.mounted as FileMountSession).view.isDestroyed).toBe(false)
  expect(s.mounted.owner.restoreContent('C').ok).toBe(true)
})

it.each(['missing-fields', 'reversed-bindings'] as const)('invalid recovery %s regenerates identities without changing raw', async kind => {
  const seed = await open(); await edited(seed, 'A\n\nB')
  const snapshot = seed.mounted.owner.snapshot(), live = draft()
  live.after['a.md'] = snapshot.raw
  live.editorFiles = { 'a.md': kind === 'missing-fields' ? { v: 1 } as FileRecovery : { ...recoveryFromSnapshot(snapshot), bindings: [...snapshot.bindings].reverse() } }
  const restored = await open(live)
  expect(restored.mounted.owner.snapshot().raw).toBe(snapshot.raw)
  expect(restored.mounted.owner.snapshot().bindings).not.toEqual(snapshot.bindings)
  expect(restored.mounted.owner.canUndo()).toBe(false)
})
it('ordered exact receipt rejects reordered bindings even though all rows are present', async () => {
  const s = await open(draft(), async d => { const stored = structuredClone(d); stored.editorFiles!['a.md'] = { ...stored.editorFiles!['a.md'], bindings: [...stored.editorFiles!['a.md'].bindings].reverse() }; return stored })
  await edited(s, 'A\n\nB'); await s.save(); expect(s.saved()).toBeUndefined()
})
it('failed atomic save retains retry bytes, latest raw and native history', async () => {
  const live = draft(); live.pending = { submissionId: 'P', body: 'exact frozen body' }; let fail = true
  const s = await open(live, async d => { if (fail) throw new Error('disk full'); return structuredClone(d) })
  await edited(s, 'B'); await expect(s.save()).rejects.toThrow('disk full')
  await edited(s, 'C'); expect(live.pending.body).toBe('exact frozen body'); fail = false; await s.save()
  expect(s.saved()?.hash).toBe(s.mounted.owner.snapshot().sourceHash); expect(s.mounted.owner.canUndo()).toBe(true)
})
it('close waits for actual owner composition, then saves its final accepted characters', async () => {
  const save = vi.fn(async (d: DraftV2) => structuredClone(d)), s = await open(draft(), save), view = (s.mounted as FileMountSession).view
  view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  const close = s.close(); await Promise.resolve(); expect(save).not.toHaveBeenCalled()
  view.dispatch(view.state.tr.insertText('中', 2).setMeta('composition', 1))
  view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  await close; expect(save.mock.calls[0][0].after['a.md']).toBe('A中'); expect(view.isDestroyed).toBe(true)
})
it('close rejects unaccepted source pending and retains its draft until explicit retry', async () => {
  const s = await open(); await s.mounted.setMode('source')
  const textarea = document.querySelector('textarea')!
  s.setReadOnly(true); textarea.value = 'Pending'; textarea.dispatchEvent(new Event('input'))
  await expect(s.close()).rejects.toThrow()
  expect(textarea.value).toBe('Pending'); expect((s.mounted as FileMountSession).view.isDestroyed).toBe(false)
  s.setReadOnly(false); const source = (s.mounted as FileMountSession).attachSource(textarea)
  expect(source.retry().ok).toBe(true); await s.close(); expect(s.saved()?.hash).toBe(s.mounted.owner.snapshot().sourceHash)
})

it('closing the actual owner invalidates an already in-flight receipt', async () => {
  const gate = deferred<Readonly<DraftV2>>(); let stored!: DraftV2
  const s = await open(draft(), async d => { stored = structuredClone(d); return gate.promise })
  await edited(s, 'B'); const save = s.save(); await vi.waitFor(() => expect(stored).toBeDefined())
  await s.mounted.owner.close(); gate.resolve(stored); await save; expect(s.saved()).toBeUndefined()
})
