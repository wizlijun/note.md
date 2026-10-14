/** @vitest-environment happy-dom */
import { afterEach, expect, it } from 'vitest'
import { BrowserMediaResolver } from '@moraya/core/adapters/browser-media-resolver'
import { TextSelection } from 'prosemirror-state'
import { mountFileEditor, type FileMountSession } from '../editor-kit-v2/file-main'
import { observeFileHistoryRoute, routeFileHistory, type FileHistoryRoute } from './file-history-focus'

const mounts: FileMountSession[] = []
afterEach(async () => { for (const m of mounts.splice(0)) await m.owner.close(); document.body.replaceChildren() })
async function open() {
  const target = document.createElement('div'); document.body.append(target)
  const m = await mountFileEditor(target, { file: { documentId: 'focus', authority: 'A', raw: 'Alpha' }, adapters: { mediaResolver: new BrowserMediaResolver() } }, {})
  mounts.push(m); return { m, target }
}
it('real rich owner survives menu/body blur, routes once, and ordinary input restores fallback', async () => {
  const { m } = await open(); let route!: FileHistoryRoute
  const stop = observeFileHistoryRoute(value => { route = value })
  try {
    m.focus(); m.view.dispatch(m.view.state.tr.insertText('X', 3)); await Promise.resolve()
    expect(route).toEqual({ active: true, canUndo: true, canRedo: false })
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, 2, 4)))
    document.dispatchEvent(new Event('selectionchange'))
    m.view.dom.blur(); document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(routeFileHistory('undo')).toBe(true); expect(m.owner.snapshot().raw).toBe('Alpha')
    expect(routeFileHistory('redo')).toBe(true); expect(m.owner.snapshot().raw).toBe('AlXpha')
    const input = document.createElement('input'); document.body.append(input); input.focus()
    expect(route.active).toBe(false); expect(routeFileHistory('undo')).toBe(false)
    m.focus(); await m.owner.close(); expect(route.active).toBe(false)
  } finally { stop() }
})
it('same owner source/rich switches selection kind and never resolves stale rich bookmark', async () => {
  const { m, target } = await open(); m.focus()
  m.view.dispatch(m.view.state.tr.insertText('X', 2)); await Promise.resolve()
  await m.setMode('source'); const textarea = target.querySelector('textarea')!; textarea.focus(); textarea.setSelectionRange(1, 3); textarea.dispatchEvent(new Event('select'))
  textarea.blur(); expect(routeFileHistory('undo')).toBe(true); expect(m.owner.snapshot().raw).toBe('Alpha')
  await Promise.resolve(); expect(textarea.selectionStart).toBe(1); expect(textarea.selectionEnd).toBe(3)
  await m.setMode('rich'); m.focus()
  m.owner.installBaseline({ documentId: 'new', authority: 'A', raw: 'Z' })
  expect(routeFileHistory('undo')).toBe(false); expect(m.owner.snapshot().raw).toBe('Z')
})
it('composition and rejected source pending block native route through actual owner', async () => {
  const { m, target } = await open(); m.focus(); m.owner.restoreContent('B'); await Promise.resolve()
  m.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  expect(routeFileHistory('undo')).toBe(false)
  m.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); await m.owner.flush()
  await m.setMode('source'); const textarea = target.querySelector('textarea')!; textarea.focus()
  m.owner.setReadOnly(true); textarea.value = 'Unaccepted'; textarea.dispatchEvent(new Event('input', { bubbles: true }))
  expect(routeFileHistory('undo')).toBe(false); expect(textarea.value).toBe('Unaccepted')
  m.owner.setReadOnly(false)
  // Explicit discard is required; detach keeps the pending text for its owner.
  m.destroyView()
  expect(routeFileHistory('undo')).toBe(false)
  const source = m.attachSource(textarea); source.discard()
})
