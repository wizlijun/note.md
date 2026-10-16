import type { Node as PMNode } from 'prosemirror-model'
import { Selection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { FileEditorOwner } from '../editor-kit-v2/file-contract'

/** Frontmatter is a textblock in the schema, but its NodeView is not a writing surface. */
export function richBodySelection(doc: PMNode, atEnd = false): Selection | null {
  const start = doc.firstChild?.type.name === 'frontmatter' ? doc.firstChild.nodeSize : 0
  const selection = Selection.findFrom(doc.resolve(atEnd ? doc.content.size : start), atEnd ? -1 : 1)
  return selection?.$from.parent.type.name === 'frontmatter' ? null : selection
}

/** Give metadata-only notes a real body before placing the caret. */
export function focusRichBodyEnd(view: EditorView, owner?: FileEditorOwner): boolean {
  if (view.isDestroyed || !view.editable) return false
  let selection = richBodySelection(view.state.doc, true)
  if (!selection) {
    if (owner) {
      const snapshot = owner.snapshot()
      const eol = snapshot.raw.match(/\r\n|\r|\n/)?.[0] ?? '\n'
      const value = snapshot.raw + eol.repeat(/[\r\n]$/.test(snapshot.raw) ? 1 : 2)
      if (!owner.replaceSource({ expectedGeneration: snapshot.generation, value }).ok) return false
    } else {
      view.dispatch(view.state.tr.insert(view.state.doc.content.size, view.state.schema.nodes.paragraph.create()))
    }
    selection = richBodySelection(view.state.doc, true)
  }
  if (!selection) return false
  view.dispatch(view.state.tr.setSelection(selection))
  if (!view.state.selection.eq(selection)) return false
  view.focus()
  return true
}
