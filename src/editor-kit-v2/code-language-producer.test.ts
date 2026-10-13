// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { applySourceBlockTransaction, createSchema, createSourceSession, serializeMarkdown } from '@moraya/core'
import { EditorState, type Transaction } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { executeEditorCommand } from './commands'

it('actual Kit code command creates an empty-language block accepted by installed Source', () => {
  const schema = createSchema({ mediaResolver: {
    loadLocalImage: async path => path,
    loadLocalMedia: async path => path,
    loadRemoteMedia: async path => path,
  } })
  const captured = createSourceSession('x', schema)
  if (!captured.ok) throw new Error(captured.reason)
  const transactions: Transaction[] = []
  const view = new EditorView(document.body, {
    state: EditorState.create({ doc: captured.session.doc }),
    dispatchTransaction(tr) { transactions.push(tr); view.updateState(view.state.apply(tr)) },
  })
  try {
    const before = view.state.doc
    expect(executeEditorCommand(view, { kind: 'code-block' })).toBe(true)
    expect(transactions).toHaveLength(1)
    const tr = transactions[0]!
    expect(tr.before.eq(before)).toBe(true)
    expect(tr.doc.eq(view.state.doc)).toBe(true)
    expect(tr.doc.firstChild!.type).toBe(schema.nodes.code_block)
    expect(tr.doc.firstChild!.attrs.language).toBe('')
    expect(serializeMarkdown(tr.doc)).toBe('```\nx\n```')
    const applied = applySourceBlockTransaction(captured.session, tr)
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error(applied.reason)
    expect(applied.session.source).toBe('```\nx\n```')
    expect(applied.session.doc.eq(tr.doc)).toBe(true)
    expect(applied.session.doc.firstChild!.attrs.language).toBe('')
    expect(executeEditorCommand(view, { kind: 'paragraph' })).toBe(true)
    expect(view.state.doc.firstChild!.type).toBe(schema.nodes.paragraph)
    expect(view.state.doc.textContent).toBe('x')
  } finally { view.destroy(); document.body.innerHTML = '' }
})
