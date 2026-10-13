import { gfmTableCommand } from '@moraya/core/commands'
import type { SlashCommandTarget } from '../slash-menu/slash-command'
import { setBlockType, wrapIn } from 'prosemirror-commands'
import { wrapInList } from 'prosemirror-schema-list'

export function setBlock(v: SlashCommandTarget, typeName: string, attrs?: Record<string, unknown>) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return false
  if (!setBlockType(type, attrs)(v.state, v.dispatch)) return false
  v.focus()
  return true
}

export function wrapBlock(v: SlashCommandTarget, typeName: string) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return false
  if (!wrapIn(type)(v.state, v.dispatch)) return false
  v.focus()
  return true
}

export function wrapList(v: SlashCommandTarget, typeName: string) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return false
  if (!wrapInList(type)(v.state, v.dispatch)) return false
  v.focus()
  return true
}

export function insertAtom(v: SlashCommandTarget, typeName: string, attrs?: Record<string, unknown>) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return false
  v.dispatch(v.state.tr.replaceSelectionWith(type.create(attrs ?? {})).scrollIntoView())
  v.focus()
  return true
}

export function insertTable(v: SlashCommandTarget) {
  if (!gfmTableCommand({ kind: 'insert' })(v.state, v.dispatch)) return false
  v.focus()
  return true
}

export function insertTaskList(v: SlashCommandTarget) {
  const { schema } = v.state
  const bulletList = schema.nodes.bullet_list
  const listItem   = schema.nodes.list_item
  if (!bulletList || !listItem) return false
  if (!wrapInList(bulletList)(v.state, v.dispatch)) return false
  const { doc, selection } = v.state
  const $from = doc.resolve(selection.from)
  let listDepth = -1
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type === bulletList) { listDepth = d; break }
  }
  if (listDepth < 0) return false
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
  return true
}
