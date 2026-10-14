/** @vitest-environment happy-dom */
import { afterEach, expect, it } from 'vitest'
import { attachFileSourceInput } from './file-source-input'
import { open } from './file-test-utils'

const inputs: ReturnType<typeof attachFileSourceInput>[] = []
afterEach(() => { inputs.splice(0).forEach(input => input.detach()); document.body.replaceChildren() })
function fixture(accept = true) {
  let allowed = accept
  const controller = open('A\r\n', [], undefined, { acceptRawChange: () => allowed })
  const owner = {
    snapshot: controller.snapshot, replaceSource: controller.replaceSource, observe: controller.observe,
    undo: () => controller.runHistory('undo', true), redo: () => controller.runHistory('redo', true),
  }
  const textarea = document.createElement('textarea'); document.body.append(textarea)
  const input = attachFileSourceInput(textarea, owner, { onCompositionChange: controller.setComposing })
  inputs.push(input)
  const type = (value: string) => { textarea.value = value.replace(/\r\n?/g, '\n'); textarea.setSelectionRange(textarea.value.length, textarea.value.length); textarea.dispatchEvent(new Event('input')) }
  return { controller, owner, textarea, input, type, allow() { allowed = true } }
}

it('commits ordinary input into the real shared native history', async () => {
  const f = fixture(); f.type('AB\r\n')
  expect(f.owner.snapshot().raw).toBe('AB\r\n')
  expect((await f.input.flush()).raw).toBe('AB\r\n')
  expect(f.owner.undo()).toBe(true)
  await Promise.resolve()
  expect(f.textarea.value).toBe('A\n')
})

it('keeps rejected drafts and selection, does not retry on input or flush, then explicitly retries', async () => {
  const f = fixture(false); f.type('B\r\n')
  expect(f.owner.snapshot().raw).toBe('A\r\n')
  expect(f.input.pending()?.value).toBe('B\n')
  f.allow(); f.type('BC\r\n')
  await expect(f.input.flush()).rejects.toThrow()
  expect(f.owner.snapshot().raw).toBe('A\r\n')
  expect(f.textarea.selectionStart).toBe(3)
  expect(f.input.retry().ok).toBe(true)
  expect(f.owner.snapshot().raw).toBe('BC\r\n')
  expect(f.input.pending()).toBeNull()
})

it('projects mixed EOL to textarea coordinates while preserving untouched raw and BOM/emoji', async () => {
  const controller = open('\ufeffA\r\nB\rC\n😀\r\n')
  const owner = { snapshot: controller.snapshot, replaceSource: controller.replaceSource, observe: controller.observe,
    undo: () => controller.runHistory('undo', true), redo: () => controller.runHistory('redo', true) }
  const textarea = document.createElement('textarea'); document.body.append(textarea)
  const input = attachFileSourceInput(textarea, owner); inputs.push(input)
  expect(textarea.value).toBe('\ufeffA\nB\nC\n😀\n')
  expect((await input.flush()).raw).toBe('\ufeffA\r\nB\rC\n😀\r\n')
  expect(owner.snapshot().generation).toBe(0)
  textarea.value = '\ufeffA\nX\nC\n😀\n'; input.commitBuffer()
  expect(owner.snapshot().raw).toBe('\ufeffA\r\nX\rC\n😀\r\n')
  textarea.value = '\ufeffA\nX\nnew\nC\n😀\n'; input.commitBuffer()
  expect(owner.snapshot().raw).toBe('\ufeffA\r\nX\rnew\r\nC\n😀\r\n')
})

it('preserves every unchanged mixed newline across a disjoint replace-all', () => {
  const controller = open('A\r\nkeep\nA\rTail')
  const owner = { snapshot: controller.snapshot, replaceSource: controller.replaceSource, observe: controller.observe,
    undo: () => controller.runHistory('undo', true), redo: () => controller.runHistory('redo', true) }
  const textarea = document.createElement('textarea'); document.body.append(textarea)
  const input = attachFileSourceInput(textarea, owner); inputs.push(input)
  textarea.value = 'Z\nkeep\nZ\nTail'
  expect(input.commitBuffer().ok).toBe(true)
  expect(owner.snapshot().raw).toBe('Z\r\nkeep\nZ\rTail')
})

