import { gfmTableCommand } from '@moraya/core/commands'
import { lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands'
import { liftListItem, sinkListItem, wrapInList } from 'prosemirror-schema-list'
import { type Command, type EditorState, type Transaction } from 'prosemirror-state'
import type { Node as PmNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import type { EditorCommand } from './contract'
import { governedRedo, governedUndo } from './governed-history'

const marks: Record<string, string> = {
  bold: 'strong', italic: 'em', strikethrough: 'strike_through', code: 'code', highlight: 'highlight',
}

function children(node: PmNode): PmNode[] {
  const result: PmNode[] = []
  node.forEach((child) => result.push(child))
  return result
}

function safeAddress(value: string): boolean {
  const address = value.trim()
  if (!address || /[\u0000-\u001f\u007f]/.test(value)) return false
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(address)?.[1]
  return !scheme || /^(https?|mailto|tel)$/i.test(scheme)
}

export function commandFor(command: EditorCommand, state: EditorState, history?: { undo: Command; redo: Command }): Command | null {
  const { nodes, marks: schemaMarks } = state.schema
  const mark = schemaMarks[marks[command.kind]]
  if (mark) return toggleMark(mark)
  switch (command.kind) {
    case 'table': return gfmTableCommand({ kind: 'insert' })
    case 'table.add-row': return gfmTableCommand({ kind: 'add-row' })
    case 'table.delete-row': return gfmTableCommand({ kind: 'delete-row' })
    case 'table.add-column': return gfmTableCommand({ kind: 'add-column' })
    case 'table.delete-column': return gfmTableCommand({ kind: 'delete-column' })
    case 'table.next-cell': return gfmTableCommand({ kind: 'next-cell' })
    case 'table.previous-cell': return gfmTableCommand({ kind: 'previous-cell' })
    case 'table.align-column': return gfmTableCommand({ kind: 'align-column', alignment: command.alignment })
    case 'undo': return history?.undo ?? governedUndo
    case 'redo': return history?.redo ?? governedRedo
    case 'paragraph': return nodes.paragraph ? setBlockType(nodes.paragraph) : null
    case 'heading': return nodes.heading ? setBlockType(nodes.heading, { level: command.level }) : null
    case 'code-block': return nodes.code_block ? setBlockType(nodes.code_block, { language: '' }) : null
    case 'blockquote': {
      if (!nodes.blockquote) return null
      const { $from } = state.selection
      for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type === nodes.blockquote) return lift
      return wrapIn(nodes.blockquote)
    }
    case 'indent': return nodes.list_item ? sinkListItem(nodes.list_item) : null
    case 'outdent': return nodes.list_item ? liftListItem(nodes.list_item) : null
    case 'bullet-list': case 'ordered-list': case 'task-list': {
      const type = command.kind === 'ordered-list' ? nodes.ordered_list : nodes.bullet_list
      if (!type || !nodes.list_item) return null
      return (current, dispatch) => {
        const { $from } = current.selection
        for (let depth = $from.depth; depth > 0; depth--) {
          const list = $from.node(depth)
          if (list.type !== nodes.bullet_list && list.type !== nodes.ordered_list) continue
          const isTask = children(list).every((item) => item.attrs.checked !== null)
          const wantTask = command.kind === 'task-list'
          if (list.type === type && isTask === wantTask) return liftListItem(nodes.list_item)(current, dispatch)
          if (!dispatch) return true
          const tr = current.tr
          if (list.type !== type) tr.setNodeMarkup($from.before(depth), type)
          // Only this list's direct items change. Nested task lists keep their
          // own checked state when the parent switches style.
          let position = $from.before(depth) + 1
          list.forEach((item) => {
            tr.setNodeMarkup(position, undefined, { ...item.attrs, checked: wantTask ? false : null })
            position += item.nodeSize
          })
          dispatch(tr)
          return true
        }
        if (!wrapInList(type)(current)) return false
        if (!dispatch) return true
        return wrapInList(type)(current, (tr) => {
          if (command.kind === 'task-list') {
            const start = tr.selection.$from
            for (let depth = start.depth; depth > 0; depth--) {
              if (start.node(depth).type !== type) continue
              tr.doc.nodesBetween(start.before(depth), start.after(depth), (node, pos) => {
                if (node.type === nodes.list_item) tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false })
              })
              break
            }
          }
          dispatch(tr)
        })
      }
    }
    case 'horizontal-rule': return nodes.horizontal_rule ? (current, dispatch) => {
      if (dispatch) dispatch(current.tr.replaceSelectionWith(nodes.horizontal_rule.create()).scrollIntoView())
      return true
    } : null
    case 'unlink': return schemaMarks.link ? (current, dispatch) => {
      const { from, to } = current.selection
      if (from === to || !current.doc.rangeHasMark(from, to, schemaMarks.link)) return false
      if (dispatch) dispatch(current.tr.removeMark(from, to, schemaMarks.link))
      return true
    } : null
    case 'link': return schemaMarks.link && safeAddress(command.href) ? (current, dispatch) => {
      if (!dispatch) return true
      const { from, to } = current.selection
      const tr = current.tr
      if (from === to) {
        const text = command.text?.trim() || command.href.trim()
        tr.insertText(text, from, to).addMark(from, from + text.length, schemaMarks.link.create({ href: command.href.trim() }))
      } else tr.addMark(from, to, schemaMarks.link.create({ href: command.href.trim() }))
      dispatch(tr.scrollIntoView())
      return true
    } : null
    case 'image': return nodes.image && safeAddress(command.src) ? (current, dispatch) => {
      if (dispatch) dispatch(current.tr.replaceSelectionWith(nodes.image.create({ src: command.src.trim(), alt: command.alt ?? '' })).scrollIntoView())
      return true
    } : null
    default: return null
  }
}

/** A probe never receives dispatch and cannot change the document or selection. */
export function canExecuteEditorCommand(view: EditorView, command: EditorCommand): boolean {
  return commandFor(command, view.state)?.(view.state) ?? false
}

export function executeEditorCommand(view: EditorView, command: EditorCommand): boolean {
  const before = view.state
  let transaction: Transaction | undefined
  const handled = commandFor(command, before)?.(before, (tr) => { transaction = tr }, view) ?? false
  if (!handled || !transaction) return false
  view.dispatch(transaction)
  if (view.state === before) return false
  view.focus()
  return true
}
