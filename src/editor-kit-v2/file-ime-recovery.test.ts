/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (s: string) => s }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'macos', type: () => 'macos' }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }))
import { BrowserMediaResolver } from '@moraya/core/adapters/browser-media-resolver'
import { mountFileEditor, type FileMountSession } from './file-main'
import { createImeGuard } from '../lib/ime'

const sessions: FileMountSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) { session.destroyView(); await session.owner.close() }
  document.body.replaceChildren()
})
async function setup() {
  const target = document.createElement('div'); document.body.append(target)
  const ime = createImeGuard()
  const session = await mountFileEditor(target, {
    file: { documentId: 'ime-recovery', authority: 'a', raw: 'A' },
    adapters: { mediaResolver: new BrowserMediaResolver() },
  }, { styles: 'host', imeGuard: ime })
  sessions.push(session)
  return { session, ime, target }
}
const microtasks = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await microtasks() }
function start(session: FileMountSession, text = '中') {
  session.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  session.view.dispatch(session.view.state.tr.insertText(text, session.view.state.doc.content.size - 1).setMeta('composition', 1))
}

it.each(['mousedown', 'contextmenu', 'touchstart'])('reconciles owner and keyboard gates when PM ends composition on %s', async gesture => {
  const { session, ime, target } = await setup()
  start(session)
  expect(session.view.composing).toBe(true)
  expect(session.owner.canUndo()).toBe(false)
  let flushed: string | undefined
  void session.owner.flush().then(value => { flushed = value.raw }).catch(() => {})
  // PM flushes before hit testing; the DOM test has no browser layout.
  vi.spyOn(session.view, 'posAtCoords').mockReturnValue(null)
  session.view.dom.dispatchEvent(new MouseEvent(gesture, { bubbles: true, cancelable: true }))
  expect(session.view.composing).toBe(false)
  await settle()
  expect(flushed).toBe('A中')
  expect(ime.blocks(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false)
  expect(session.owner.canUndo()).toBe(true)
  expect(await session.setMode('source')).toBe(true)
  expect(target.querySelector('textarea')?.value).toBe('A中')
  await session.closeIfSaved({ identity: session.baselineIdentity, raw: 'A中' })
  expect(target.querySelector('.file-editor')).toBeNull()
})

it('keeps native composition gated when a gesture does not reach PM', async () => {
  const { session, ime } = await setup()
  start(session)
  let flushed = false
  void session.owner.flush().then(() => { flushed = true }).catch(() => {})
  session.view.dom.addEventListener('contextmenu', event => event.stopImmediatePropagation(), { capture: true, once: true })
  session.view.dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
  await settle()
  expect(session.view.composing).toBe(true)
  expect(flushed).toBe(false)
  expect(session.owner.canUndo()).toBe(false)
  expect(ime.blocks(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
  session.view.dispatch(session.view.state.tr.insertText('文', 3).setMeta('composition', 1))
  session.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  expect((await session.owner.flush()).raw).toBe('A中文')
})

it('an older gesture cannot unlock a newer composition even when PM resets its stored marks', async () => {
  const { session } = await setup()
  start(session)
  session.view.dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
  start(session, '文')
  session.view.dispatch(session.view.state.tr.setStoredMarks([session.view.state.schema.marks.strong.create()]))
  expect(session.view.composing).toBe(false)
  let flushed = false
  void session.owner.flush().then(() => { flushed = true }).catch(() => {})
  await settle()
  expect(flushed).toBe(false)
  expect(session.owner.canUndo()).toBe(false)
  session.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  expect((await session.owner.flush()).raw).toBe('A中文')
})

it('preserves the delivered compositionend frame and its final text', async () => {
  const { session } = await setup()
  start(session)
  let frame!: FrameRequestCallback
  const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frame = callback; return 1 })
  try {
    session.view.dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    session.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    let flushed: string | undefined
    void session.owner.flush().then(value => { flushed = value.raw }).catch(() => {})
    await settle()
    expect(flushed).toBeUndefined()
    session.view.dispatch(session.view.state.tr.insertText('文', 3).setMeta('composition', 1))
    frame(0); await settle()
    expect(flushed).toBe('A中文')
  } finally { raf.mockRestore() }
})

it('unblocks the actual dirty tab close and preserves its flushed draft for confirmation', async () => {
  const { tabs, activeId, closeTab } = await import('../lib/tabs.svelte')
  const { registerFileEditorSession, closeFileEditorSession, fileEditorSession } = await import('../lib/file-editor-sessions')
  const { session } = await setup(), id = 'ime-close-regression'
  tabs.push({ id, filePath: '/isolated/ime-close.md', title: 'ime-close.md', kind: 'markdown', mode: 'rich',
    initialContent: 'A', currentContent: 'A', externalState: 'fresh', externalBannerDismissed: false,
    lastKnownMtime: 0, lastKnownHash: '' })
  activeId.value = id; registerFileEditorSession(id, session)
  try {
    start(session)
    const confirm = vi.fn(async () => {
      expect(tabs.find(tab => tab.id === id)?.currentContent).toBe('A中')
      return 'discard' as const
    })
    const closing = closeTab(id, confirm)
    await settle(); expect(confirm).not.toHaveBeenCalled()
    session.view.dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    await expect(closing).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledOnce()
    expect(tabs.some(tab => tab.id === id)).toBe(false)
    expect(fileEditorSession(id)).toBeUndefined()
  } finally { session.destroyView(); await closeFileEditorSession(id); tabs.splice(0); activeId.value = null }
})

it('recovers when the browser performs a microtask checkpoint between capture and PM handlers', async () => {
  // Native event dispatch can run microtasks between listeners; dispatchEvent()
  // from one JS stack cannot reproduce that checkpoint, so split these phases.
  const add = vi.spyOn(HTMLElement.prototype, 'addEventListener')
  const { session, target } = await setup()
  const rich = target.querySelector<HTMLElement>('.file-rich')!
  const at = add.mock.calls.findIndex((args, index) => add.mock.contexts[index] === rich && args[0] === 'contextmenu' && args[2] === true)
  const capture = add.mock.calls[at][1] as EventListener
  add.mockRestore()
  rich.removeEventListener('contextmenu', capture, true)
  start(session)
  let flushed: string | undefined
  void session.owner.flush().then(value => { flushed = value.raw }).catch(() => {})
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'target', { value: session.view.dom })
  capture.call(rich, event)
  await microtasks()
  expect(session.view.composing).toBe(true)
  expect(flushed).toBeUndefined()
  session.view.dom.dispatchEvent(event)
  expect(session.view.composing).toBe(false)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(flushed).toBe('A中')
})
