import { Slice, type Node as PMNode } from 'prosemirror-model'
import { AllSelection, Plugin, PluginKey, Selection, TextSelection, type Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { selectAllSelection } from './editor-select-all'
import { richBodySelection } from './rich-editor-focus'

const key = new PluginKey('hidden-frontmatter-selection')

/** A metadata-only file has no editable position until the user starts writing. */
class EmptyBodySelection extends Selection {
  constructor(doc: PMNode) {
    const end = doc.resolve(doc.content.size)
    super(end, end)
  }
  visible = false
  map(doc: PMNode): Selection { return richBodySelection(doc) ?? new EmptyBodySelection(doc) }
  eq(other: Selection): boolean { return other instanceof EmptyBodySelection && other.from === this.from }
  replace(tr: Transaction, content = Slice.empty) {
    if (content.size) super.replace(tr, content)
  }
  toJSON() { return { type: 'notemd-empty-rich-body' } }
  static fromJSON(doc: PMNode): Selection { return richBodySelection(doc) ?? new EmptyBodySelection(doc) }
  getBookmark() { return emptyBodyBookmark }
}
const emptyBodyBookmark = {
  map() { return this },
  resolve(doc: PMNode): Selection { return EmptyBodySelection.fromJSON(doc) },
}
Selection.jsonID('notemd-empty-rich-body', EmptyBodySelection)

function correctedSelection(doc: PMNode, selection: Selection): Selection | null {
  const first = doc.firstChild
  if (first?.type.name !== 'frontmatter') return null
  const body = richBodySelection(doc)
  if (!body) return selection instanceof EmptyBodySelection ? null : new EmptyBodySelection(doc)
  if (selection.from >= first.nodeSize) return null
  if (selection instanceof AllSelection) return selectAllSelection(doc)
  if (!(selection instanceof TextSelection)) return body
  return TextSelection.between(
    doc.resolve(Math.max(body.from, selection.anchor)),
    doc.resolve(Math.max(body.from, selection.head)),
  )
}

/** Only desktop rich mounts that hide metadata install this plugin. */
export function hiddenFrontmatterSelectionPlugin(options: {
  ensureBody?: (view: EditorView) => void
} = {}): Plugin {
  return new Plugin({
    key,
    appendTransaction(_transactions, _oldState, state) {
      const selection = correctedSelection(state.doc, state.selection)
      return selection ? state.tr.setSelection(selection).setMeta('addToHistory', false) : null
    },
    props: {
      handleDOMEvents: {
        focus(view) {
          if (view.editable && view.state.doc.firstChild?.type.name === 'frontmatter' && !richBodySelection(view.state.doc)) {
            options.ensureBody?.(view)
          }
          return false
        },
        keydown(view, event) {
          if (event.isComposing || event.keyCode === 229 || view.composing || event.key !== 'Backspace') return false
          const { doc, selection } = view.state
          const first = doc.firstChild
          if (first?.type.name !== 'frontmatter' || !selection.empty) return false
          const { $from } = selection
          // Nested list/quote commands must still be allowed to lift their own
          // structure; only a top-level body block can cross into metadata.
          if (selection instanceof EmptyBodySelection ||
              $from.depth === 1 && $from.parentOffset === 0 && $from.before() === first.nodeSize) {
            event.preventDefault()
            return true
          }
          return false
        },
      },
    },
    view(view) {
      let destroyed = false
      // A file owner binds the view after createEditor returns. Defer the
      // initial selection-only correction until that binding is available.
      queueMicrotask(() => {
        if (destroyed || view.isDestroyed) return
        const selection = correctedSelection(view.state.doc, view.state.selection)
        if (selection) view.dispatch(view.state.tr.setSelection(selection).setMeta('addToHistory', false))
      })
      return { destroy() { destroyed = true } }
    },
  })
}
