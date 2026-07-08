import { describe, it, expect } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { schema } from 'prosemirror-schema-basic'
import { countMarkSteps, analyticsObserverPlugin, type ObserverDelta } from './observer'

function docState() {
  return EditorState.create({ schema })
}

describe('countMarkSteps', () => {
  it('counts an addMark step as one mark op', () => {
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('hello world')]),
    ]) })
    const tr = state.tr.addMark(1, 6, schema.marks.strong.create())
    expect(countMarkSteps(tr.steps)).toBe(1)
  })

  it('counts a removeMark step as one mark op', () => {
    const withMark = EditorState.create({ schema, doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('hi', [schema.marks.em.create()])]),
    ]) })
    const tr = withMark.tr.removeMark(1, 3, schema.marks.em)
    expect(countMarkSteps(tr.steps)).toBe(1)
  })

  it('counts zero for a plain text insertion', () => {
    const state = docState()
    const tr = state.tr.insertText('abc', 1)
    expect(countMarkSteps(tr.steps)).toBe(0)
  })
})

describe('analyticsObserverPlugin', () => {
  it('reports mark ops and positive size delta as the doc grows', () => {
    const seen: ObserverDelta[] = []
    let state = EditorState.create({ schema, plugins: [analyticsObserverPlugin((d) => seen.push(d))] })
    // Insert text (size grows by 3).
    let tr = state.tr.insertText('abc', 1)
    state = state.apply(tr)
    // Add a mark over it (size unchanged, one mark op).
    tr = state.tr.addMark(1, 4, schema.marks.strong.create())
    state = state.apply(tr)
    expect(seen).toEqual([
      { markOps: 0, sizeDelta: 3 },
      { markOps: 1, sizeDelta: 0 },
    ])
  })

  it('does not fire for a selection-only transaction', () => {
    const seen: ObserverDelta[] = []
    let state = EditorState.create({ schema, doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('abcd')]),
    ]), plugins: [analyticsObserverPlugin((d) => seen.push(d))] })
    const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve(2)))
    state = state.apply(tr)
    expect(seen).toEqual([])
  })
})
