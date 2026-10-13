// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { applySourceBlockTransaction, createSourceSession, createEditor, createEditorPlugins, createSchema, parseMarkdown, serializeMarkdown } from '@moraya/core'
import type { Node as PmNode } from 'prosemirror-model'
import { EditorState, Plugin, TextSelection, type Transaction } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { canExecuteEditorCommand, executeEditorCommand } from './commands'

const schema = createSchema({ mediaResolver: {
  loadLocalImage: async p => p, loadLocalMedia: async p => p, loadRemoteMedia: async p => p,
} })
const headerOnly = '| A | B | C |\n| --- | :---: | ---: |'
function selectCell(doc: PmNode, row: number, col: number): TextSelection {
  let target: number | undefined
  doc.descendants((node, pos) => {
    if (target !== undefined) return false
    if (node.type.name !== 'table') return true
    let at = pos + 1
    for (let i = 0; i < row; i++) at += node.child(i).nodeSize
    at += 1
    for (let i = 0; i < col; i++) at += node.child(row).child(i).nodeSize
    target = at + 1
    return false
  })
  if (target === undefined) throw new Error('fixture table missing')
  return TextSelection.near(doc.resolve(target)) as TextSelection
}
function makeView(raw: string, plugins: Plugin[] = []) {
  const transactions: Transaction[] = []
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  const view = new EditorView(mount, {
    state: EditorState.create({ doc: parseMarkdown(raw, schema), plugins }),
    dispatchTransaction(tr) {
      transactions.push(tr)
      view.updateState(view.state.applyTransaction(tr).state)
    },
  })
  return { view, transactions, destroy() { view.destroy(); mount.remove() } }
}
for (const kind of ['table.add-row', 'table.next-cell'] as const) it(`actual Kit ${kind} inherits each header alignment`, () => {
  const fixture = makeView(headerOnly)
  try {
    const { view, transactions } = fixture
    view.dispatch(view.state.tr.setSelection(selectCell(view.state.doc, 0, 2)))
    const before = view.state
    expect(canExecuteEditorCommand(view, { kind })).toBe(true)
    expect(view.state).toBe(before)
    transactions.length = 0
    expect(executeEditorCommand(view, { kind })).toBe(true)
    expect(transactions).toHaveLength(1)
    const body = view.state.doc.firstChild!.child(1)
    expect(Array.from({ length: body.childCount }, (_, i) => body.child(i).attrs.alignment)).toEqual(['left', 'center', 'right'])
    expect(view.state.selection.$from.index(1)).toBe(1)
    expect(view.state.selection.$from.index(2)).toBe(kind === 'table.add-row' ? 2 : 0)
  } finally { fixture.destroy() }
})

const kitMocks = vi.hoisted(() => ({ view: undefined as EditorView | undefined }))
vi.mock('../editor-kit/media', () => ({ loadVaultRoot: async () => '' }))
vi.mock('../editor-kit/theme', () => ({ applyKitTheme: async () => {}, watchKitTheme: () => {} }))
vi.mock('../editor-kit/rich', () => ({
  setKitBaseDir: () => {},
  mountRich: async (container: HTMLElement, raw: string, _root: unknown, _change: unknown, _placeholder: unknown, _power: unknown, customize: (schema: import('prosemirror-model').Schema) => import('prosemirror-model').Schema) => {
    const options = { container, initialContent: raw, mediaResolver: {
      loadLocalImage: async (p: string) => p, loadLocalMedia: async (p: string) => p, loadRemoteMedia: async (p: string) => p,
    }, enableTableResize: false }
    const rich = await createEditor(options)
    const localSchema = customize(rich.view.state.schema)
    rich.view.updateState(EditorState.create({ doc: parseMarkdown(raw, localSchema), plugins: await createEditorPlugins(options, localSchema) }))
    kitMocks.view = rich.view
    return rich
  },
}))
import { mountDocumentEditor } from './main'
import { applyDocumentChange } from '../lib/cdr/core'
import { operationContentWrites } from '../lib/cdr/operation'
async function mountKit(raw: string, key: string) {
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  const stylesheet = document.createElement('link')
  stylesheet.href = 'data:text/css,/*editor-kit-v1.css'
  document.head.appendChild(stylesheet)
  let snapshot = { documentId: `table-${key}`, revisionId: 'r1', blocks: [{ blockId: 'b', blockRevision: 'b1', markdown: raw }] }
  localStorage.removeItem(`notemd-cdr-draft:${snapshot.documentId}`)
  const kit = await mountDocumentEditor(mount, {
    snapshot,
    ids: { requestId: () => 'r', operationId: () => 'o' }, localChangeDebounceMs: 100000,
  })
  kit.surface.observeLocalOperations(batch => {
    snapshot = applyDocumentChange(snapshot, batch, { revisionId: 'r2', blockRevisions: Object.fromEntries(batch.operations.flatMap(operationContentWrites).map(write => [write.blockId, 'b2'])) })
    void kit.surface.reconcile({ kind: 'ack-local', requestId: batch.requestId, authoritative: snapshot, includedChangeIds: [] })
  })
  return { kit, view: kitMocks.view!, async destroy() { await kit.surface.destroy(); mount.remove(); stylesheet.remove() } }
}
for (const key of ['Tab', 'Enter']) it(`actual Kit plugin ${key} appends exactly one aligned body`, async () => {
  const fixture = await mountKit(headerOnly, key)
  try {
    const view = fixture.view
    view.dispatch(view.state.tr.setSelection(selectCell(view.state.doc, 0, 2)))
    const transactions: Transaction[] = []
    const dispatch = view.props.dispatchTransaction!
    view.setProps({ dispatchTransaction(tr) { transactions.push(tr); dispatch ? dispatch.call(view, tr) : view.updateState(view.state.applyTransaction(tr).state) } })
    const event = new KeyboardEvent('keydown', { key, ctrlKey: key === 'Enter', cancelable: true })
    expect(view.someProp('handleKeyDown', handler => handler(view, event))).toBe(true)
    expect(transactions).toHaveLength(1)
    expect(view.state.doc.firstChild!.childCount).toBe(2)
    const body = view.state.doc.firstChild!.child(1)
    expect(Array.from({ length: body.childCount }, (_, i) => body.child(i).attrs.alignment)).toEqual(['left', 'center', 'right'])
    expect(view.state.selection.$from.index(1)).toBe(1)
    expect(view.state.selection.$from.index(2)).toBe(key === 'Tab' ? 0 : 2)
  } finally { await fixture.destroy() }
})

