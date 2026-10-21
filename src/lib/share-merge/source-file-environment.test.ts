import { expect, it } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { createSourceSession, prepareFileSourceEdits, applySourceBlockTransaction, type SourceSession, type SourcePatch } from '@moraya/core'
import { propose } from './proposal'

function open(source: string): SourceSession {
  const result = createSourceSession(source)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
  return result.session
}
function edit(base: SourceSession, patches: readonly SourcePatch[]) {
  return prepareFileSourceEdits(base, { expectedRevision: base.revision, edits: patches })
}
it.each([100, 1000])('installed raw API edits one sentence locally in %i roots', count => {
  const paragraphs = Array.from({ length: count }, (_, i) => `第${i}段甲。第二句保持原样。`)
  const source = paragraphs.join('\n\n'), base = open(source)
  const target = Math.floor(count / 2), from = source.indexOf(paragraphs[target]!) + paragraphs[target]!.indexOf('甲')
  const result = edit(base, [{ from, to: from + 1, removed: '甲', text: '乙' }])
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
  expect(Buffer.from(result.session.source)).toEqual(Buffer.from(source.slice(0, from) + '乙' + source.slice(from + 1)))
  expect(result.file.work.mode).toBe('local')
  expect(result.file.work.fullCaptureCalls).toBe(0)
  expect(result.file.work.inlineParseCalls).toBe(3)
  expect(result.file.work.blockRuleCalls).toBe(48)
  // Parser patches may reduce reads; retain the original fixed local-work budget.
  expect(result.file.work.blockLinesVisited).toBeGreaterThan(0)
  expect(result.file.work.blockLinesVisited).toBeLessThanOrEqual(233)
  expect(result.file.work.rawTouchedBeforeRoots).toEqual([target])
  expect(result.file.correspondence.find(c => c.beforeRoots.includes(target))?.kind).toBe('retained')
  const oracle = open(result.session.source)
  expect(result.session.doc.eq(oracle.doc)).toBe(true)
  for (const key of ['roots', 'gaps', 'protectedSources', 'layout', 'textSpans'] as const) expect(result.session[key]).toEqual(oracle[key])
  const proposal = propose({ path: 'local.md', base: source, ours: source, theirs: result.session.source })
  expect(proposal.hunks).toHaveLength(1)
  expect(proposal.hunks[0]!.base).toBe(`第${target}段甲。`)
  expect(proposal.hunks[0]!.theirs).toBe(`第${target}段乙。`)
})
it('installed environment updates remote links without replacing untouched raw roots', () => {
  const base = open('[new]\n\nMiddle\n\nTail')
  const result = edit(base, [{ from: base.source.length, to: base.source.length, removed: '', text: '\n\n[new]: /url\n' }])
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.session.doc.firstChild!.firstChild!.marks[0]!.attrs.href).toBe('/url')
  expect(result.file.environmentVersion).toBe(1)
  expect(result.file.work.environmentChanged).toBe(true)
  expect(result.file.work.fullCaptureCalls).toBe(0)
  expect(result.file.correspondence[0]!.kind).toBe('untouched')
})
it('installed footnote effects stay local for unrelated edits', () => {
  const base = open('A[^x] ![alt[^x]](/img)\n\nBefore\n\nMiddle\n\nAfter\n\n[^x]: body')
  const from = base.source.indexOf('Middle'), result = edit(base, [{ from, to: from + 6, removed: 'Middle', text: 'Changed' }])
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.file.work.inlineEffectReplayCount).toBe(2)
  expect(result.file.work.inlineParseCalls).toBe(3)
  expect(result.session.doc.eq(open(result.session.source).doc)).toBe(true)
})
it('installed raw CAS and no-op preserve the base atomically', () => {
  const base = open('Alpha\r\n\r\nTail'), before = JSON.stringify(base)
  const stale = prepareFileSourceEdits(base, { expectedRevision: 9, edits: [] })
  expect(stale.ok).toBe(false)
  if (!stale.ok) { expect(stale.reason).toBe('stale-document'); expect(stale.work.fullCaptureCalls).toBe(0) }
  const noOp = edit(base, [])
  expect(noOp.ok && noOp.session).toBe(base)
  expect(JSON.stringify(base)).toBe(before)
  const foreign = { ...base, roots: base.roots.map(root => ({ ...root })) }, recovered = edit(foreign, [])
  expect(recovered.ok).toBe(true)
  if (recovered.ok) {
    expect(recovered.session).toBe(foreign)
    expect(recovered.file.work.fullCaptureCalls).toBe(1)
    expect(recovered.file.work.inlineRoots).toEqual(base.roots.map(root => root.id))
  }
})
it('installed Rich entry shares the registered file pipeline', () => {
  const base = open('Before\n\nMiddle\n\nAfter\n\nTail'), root = base.roots[1]!
  const tr = EditorState.create({ doc: base.doc }).tr.insertText('C', root.pmFrom + 1, root.pmFrom + 2)
  const result = applySourceBlockTransaction(base, tr)
  expect(result.ok).toBe(true)
  if (result.ok) { expect(result.file!.work.fullCaptureCalls).toBe(0); expect(result.file!.work.inlineParseCalls).toBe(3) }
})
