// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { createSchema, parseMarkdown } from '@moraya/core'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { createRichActions } from './rich-actions'
import { getSlashItems } from '../slash-menu/slash-items'

for (const entry of ['context', 'slash']) it(`actual Rich ${entry} inserts a table and selects its first header`, async () => {
  const schema = createSchema({ mediaResolver: {
    loadLocalImage: async p => p, loadLocalMedia: async p => p, loadRemoteMedia: async p => p,
  } })
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  const view = new EditorView(mount, { state: EditorState.create({ doc: parseMarkdown('', schema) }) })
  try {
    if (entry === 'context') await createRichActions(view).run('table')
    else getSlashItems().find(item => item.id === 'table')!.execute(view)
    const table = view.state.doc.firstChild!
    expect(table.type).toBe(schema.nodes.table)
    expect(table.childCount).toBe(3)
    expect(view.state.selection.$from.index(1)).toBe(0)
    expect(view.state.selection.$from.index(2)).toBe(0)
  } finally { view.destroy(); mount.remove() }
})

import { TextSelection } from 'prosemirror-state'
import { getMenuModel } from './menu-model'
import { createSourceActions } from './source-actions'
it('actual Rich alignment action updates the whole column and Source never advertises it', async () => {
  const schema = createSchema({ mediaResolver: { loadLocalImage: async p => p, loadLocalMedia: async p => p, loadRemoteMedia: async p => p } })
  const view = new EditorView(document.body, { state: EditorState.create({ doc: parseMarkdown('| A | B | C |\n| --- | :---: | ---: |\n| D | E | F |\n| G | H | I |', schema) }) })
  try {
    let at = 0
    view.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'F') at = pos })
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
    const actions = createRichActions(view)
    expect(actions.canRun('table-align-center')).toBe(true)
    await actions.run('table-align-center')
    for (let row = 0; row < 3; row++) expect(view.state.doc.firstChild!.child(row).child(2).attrs.alignment).toBe('center')
    const outside = EditorState.create({ doc: parseMarkdown('outside', schema) })
    view.updateState(outside)
    expect(actions.canRun('table-align-center')).toBe(false)
    const source = createSourceActions({ el: document.createElement('textarea'), tabId: 'table-fixture', value: () => '' })
    for (const id of ['table-align-left', 'table-align-center', 'table-align-right']) expect(source.canRun(id)).toBe(false)
  } finally { view.destroy() }
})
it('menu model exposes alignment only in a table and keeps image/read-only early returns', () => {
  const ids = (context: Parameters<typeof getMenuModel>[0]) => getMenuModel(context).flatMap(group => group.items.flatMap(item => [item.id, ...(item.children ?? []).map(child => child.id)]))
  expect(ids({ hasSelection: false, table: true })).toContain('table-align-center')
  expect(ids({ hasSelection: false })).not.toContain('table-align-center')
  expect(ids({ hasSelection: false, table: true, readOnly: true })).not.toContain('table-align-center')
  expect(ids({ hasSelection: false, table: true, image: true })).not.toContain('table-align-center')
})
