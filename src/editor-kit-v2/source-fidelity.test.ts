import { describe, expect, it } from 'vitest'
import { createSchema } from '@moraya/core'
import { EditorState, Plugin, TextSelection } from 'prosemirror-state'
import { materializeBlocks } from './block-layout'
import { withBlockIdentitySchema } from './identity'
import { createSourceFidelity } from './source-fidelity'

const schema = withBlockIdentitySchema(createSchema({ mediaResolver: {
  loadLocalImage: async path => path, loadLocalMedia: async path => path, loadRemoteMedia: async url => url,
} }))
const source = '这是甲句。中间句保持。末句保持 _斜体_ 与 [链接](<https://example.com>)。'
function setup(later: Plugin[] = []) {
  const doc = materializeBlocks([{ blockId: 'b', markdown: source }], schema).doc
  const fidelity = createSourceFidelity(source, doc)
  const gate = new Plugin({ filterTransaction: (tr, state) => fidelity.prepare(tr, state) })
  const state = EditorState.create({ doc, plugins: [gate, fidelity.plugin, ...later] })
  return { state, fidelity }
}

describe('Kit source fidelity opt-in adapter', () => {
  it('replays the actual text step on the instance schema without host identity', () => {
    const { state, fidelity } = setup()
    const after = state.applyTransaction(state.tr.insertText('乙', 3, 4)).state
    expect(fidelity.source(after)).toBe('这是乙句。中间句保持。末句保持 _斜体_ 与 [链接](<https://example.com>)。')
    expect(after.doc.firstChild!.attrs.cdrBlockId).toBe('b')
    expect(fidelity.source(state)).toBe(source)
  })
  it('allows selection transactions without changing source', () => {
    const { state, fidelity } = setup()
    const after = state.applyTransaction(state.tr.setSelection(TextSelection.create(state.doc, 3))).state
    expect(after.selection.from).toBe(3)
    expect(fidelity.source(after)).toBe(source)
  })
  it('rejects stored-mark intent even when the document has not changed', () => {
    const { state, fidelity } = setup()
    const result = state.applyTransaction(state.tr.setStoredMarks([schema.marks.strong.create()]))
    expect(result.transactions).toHaveLength(0)
    expect(result.state.storedMarks).toBeNull()
    expect(fidelity.source(result.state)).toBe(source)
  })
  it('rejects mark, multi-step, structure and identity changes', () => {
    const { state, fidelity } = setup()
    const transactions = [state.tr.addMark(1,2,schema.marks.em.create()),
      state.tr.insertText('乙',3,4).insertText('丙',4,5), state.tr.split(3),
      state.tr.setNodeMarkup(0, undefined, { ...state.doc.firstChild!.attrs, cdrBlockId: 'other' })]
    for (const tr of transactions) {
      expect(state.applyTransaction(tr).transactions).toHaveLength(0)
      expect(fidelity.source(state)).toBe(source)
    }
  })
  it('does not commit a prepared source when a later filter rejects the transaction', () => {
    const { state, fidelity } = setup([new Plugin({filterTransaction: () => false})])
    const result = state.applyTransaction(state.tr.insertText('乙',3,4))
    expect(result.state).toBe(state)
    expect(fidelity.source(result.state)).toBe(source)
  })
  it('fails before installing a state if a later filter changes a prepared transaction', () => {
    const { state, fidelity } = setup([new Plugin({filterTransaction: tr => { tr.insertText('丙',4,5); return true }})])
    expect(() => state.applyTransaction(state.tr.insertText('乙',3,4))).toThrow(/SOURCE_FIDELITY/)
    expect(fidelity.source(state)).toBe(source)
    expect(state.doc.textContent.startsWith('这是甲句')).toBe(true)
  })
  it('rejects syntax-changing plain text without dropping intent into an accepted edit', () => {
    const { state, fidelity } = setup()
    expect(state.applyTransaction(state.tr.insertText('*乙*',3,4)).transactions).toHaveLength(0)
    expect(fidelity.source(state)).toBe(source)
  })
})