import { closeHistory, history, undoDepth } from 'prosemirror-history'
import type { EditorCommand } from './contract'
it('Kit source commands preserve exact raw and complete attrs through installed public Source APIs', () => {
  const fixture = makeView(headerOnly)
  try {
    const { view, transactions } = fixture
    const capture = createSourceSession(headerOnly, view.state.schema)
    if (!capture.ok) throw new Error(capture.reason)
    view.updateState(EditorState.create({ doc: capture.session.doc }))
    view.dispatch(view.state.tr.setSelection(selectCell(view.state.doc, 0, 2)))
    transactions.length = 0
    expect(executeEditorCommand(view, { kind: 'table.add-row' })).toBe(true)
    let result = applySourceBlockTransaction(capture.session, transactions[0]!)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.session.source).toBe(headerOnly + '\n|  |  |  |')
    expect(result.session.doc.eq(view.state.doc)).toBe(true)
    expect(executeEditorCommand(view, { kind: 'table.align-column', alignment: 'center' })).toBe(true)
    result = applySourceBlockTransaction(result.session, transactions[1]!)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.session.source).toBe('| A | B | C |\n| --- | :---: | :---: |\n|  |  |  |')
    expect(result.session.doc.eq(view.state.doc)).toBe(true)
  } finally { fixture.destroy() }
})
it('Kit edits/promotes/deletes rows and columns on header-only and normal tables without dropping content', () => {
  for (const raw of [headerOnly, headerOnly + '\n| D | E | F |']) {
    const fixture = makeView(raw)
    try {
      const { view } = fixture
      view.dispatch(view.state.tr.setSelection(selectCell(view.state.doc, 0, 1)))
      const before = view.state.doc
      expect(executeEditorCommand(view, { kind: 'table.add-column' })).toBe(true)
      view.state.doc.firstChild!.forEach(row => expect(row.child(2).attrs).toEqual({ alignment: 'left', colspan: 1, rowspan: 1, colwidth: null }))
      view.state.doc.check()
      view.state.doc.firstChild!.forEach(row => expect(row.childCount).toBe(4))
      expect(executeEditorCommand(view, { kind: 'table.delete-column' })).toBe(true)
      expect(view.state.doc.eq(before)).toBe(true)
      expect(executeEditorCommand(view, { kind: 'table.add-row' })).toBe(true)
      expect(executeEditorCommand(view, { kind: 'table.delete-row' })).toBe(true)
      expect(view.state.doc.eq(before)).toBe(true)
      if (view.state.doc.firstChild!.childCount > 1) {
        view.dispatch(view.state.tr.setSelection(selectCell(view.state.doc, 0, 1)))
        expect(executeEditorCommand(view, { kind: 'table.delete-row' })).toBe(true)
        expect(view.state.doc.firstChild!.firstChild!.firstChild!.textContent).toBe('D')
      }
      const header = view.state
      expect(canExecuteEditorCommand(view, { kind: 'table.delete-row' })).toBe(false)
      expect(executeEditorCommand(view, { kind: 'table.delete-row' })).toBe(false)
      expect(view.state).toBe(header)
    } finally { fixture.destroy() }
  }
})
it('Kit alignment changes every row and preserves untouched columns, colwidth and no-op execution', () => {
  const fixture = makeView(headerOnly + '\n| D | E | F |\n| G | H | I |')
  try {
    const { view, transactions } = fixture
    view.dispatch(view.state.tr.setSelection(selectCell(view.state.doc, 1, 2)))
    const widths = view.state.tr
    view.state.doc.descendants((node, pos) => { if (node.type.name === 'table_header' || node.type.name === 'table_cell') widths.setNodeMarkup(pos, undefined, { ...node.attrs, colwidth: [180] }, node.marks) })
    view.dispatch(widths)
    const before = view.state.doc.firstChild!
    for (const alignment of ['center', 'left', 'right'] as const) {
      const command: EditorCommand = { kind: 'table.align-column', alignment }
      expect(canExecuteEditorCommand(view, command)).toBe(true)
      expect(executeEditorCommand(view, command)).toBe(true)
      const table = view.state.doc.firstChild!
      for (let row = 0; row < table.childCount; row++) {
        expect(table.child(row).child(2).attrs).toEqual({ ...before.child(row).child(2).attrs, alignment })
        for (const col of [0, 1]) expect(table.child(row).child(col).toJSON()).toEqual(before.child(row).child(col).toJSON())
      }
      transactions.length = 0
      const doc = view.state.doc
      expect(executeEditorCommand(view, command)).toBe(true)
      expect(transactions).toHaveLength(1)
      expect(transactions[0]!.steps).toHaveLength(0)
      expect(view.state.doc).toBe(doc)
    }
  } finally { fixture.destroy() }
})
it('Kit filter rejection leaves document/selection/history unchanged, and refuses last-column deletion', () => {
  const fixture = makeView(headerOnly, [history(), new Plugin({ filterTransaction: tr => !tr.docChanged })])
  try {
    const { view } = fixture
    const before = view.state, depth = undoDepth(before)
    expect(canExecuteEditorCommand(view, { kind: 'table.add-row' })).toBe(true)
    expect(executeEditorCommand(view, { kind: 'table.add-row' })).toBe(false)
    expect(executeEditorCommand(view, { kind: 'table.align-column', alignment: 'right' })).toBe(false)
    expect(view.state).toBe(before)
    expect(undoDepth(view.state)).toBe(depth)
    view.updateState(EditorState.create({ doc: parseMarkdown('| A |\n| --- |', schema) }))
    const last = view.state
    expect(canExecuteEditorCommand(view, { kind: 'table.delete-column' })).toBe(false)
    expect(executeEditorCommand(view, { kind: 'table.delete-column' })).toBe(false)
    expect(view.state).toBe(last)
  } finally { fixture.destroy() }
})
it('actual Kit plugin rejects nested-first and merged table Tab without list/space fallback, and middle Tab preserves doc identity', async () => {
  for (const scenario of ['middle', 'nested-first', 'merged']) {
    const raw = scenario === 'nested-first' ? '- Outer\n\n  ' + headerOnly.replaceAll('\n', '\n  ') : headerOnly
    const fixture = await mountKit(raw, scenario)
    try {
      const { view } = fixture
      view.dispatch(view.state.tr.setSelection(selectCell(view.state.doc, 0, scenario === 'middle' ? 1 : 0)))
      if (scenario === 'merged') {
        const pos = view.state.selection.$from.before(3), node = view.state.doc.nodeAt(pos)!
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, colspan: 2 }))
      }
      const before = view.state
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: scenario === 'nested-first' })
      expect(!!view.someProp('handleKeyDown', handler => handler(view, event))).toBe(scenario === 'middle')
      expect(view.state.doc).toBe(before.doc)
      if (scenario !== 'middle') expect(view.state).toBe(before)
    } finally { await fixture.destroy() }
  }
})
it('actual governed Kit history restores add-row/alignment attrs, selection and canonical draft raw', async () => {
  const fixture = await mountKit(headerOnly, 'history')
  try {
    const { view, kit } = fixture
    view.dispatch(view.state.tr.setSelection(selectCell(view.state.doc, 0, 2)))
    const before = view.state, beforeRaw = kit.surface.getDraftMarkdown()
    expect(kit.surface.executeCommand({ kind: 'table.add-row' })).toBe(true)
    const added = view.state
    view.dispatch(closeHistory(view.state.tr))
    expect(kit.surface.executeCommand({ kind: 'table.align-column', alignment: 'center' })).toBe(true)
    const aligned = view.state, alignedRaw = kit.surface.getDraftMarkdown()
    expect(kit.surface.executeCommand({ kind: 'undo' })).toBe(true)
    expect(view.state.doc.eq(added.doc)).toBe(true)
    expect(view.state.selection.eq(added.selection)).toBe(true)
    expect(kit.surface.executeCommand({ kind: 'undo' })).toBe(true)
    expect(view.state.doc.eq(before.doc)).toBe(true)
    expect(view.state.selection.eq(before.selection)).toBe(true)
    expect(kit.surface.getDraftMarkdown()).toBe(beforeRaw)
    expect(kit.surface.executeCommand({ kind: 'redo' })).toBe(true)
    expect(kit.surface.executeCommand({ kind: 'redo' })).toBe(true)
    expect(view.state.doc.eq(aligned.doc)).toBe(true)
    expect(view.state.selection.eq(aligned.selection)).toBe(true)
    expect(kit.surface.getDraftMarkdown()).toBe(alignedRaw)
    expect(serializeMarkdown(view.state.doc)).toContain(':---:')
  } finally { await fixture.destroy() }
})
