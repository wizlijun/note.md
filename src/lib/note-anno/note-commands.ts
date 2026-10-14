import type { EditorView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import type { Transaction } from 'prosemirror-state'
import { noteUi, readThemeStyle } from './note-ui.svelte'

export interface NoteEditAdmission {
  isCurrent(): boolean
  dispatch(tr: Transaction): boolean
}

/** Finish the current popup through its own owner before replacing it. */
export function finishNoteEdit(): boolean {
  const previous = noteUi.edit
  if (!previous) return true
  if (previous.flushDraft?.() === false || noteUi.edit !== previous) return false
  noteUi.edit = null
  return true
}

function dispatchEdit(view: EditorView, tr: Transaction, admission?: NoteEditAdmission): boolean {
  if (admission) return admission.isCurrent() && admission.dispatch(tr)
  view.dispatch(tr)
  requestDocFlush()
  return true
}

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
  window.dispatchEvent(new CustomEvent('notemd:flush-doc'))
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

/** Open the edit bubble for the wrapped annotation containing `pos`.
 *  `caret` (when given) collapses the popup's selection at that offset instead
 *  of selecting all — used by Ask so the seeded `?` survives the first keypress. */
export function openEditForMark(view: EditorView, pos: number, anchor: DOMRect, caret?: number, admission?: NoteEditAdmission) {
  if (!finishNoteEdit() || admission && !admission.isCurrent()) return
  const range = findAnnotationRange(view.state.doc, pos)
  if (!range) return
  noteUi.hover = null
  noteUi.edit = {
    x: anchor.left,
    y: anchor.bottom + 4,
    note: range.note,
    caret,
    style: readThemeStyle(view.dom),
    save(next) {
      if (admission && !admission.isCurrent()) return false
      const r = findAnnotationRange(view.state.doc, pos)
      if (!r) return false
      const type = view.state.schema.marks.annotation
      const clean = sanitizeNote(next)
      if (clean === r.note) return true
      return dispatchEdit(view,
        view.state.tr
          .removeMark(r.from, r.to, type)
          .addMark(r.from, r.to, type.create({ note: clean })), admission,
      )
    },
    remove() {
      if (admission && !admission.isCurrent()) return false
      const r = findAnnotationRange(view.state.doc, pos)
      if (!r) return false
      return dispatchEdit(view, view.state.tr.removeMark(r.from, r.to, view.state.schema.marks.annotation), admission)
    },
  }
  return noteUi.edit
}

/** Open the edit bubble for the note_anchor node at `pos`. (`caret`: see openEditForMark.) */
export function openEditForAnchor(view: EditorView, pos: number, anchor: DOMRect, caret?: number, admission?: NoteEditAdmission) {
  if (!finishNoteEdit() || admission && !admission.isCurrent()) return
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'note_anchor') return
  noteUi.hover = null
  noteUi.edit = {
    x: anchor.left,
    y: anchor.bottom + 4,
    note: node.attrs.note as string,
    caret,
    style: readThemeStyle(view.dom),
    save(next) {
      if (admission && !admission.isCurrent()) return false
      const n = view.state.doc.nodeAt(pos)
      if (!n || n.type.name !== 'note_anchor') return false
      const clean = sanitizeNote(next)
      if (clean === n.attrs.note) return true
      return dispatchEdit(view, view.state.tr.setNodeMarkup(pos, undefined, { note: clean }), admission)
    },
    remove() {
      if (admission && !admission.isCurrent()) return false
      const n = view.state.doc.nodeAt(pos)
      if (!n || n.type.name !== 'note_anchor') return false
      return dispatchEdit(view, view.state.tr.delete(pos, pos + n.nodeSize), admission)
    },
  }
  return noteUi.edit
}

/**
 * Insert-annotation command (rich mode): wraps a non-empty selection with the
 * annotation mark, or inserts a note_anchor at the caret; then opens the edit
 * bubble so the user can type the note immediately.
 *
 * `seed` pre-fills the note — Ask passes `'?'`, which makes the annotation a
 * question from the start; the popup caret then sits before it (offset 0) so
 * typing prepends the question and keeps the `?` as the suffix.
 */
export function insertNoteRich(view: EditorView, seed = '', admission?: NoteEditAdmission, replaceRange?: { from: number; to: number }) {
  if (!finishNoteEdit() || admission && !admission.isCurrent()) return
  const { state } = view
  const tr = state.tr
  if (replaceRange) {
    if (!state.selection.empty || replaceRange.from < 0 || replaceRange.to < replaceRange.from || replaceRange.to > tr.doc.content.size) return
  }
  const { to, empty } = tr.selection
  const from = replaceRange?.from ?? tr.selection.from
  const coords = view.coordsAtPos(state.selection.to)
  const rect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top)
  const caret = seed ? 0 : undefined
  if (empty) {
    const type = state.schema.nodes.note_anchor
    if (!type) return
    const node = type.create({ note: seed })
    if (!dispatchEdit(view, replaceRange ? tr.replaceWith(replaceRange.from, replaceRange.to, node) : tr.replaceSelectionWith(node), admission)) return
    const edit = openEditForAnchor(view, from, rect, caret, admission)
    if (edit) view.focus()
    return edit
  } else {
    const type = state.schema.marks.annotation
    if (!type) return
    if (!dispatchEdit(view, tr.addMark(from, to, type.create({ note: seed })), admission)) return
    const edit = openEditForMark(view, from + 1, rect, caret, admission)
    if (edit) view.focus()
    return edit
  }
}
