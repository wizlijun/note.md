import { expect, it } from 'vitest'
import { completeGuestRebase, prepareGuestRebase, undoGuestRebase } from './rebase'
import { sha256Sync } from '../lib/share-merge/hash'
import type { DraftV2 } from '../lib/project-share/types'
const snapshot = (markdown: string) => ({ project_id: 'P', snapshotId: 'S2', entry: 'a.md', files: [{ path: 'a.md', markdown, hash: sha256Sync(markdown) }] })
function draft(base: string, after: string): DraftV2 { return { v: 2, lineageId: 'L', snapshotId: 'S1', base: { 'a.md': { markdown: base, hash: sha256Sync(base) } }, after: { 'a.md': after }, annotationKinds: {}, message: 'hello', lastSubmissionId: 'prior' } }
it('uses real rebase for independent edits and preserves cancellation and full undo metadata', () => {
  const old = draft('甲。\n\n乙。\n', '甲！\n\n乙。\n'); old.rebasedFrom = 'S0'; old.annotationKinds = { prior: 'blocker' }
  const frozen = structuredClone(old), c = prepareGuestRebase(old, snapshot('甲。\n\n乙！\n'))
  expect(old).toEqual(frozen)
  const next = completeGuestRebase(c)
  expect(next.after['a.md']).toBe('甲！\n\n乙！\n'); expect(next).toMatchObject({ snapshotId: 'S2', rebasedFrom: 'S1', lineageId: 'L', message: 'hello', lastSubmissionId: 'prior' })
  expect(undoGuestRebase(next)).toEqual(frozen)
})
it('keeps real same-sentence conflicts pending and composes the explicit decision', () => {
  const c = prepareGuestRebase(draft('甲。', '甲！'), snapshot('甲？'))
  expect(() => completeGuestRebase(c)).toThrow('冲突')
  const file = c.files[0], conflict = file.proposal.hunks.find(h => h.kind === 'conflict')!
  file.decisions[conflict.id] = { kind: 'conflict', choice: 'edited', text: '手改。' }
  expect(completeGuestRebase(c).after['a.md']).toBe('手改。')
})
it('keeps removed raw until full export is confirmed', () => {
  const c = prepareGuestRebase(draft('旧。', '全部旧稿！'), { ...snapshot(''), files: [] })
  expect(c.next.after['a.md']).toBe('全部旧稿！'); expect(c.removed).toEqual(['a.md'])
  expect(() => completeGuestRebase(c)).toThrow('完整草稿')
  c.exported.add('file:a.md'); const next = completeGuestRebase(c)
  expect(next.after).toEqual({}); expect(undoGuestRebase(next).after['a.md']).toBe('全部旧稿！')
})
it('reports orphan, exports it explicitly, and retains original in undo', () => {
  const old = draft('甲。', '{==甲==}{>>批注<<}。'), c = prepareGuestRebase(old, snapshot('乙。'))
  expect(c.orphans[0].annotation.comment).toBe('批注'); expect(() => completeGuestRebase(c)).toThrow('无法定位')
  c.exported.add('annotation:a.md:0'); expect(undoGuestRebase(completeGuestRebase(c)).after).toEqual(old.after)
})
it('reattaches guest Critic after owner Critic while preserving kind and BOM/CRLF', () => {
  const base = '\uFEFF甲。\r\n\r\n乙。\r\n', old = draft(base, '\uFEFF{==甲==}{>>批注<<}。\r\n\r\n乙。\r\n')
  const hash = sha256Sync('甲\0批注').slice(0, 16); old.annotationKinds[hash] = 'question'
  const next = completeGuestRebase(prepareGuestRebase(old, snapshot(base + '{>>主人<<}')))
  expect(next.after['a.md']).toBe(old.after['a.md'] + '{>>主人<<}'); expect(next.annotationKinds[hash]).toBe('question')
})
it('blocks pending and another rebase, and defaults legacy previous metadata', () => {
  const old = draft('甲。', '甲。'); old.pending = { submissionId: 'id', body: '{}' }
  expect(() => prepareGuestRebase(old, snapshot('乙。'))).toThrow('冻结')
  delete old.pending; old.previous = { snapshotId: 'S0', base: {}, after: {} }
  expect(() => prepareGuestRebase(old, snapshot('乙。'))).toThrow('上次')
  expect(undoGuestRebase(old)).toMatchObject({ snapshotId: 'S0', annotationKinds: {}, base: {}, after: {} })
})
it('rekeys fuzzy reanchored annotation kind using the new exact text', () => {
  const old = draft('abcdefghij', '{==abcdefghij==}{>>why<<}')
  old.annotationKinds[sha256Sync('abcdefghij\0why').slice(0, 16)] = 'blocker'
  const next = completeGuestRebase(prepareGuestRebase(old, snapshot('abcXefghij')))
  expect(next.after['a.md']).toBe('{==abcXefghij==}{>>why<<}')
  expect(next.annotationKinds).toEqual({ [sha256Sync('abcXefghij\0why').slice(0, 16)]: 'blocker' })
})
it('merges fallback sidecar with Critic guests once and preserves complete old sidecar for undo', () => {
  const old = draft('甲。\n\n乙。', '{==甲==}{>>Critic<<}。\n\n乙。')
  const sidecar = [{ path: 'a.md', selector: { exact: '乙', start: 4, end: 5 }, comment: 'sidecar', kind: 'question' as const }]
  const next = completeGuestRebase(prepareGuestRebase(old, snapshot('甲。\n\n乙！'), sidecar))
  expect(next.after['a.md']).toBe('{==甲==}{>>Critic<<}。\n\n{==乙==}{>>sidecar<<}！')
  expect(next.previous?.annotations).toEqual(sidecar)
  expect(next.annotationKinds[sha256Sync('乙\0sidecar').slice(0, 16)]).toBe('question')
  expect(undoGuestRebase(next).after).toEqual(old.after)
})
it('reports overlapping or unrepresentable sidecar instead of corrupting Critic', () => {
  const old = draft('甲。', '{==甲==}{>>Critic<<}。')
  const c = prepareGuestRebase(old, snapshot('甲。\n'), [{ path: 'a.md', selector: { exact: '甲' }, comment: 'overlap' }, { path: 'a.md', selector: { exact: '。' }, comment: '{>>nested<<}' }])
  expect(c.orphans).toHaveLength(2); expect(() => completeGuestRebase(c)).toThrow('无法定位')
})
