/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (s: string) => s }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'macos', type: () => 'macos' }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }))
import { BrowserMediaResolver } from '@moraya/core/adapters/browser-media-resolver'
import { mountFileEditor, type FileMountSession, type FileMountWiring } from './file-main'
import { attachFileSourceInput } from './file-source-input'
import { open } from './file-test-utils'
import { noteUi } from '../lib/note-anno/note-ui.svelte'
import { FILE_INPUT_WAIT_MS, FileInputBlockedError } from './file-input-error'

const sessions: FileMountSession[] = []
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); noteUi.edit = null
  for (const session of sessions.splice(0)) { session.destroyView(); await session.owner.close() }
  document.body.replaceChildren()
})
async function setup(wiring: FileMountWiring = {}) {
  const target = document.createElement('div'); document.body.append(target)
  const session = await mountFileEditor(target, {
    file: { documentId: 'flush-blocking', authority: 'a', raw: 'A' },
    adapters: { mediaResolver: new BrowserMediaResolver() },
  }, { styles: 'host', ...wiring })
  sessions.push(session)
  return { session, target }
}
function sourceFixture() {
  const controller = open('A')
  const owner = { snapshot: controller.snapshot, replaceSource: controller.replaceSource, observe: controller.observe,
    undo: () => controller.runHistory('undo', true), redo: () => controller.runHistory('redo', true) }
  const textarea = document.createElement('textarea'); document.body.append(textarea)
  const input = attachFileSourceInput(textarea, owner, { onCompositionChange: controller.setComposing })
  return { controller, owner, textarea, input }
}

it('rejects a missing rich compositionend without unlocking input or closing later', async () => {
  const report = vi.fn(() => { throw new Error('reporter failed') })
  const { session, target } = await setup({ onInputBlocked: report })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  session.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  session.view.dispatch(session.view.state.tr.insertText('中', 2).setMeta('composition', 1))
  let failure: unknown
  const closing = session.owner.close().catch(error => { failure = error })
  await vi.advanceTimersByTimeAsync(FILE_INPUT_WAIT_MS)
  expect(failure).toMatchObject({ reason: 'rich-composing', code: 'rich-composing' })
  await closing
  expect(report).toHaveBeenCalledOnce()
  expect(session.owner.canUndo()).toBe(false)
  expect(session.view.composing).toBe(true)
  expect(session.owner.snapshot().raw).toBe('A中')
  vi.useRealTimers()
  session.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  expect((await session.owner.flush()).raw).toBe('A中')
  expect(target.querySelector('.file-editor')).not.toBeNull()
  expect(session.owner.canUndo()).toBe(true)
})

it('keeps source composition draft after timeout and never resumes the expired flush', async () => {
  const { textarea, input, owner } = sourceFixture()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  textarea.dispatchEvent(new CompositionEvent('compositionstart'))
  textarea.value = '中文'; textarea.dispatchEvent(new Event('input'))
  const success = vi.fn(); let failure: unknown
  const flushing = input.flush().then(success, error => { failure = error })
  await vi.advanceTimersByTimeAsync(FILE_INPUT_WAIT_MS)
  expect(failure).toMatchObject({ reason: 'source-composing', code: 'source-composing' })
  await flushing
  expect(input.composing()).toBe(true)
  expect(textarea.value).toBe('中文')
  expect(owner.snapshot().raw).toBe('A')
  vi.useRealTimers()
  textarea.dispatchEvent(new CompositionEvent('compositionend'))
  expect((await input.flush()).raw).toBe('中文')
  expect(success).not.toHaveBeenCalled()
  input.detach()
})

it('classifies a stale source error and reveals its unchanged draft and selection', async () => {
  const { textarea, input, controller } = sourceFixture()
  controller.setReadOnly(true)
  textarea.value = 'Draft'; textarea.dispatchEvent(new Event('input'))
  controller.setReadOnly(false); controller.restoreContent('Remote')
  expect(input.retry()).toEqual({ ok: false, reason: 'stale-source' })
  textarea.setSelectionRange(1, 3)
  await expect(input.flush()).rejects.toMatchObject({ reason: 'source-pending', code: 'stale-source', message: 'stale-source' })
  input.reveal()
  expect(document.activeElement).toBe(textarea)
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 3])
  expect(textarea.value).toBe('Draft')
  expect(controller.snapshot().raw).toBe('Remote')
  input.detach()
})

it('reveals a blocked annotation and preserves it even when reporting throws', async () => {
  const report = vi.fn(() => { throw new Error('reporter failed') })
  const { session } = await setup({ onInputBlocked: report })
  expect(session.annotations.insert('Draft')).toBe(true)
  const edit = noteUi.edit!, reveal = vi.fn()
  edit.flushDraft = () => false; edit.revealDraft = reveal
  await expect(session.owner.flush()).rejects.toMatchObject({ reason: 'annotation-pending', code: 'annotation-pending' })
  expect(reveal).toHaveBeenCalledOnce()
  expect(report).toHaveBeenCalledOnce()
  expect(noteUi.edit).toBe(edit)
  expect(await session.setMode('source')).toBe(false)
  expect(noteUi.edit).toBe(edit)
})

it('does not turn unexpected mode-switch errors into a silent false result', async () => {
  const { session } = await setup()
  expect(session.annotations.insert('Draft')).toBe(true)
  const failure = new Error('unexpected flush failure')
  noteUi.edit!.flushDraft = () => { throw failure }
  await expect(session.setMode('source')).rejects.toBe(failure)
})

it('keeps unknown admission error details out of its reportable error code and message', () => {
  const error = new FileInputBlockedError('source-pending', 'plugin error with private draft text')
  expect(error).toMatchObject({ reason: 'source-pending', code: 'source-pending', message: 'source-pending' })
  expect(JSON.stringify(error)).not.toContain('private draft')
})

it('does not let an old source final frame finish a newer composition', async () => {
  const frames: FrameRequestCallback[] = []
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
  const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
  const { textarea, input, owner } = sourceFixture()
  textarea.dispatchEvent(new CompositionEvent('compositionstart'))
  textarea.value = '中'; textarea.dispatchEvent(new Event('input'))
  textarea.dispatchEvent(new CompositionEvent('compositionend'))
  const oldFrame = frames.at(-1)!, oldId = frames.length
  textarea.dispatchEvent(new CompositionEvent('compositionstart'))
  textarea.value = '中文'; textarea.dispatchEvent(new Event('input'))
  let completed = false
  const flushing = input.flush().then(snapshot => { completed = true; return snapshot })
  // Even an already-delivered old callback cannot settle the new composition.
  oldFrame(0); await Promise.resolve()
  expect(input.composing()).toBe(true)
  expect(completed).toBe(false)
  expect(owner.snapshot().raw).toBe('A')
  expect(cancel).toHaveBeenCalledWith(oldId)
  textarea.dispatchEvent(new CompositionEvent('compositionend'))
  frames.at(-1)!(1)
  expect((await flushing).raw).toBe('中文')
  input.detach()
})
