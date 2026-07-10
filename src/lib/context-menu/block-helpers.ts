import type { EditorView } from 'prosemirror-view'
import { setBlockType, wrapIn } from 'prosemirror-commands'
import { wrapInList } from 'prosemirror-schema-list'

export function setBlock(v: EditorView, typeName: string, attrs?: Record<string, unknown>) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return
  setBlockType(type, attrs)(v.state, v.dispatch)
  v.focus()
}

export function wrapBlock(v: EditorView, typeName: string) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return
  wrapIn(type)(v.state, v.dispatch)
  v.focus()
}

export function wrapList(v: EditorView, typeName: string) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return
  wrapInList(type)(v.state, v.dispatch)
  v.focus()
}

export function insertAtom(v: EditorView, typeName: string, attrs?: Record<string, unknown>) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return
  v.dispatch(v.state.tr.replaceSelectionWith(type.create(attrs ?? {})).scrollIntoView())
  v.focus()
}

export function insertTable(v: EditorView) {
  const { schema } = v.state
  const { table, table_header_row, table_row, table_header, table_cell, paragraph } = schema.nodes
  if (!table || !table_header_row || !table_row || !table_header || !table_cell || !paragraph) return
  const rows = 3, cols = 3
  const emptyPara  = () => paragraph.createAndFill()!
  const headerCell = () => table_header.createAndFill({ alignment: 'left' }, [emptyPara()])!
  const bodyCell   = () => table_cell.createAndFill(  { alignment: 'left' }, [emptyPara()])!
  const tableNode = table.create(null, [
    table_header_row.create(null, Array.from({ length: cols }, headerCell)),
    ...Array.from({ length: rows - 1 }, () =>
      table_row.create(null, Array.from({ length: cols }, bodyCell))),
  ])
  v.dispatch(v.state.tr.replaceSelectionWith(tableNode).scrollIntoView())
  v.focus()
}

export function insertTaskList(v: EditorView) {
  const { schema } = v.state
  const bulletList = schema.nodes.bullet_list
  const listItem   = schema.nodes.list_item
  if (!bulletList || !listItem) return
  if (!wrapInList(bulletList)(v.state, v.dispatch)) return
  const { doc, selection } = v.state
  const $from = doc.resolve(selection.from)
  let listDepth = -1
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type === bulletList) { listDepth = d; break }
  }
  if (listDepth < 0) { v.focus(); return }
  const listStart = $from.before(listDepth)
  const listEnd   = listStart + $from.node(listDepth).nodeSize
  const tr = v.state.tr
  doc.nodesBetween(listStart, listEnd, (node, pos) => {
    if (node.type === listItem && node.attrs.checked === null) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false })
    }
  })
  if (tr.docChanged) v.dispatch(tr)
  v.focus()
}
