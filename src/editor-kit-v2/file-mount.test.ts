/** @vitest-environment happy-dom */
import { afterEach, expect, it } from 'vitest'
import { EditorView } from 'prosemirror-view'
import { open } from './file-test-utils'
import { openEditForAnchor, openEditForMark, insertNoteRich } from '../lib/note-anno/note-commands'
import { noteUi } from '../lib/note-anno/note-ui.svelte'

const views: EditorView[] = []
afterEach(() => { noteUi.edit = null; views.splice(0).forEach(v => v.destroy()); document.body.replaceChildren() })
function annotated(raw: string, allowed = true) {
  const controller = open(raw, [], undefined, { acceptRawChange: () => allowed })
  const target = document.createElement('div'); document.body.append(target)
  const view = new EditorView(target, { state: controller.state, dispatchTransaction: tr => { controller.dispatch(tr) } })
  views.push(view); controller.bindView(view)
  return { view, controller, admission: { isCurrent: () => true, dispatch: controller.dispatch } }
}
const mark = openEditForMark
const anchor = openEditForAnchor

it.each(['mark', 'anchor'])('annotation %s save/remove reports policy rejection and never sends legacy flush', kind => {
  const f = annotated(kind === 'mark' ? '{==A==}{>>old<<}\n' : '{>>old<<}\n', false)
  let flushes = 0
  const listener = () => flushes++
  window.addEventListener('notemd:flush-doc', listener)
  try {
    ;(kind === 'mark' ? mark : anchor)(f.view, 1, new DOMRect(), undefined, f.admission)
    expect(noteUi.edit?.save('new')).toBe(false)
    expect(noteUi.edit?.remove()).toBe(false)
    expect(f.controller.snapshot().raw).toBe(kind === 'mark' ? '{==A==}{>>old<<}\n' : '{>>old<<}\n')
    expect(flushes).toBe(0)
  } finally { window.removeEventListener('notemd:flush-doc', listener) }
})

it('checks annotation admission before a matching-text no-op and returns the actual shared popup object', () => {
  const f = annotated('{==A==}{>>old<<}\n')
  const opened = mark(f.view, 1, new DOMRect(), undefined, { ...f.admission, isCurrent: () => false })
  expect(opened).toBeUndefined()
  expect(noteUi.edit).toBeNull()
  const current = mark(f.view, 1, new DOMRect(), undefined, f.admission)
  expect(current === noteUi.edit).toBe(true)
  expect(noteUi.edit?.save('old')).toBe(true)
})

it('does not replace or insert over a previous popup whose draft cannot flush', () => {
  const f = annotated('A\n')
  noteUi.edit = { x: 0, y: 0, note: 'blocked', save() {}, remove() {}, flushDraft: () => false }
  const previous = noteUi.edit
  insertNoteRich(f.view, 'new')
  expect(noteUi.edit === previous).toBe(true)
  expect(f.controller.snapshot().raw).toBe('A\n')
})

it('accepts one actual ReplaceStep for the trigger and empty annotation', () => {
  const f = annotated('/note\n')
  const tr = f.view.state.tr.replaceWith(1, 6, f.view.state.schema.nodes.note_anchor.create({ note: '' }))
  const accepted = f.controller.dispatch(tr)
  expect(accepted, String(f.controller.diagnostic)).toBe(true)
})