it('does not overwrite a stale draft or replay it against a later generation', async () => {
  const f = fixture(false); f.type('Draft'); f.allow()
  expect(f.owner.replaceSource({ expectedGeneration: 0, value: 'Remote' }).ok).toBe(true)
  await Promise.resolve()
  expect(f.textarea.value).toBe('Draft')
  expect(f.input.retry()).toEqual({ ok: false, reason: 'stale-source' })
  const snapshot = f.owner.snapshot()
  expect(f.input.discard().ok).toBe(true)
  expect(f.textarea.value).toBe('Remote')
  expect(f.owner.snapshot()).toEqual(snapshot)
  expect(f.owner.undo()).toBe(true)
  expect(f.owner.snapshot().raw).toBe('A\r\n')
})

it('buffers composition and waits for the final rAF, with no trailing-input duplicate', async () => {
  const f = fixture()
  f.textarea.dispatchEvent(new CompositionEvent('compositionstart'))
  f.type('中文')
  expect(f.owner.snapshot().raw).toBe('A\r\n')
  expect(f.input.retry().ok).toBe(false)
  expect(f.input.discard().ok).toBe(false)
  let done = false
  const flushed = f.input.flush().then(s => { done = true; return s })
  await Promise.resolve(); expect(done).toBe(false)
  f.textarea.dispatchEvent(new CompositionEvent('compositionend'))
  f.type('中文结束')
  expect((await flushed).raw).toBe('中文结束')
  const generation = f.owner.snapshot().generation
  f.type('中文结束')
  expect(f.owner.snapshot().generation).toBe(generation)
})

it('preserves interrupted composition across detach/rebind and rejects its flush waiter', async () => {
  const f = fixture()
  f.textarea.dispatchEvent(new CompositionEvent('compositionstart')); f.type('未完成')
  const flushed = expect(f.input.flush()).rejects.toThrow('composition-interrupted')
  f.input.detach(); await flushed
  expect(f.input.pending()?.value).toBe('未完成')
  const next = document.createElement('textarea'); document.body.append(next)
  f.input.bind(next)
  expect(next.value).toBe('未完成')
  expect(f.input.retry().ok).toBe(true)
  expect(f.owner.snapshot().raw).toBe('未完成')
})

it('routes cancelable history beforeinput and shortcuts through the shared owner exactly once', () => {
  const f = fixture(); f.type('AB')
  const event = new InputEvent('beforeinput', { inputType: 'historyUndo', cancelable: true })
  f.textarea.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  expect(f.owner.snapshot().raw).toBe('A\r\n')
  f.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, cancelable: true }))
  const generation = f.owner.snapshot().generation
  f.textarea.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyRedo', cancelable: true }))
  expect(f.owner.snapshot().raw).toBe('AB')
  expect(f.owner.snapshot().generation).toBe(generation)
})

it('retries after readonly is lifted and refuses the same raw at a later generation', () => {
  const f = fixture(); f.controller.setReadOnly(true); f.type('Draft')
  expect(f.input.pending()).not.toBeNull()
  f.controller.setReadOnly(false); expect(f.input.retry().ok).toBe(true)
  f.controller.setReadOnly(true); f.type('Next')
  f.controller.setReadOnly(false)
  f.controller.restoreContent('Other'); f.controller.restoreContent('Draft')
  expect(f.input.retry()).toEqual({ ok: false, reason: 'stale-source' })
  expect(f.owner.snapshot().raw).toBe('Draft')
})

it('retains an oversized diff as a visible draft instead of normalizing raw', async () => {
  const f = fixture(); f.type('X'.repeat(20001))
  expect(f.input.pending()?.reason).toBe('source-diff-limit')
  expect(f.owner.snapshot().raw).toBe('A\r\n')
  await expect(f.input.flush()).rejects.toThrow('source-diff-limit')
  expect(f.textarea.value).toBe('X'.repeat(20001))
})
