import type { EditorView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { noteUi, readThemeStyle } from './note-ui.svelte'

/**
 * Clean a note string so it cannot break out of its CriticMarkup container:
 * newlines end the inline run, a literal `<<}` would close it early.
 * (moraya-core sanitizes again on serialize — this keeps the doc clean too.)
 */
export function sanitizeNote(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/<<\}/g, '< <}')
}

/**
 * Ask the host editor to push the doc into the tab right away, skipping
 * moraya's 500 ms lazy-change debounce — the outline panel derives from
 * tab content, so annotation edits would otherwise lag behind.
 */
function requestDocFlush() {
  window.dispatchEvent(new CustomEvent('mdeditor:flush-doc'))
}

/**
 * Find the contiguous inline range carrying the annotation mark that spans
 * `pos` (inclusive of both boundaries). Adjacent runs with different note
 * texts are treated as separate annotations.
 */
export function findAnnotationRange(
  doc: PMNode, pos: number,
): { from: number; to: number; note: string } | null {
  const $pos = doc.resolve(pos)
  const parent = $pos.parent
  if (!parent.isTextblock) return null
  const base = $pos.start()
  let runStart = -1
  let runEnd = -1
  let runNote = ''
  let result: { from: number; to: number; note: string } | null = null
  const flush = () => {
    if (!result && runStart >= 0 && pos >= runStart && pos <= runEnd) {
      result = { from: runStart, to: runEnd, note: runNote }
    }
    runStart = -1
  }
  parent.forEach((child, offset) => {
    const mark = child.marks.find((m) => m.type.name === 'annotation')
    if (mark) {
      const note = mark.attrs.note as string
      if (runStart < 0 || note !== runNote) { flush(); runStart = base + offset; runNote = note }
      runEnd = base + offset + child.nodeSize
    } else {
      flush()
    }
  })
  flush()
  return result
}

/** Open the edit bubble for the wrapped annotation containing `pos`. */
export function openEditForMark(view: EditorView, pos: number, anchor: DOMRect) {
  const range = findAnnotationRange(view.state.doc, pos)
  if (!range) return
  noteUi.hover = null
  noteUi.edit = {
    x: anchor.left,
    y: anchor.bottom + 4,
    note: range.note,
    style: readThemeStyle(view.dom),
    save(next) {
      const r = findAnnotationRange(view.state.doc, pos)
      if (!r) return
      const type = view.state.schema.marks.annotation
      const clean = sanitizeNote(next)
      if (clean === r.note) return
      view.dispatch(
        view.state.tr
          .removeMark(r.from, r.to, type)
          .addMark(r.from, r.to, type.create({ note: clean })),
      )
      requestDocFlush()
    },
    remove() {
      const r = findAnnotationRange(view.state.doc, pos)
      if (!r) return
      view.dispatch(view.state.tr.removeMark(r.from, r.to, view.state.schema.marks.annotation))
      requestDocFlush()
    },
  }
}

/** Open the edit bubble for the note_anchor node at `pos`. */
export function openEditForAnchor(view: EditorView, pos: number, anchor: DOMRect) {
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'note_anchor') return
  noteUi.hover = null
  noteUi.edit = {
    x: anchor.left,
    y: anchor.bottom + 4,
    note: node.attrs.note as string,
    style: readThemeStyle(view.dom),
    save(next) {
      const n = view.state.doc.nodeAt(pos)
      if (!n || n.type.name !== 'note_anchor') return
      const clean = sanitizeNote(next)
      if (clean === n.attrs.note) return
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { note: clean }))
      requestDocFlush()
    },
    remove() {
      const n = view.state.doc.nodeAt(pos)
      if (!n || n.type.name !== 'note_anchor') return
      view.dispatch(view.state.tr.delete(pos, pos + n.nodeSize))
      requestDocFlush()
    },
  }
}

/**
 * Insert-annotation command (rich mode): wraps a non-empty selection with the
 * annotation mark, or inserts a note_anchor at the caret; then opens the edit
 * bubble so the user can type the note immediately.
 */
export function insertNoteRich(view: EditorView) {
  const { state } = view
  const { from, to, empty } = state.selection
  const coords = view.coordsAtPos(to)
  const rect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top)
  if (empty) {
    const type = state.schema.nodes.note_anchor
    if (!type) return
    view.dispatch(state.tr.replaceSelectionWith(type.create({ note: '' })))
    requestDocFlush()
    openEditForAnchor(view, from, rect)
  } else {
    const type = state.schema.marks.annotation
    if (!type) return
    view.dispatch(state.tr.addMark(from, to, type.create({ note: '' })))
    requestDocFlush()
    openEditForMark(view, from + 1, rect)
  }
  view.focus()
}
