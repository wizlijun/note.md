/** @vitest-environment happy-dom */
import { expect, it, vi } from 'vitest'
vi.mock('../tabs.svelte', () => ({ setContent: () => { throw new Error('file action bypassed its input adapter') } }))
import { createSourceActions, type SourceHandle } from './source-actions'

it.each(['bold', 'note', 'question', 'h1', 'table'])('routes %s through the optional source buffer admission', async id => {
  const el = document.createElement('textarea'); el.value = 'Alpha'; el.setSelectionRange(0, 5)
  let accepted = ''
  const handle: SourceHandle & { applyBuffer(value: string, selection: [number, number]): void } = {
    el, tabId: 'one', value: () => el.value,
    applyBuffer(value, selection) { accepted = value; el.value = value; el.setSelectionRange(...selection) },
  }
  await createSourceActions(handle).run(id)
  expect(accepted).not.toBe('')
  expect(el.value).toBe(accepted)
})

it('does not paste asynchronous clipboard text after the source buffer or selection changes', async () => {
  const el = document.createElement('textarea'); document.body.append(el); el.value = 'A'; el.setSelectionRange(1, 1)
  let resolve!: (value: string) => void
  vi.spyOn(navigator.clipboard, 'readText').mockImplementation(() => new Promise(r => { resolve = r }))
  const applied = vi.fn((value: string) => { el.value = value })
  const handle: SourceHandle = { el, tabId: 'one', value: () => el.value, applyBuffer: applied }
  const result = createSourceActions(handle).run('paste')
  el.value = 'B'; resolve('stale'); await result
  expect(el.value).toBe('B')
  expect(applied).not.toHaveBeenCalled()
  vi.restoreAllMocks(); el.remove()
})

it('rejects delayed clipboard results even when newer edits return to the same text and selection', async () => {
  const el = document.createElement('textarea'); document.body.append(el); el.value = 'A'; el.setSelectionRange(1, 1)
  let version = 0, resolve!: (value: string) => void
  vi.spyOn(navigator.clipboard, 'readText').mockImplementation(() => new Promise(r => { resolve = r }))
  const applied = vi.fn((value: string) => { el.value = value })
  const handle: SourceHandle = { el, tabId: 'one', value: () => el.value, version: () => version, applyBuffer: applied }
  const result = createSourceActions(handle).run('paste')
  version++; resolve('stale'); await result
  expect(el.value).toBe('A'); expect(applied).not.toHaveBeenCalled()
  vi.restoreAllMocks(); el.remove()
})
