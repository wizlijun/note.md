/** @vitest-environment happy-dom */
import { afterEach, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import NoteEditPopup from './NoteEditPopup.svelte'
import { noteUi, type NoteEditState } from './note-ui.svelte'

const components: ReturnType<typeof mount>[] = []
afterEach(async () => { for (const component of components.splice(0)) await unmount(component); noteUi.edit = null; document.body.replaceChildren() })
async function popup(save: (text: string) => boolean | void, remove: () => boolean | void = () => false) {
  const edit: NoteEditState & { flushDraft?: () => boolean | void } = { x: 0, y: 0, note: 'old', save, remove }
  noteUi.edit = edit
  const target = document.createElement('div'); document.body.append(target)
  components.push(mount(NoteEditPopup, { target }))
  await tick()
  const textarea = target.querySelector('textarea')!
  const type = async (text: string) => { textarea.value = text; textarea.dispatchEvent(new Event('input', { bubbles: true })); await tick() }
  return { target, edit: noteUi.edit!, textarea, type }
}

it('retains the actual textarea draft after rejected Enter and allows explicit discard without another save', async () => {
  const saved: string[] = []
  const f = await popup(text => { saved.push(text); return false })
  await f.type('draft')
  f.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await tick()
  expect(noteUi.edit === f.edit).toBe(true)
  expect(f.textarea.value).toBe('draft')
  const discard = [...f.target.querySelectorAll('button')].find(b => b.textContent?.includes('Discard'))
  expect(discard).toBeDefined()
  discard!.click(); await tick()
  expect(noteUi.edit).toBeNull()
  await new Promise(r => setTimeout(r, 320))
  expect(saved).toEqual(['draft'])
})

it('flushes current text before the debounce and keeps the popup open', async () => {
  let saved = ''
  const f = await popup(text => { saved = text; return true })
  await f.type('latest')
  expect(f.edit.flushDraft?.()).toBe(true)
  expect(saved).toBe('latest')
  expect(noteUi.edit === f.edit).toBe(true)
})

it.each([true, undefined])('closes after an accepted save including legacy void (%s)', async result => {
  const f = await popup(() => result)
  f.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick()
  expect(noteUi.edit).toBeNull()
})

it('retains rejected removal and Ask text, and can retry successfully', async () => {
  let allowed = false
  const f = await popup(() => allowed)
  await f.type('question')
  f.target.querySelector<HTMLButtonElement>('.del')!.click(); await tick()
  expect(noteUi.edit === f.edit).toBe(true)
  f.target.querySelector<HTMLButtonElement>('.ask')!.click(); await tick()
  expect(f.textarea.value).toBe('question？')
  expect(noteUi.edit === f.edit).toBe(true)
  allowed = true
  const retry = [...f.target.querySelectorAll('button')].find(b => b.textContent?.includes('Retry'))
  expect(retry).toBeDefined(); retry!.click(); await tick()
  expect(noteUi.edit).toBeNull()
})

it('blocks flush/discard during composition and resumes with the final text', async () => {
  const saved: string[] = []
  const f = await popup(text => { saved.push(text); return true })
  f.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  await f.type('预编辑')
  expect(f.edit.flushDraft?.()).toBe(false); await tick()
  expect(saved).toEqual([])
  expect([...f.target.querySelectorAll('button')].filter(b => /Retry|Discard/.test(b.textContent ?? '')).every(b => b.disabled)).toBe(true)
  f.textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); await tick()
  expect(f.edit.flushDraft?.()).toBe(true)
  expect(saved).toEqual(['预编辑'])
})

it('does not close another popup installed synchronously by a callback', async () => {
  const replacement: NoteEditState = { x: 1, y: 1, note: 'other', save() {}, remove() {} }
  const f = await popup(() => { noteUi.edit = replacement; return true })
  f.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick()
  expect(noteUi.edit?.note).toBe('other')
})

it('retains an unaccepted draft across forced component unmount and remount without claiming flush success', async () => {
  const save = () => false
  noteUi.edit = { x: 0, y: 0, note: 'old', save, remove: () => false }
  const edit = noteUi.edit
  const target = document.createElement('div'); document.body.append(target)
  const first = mount(NoteEditPopup, { target }); await tick()
  const textarea = target.querySelector('textarea')!
  textarea.value = 'unsaved draft'; textarea.dispatchEvent(new Event('input', { bubbles: true })); await tick()
  await unmount(first)
  expect(noteUi.edit).toBe(edit); expect(edit.flushDraft?.()).toBe(false)
  const second = mount(NoteEditPopup, { target }); await tick()
  try { expect(target.querySelector('textarea')?.value).toBe('unsaved draft'); expect(edit.flushDraft?.()).toBe(false) }
  finally { noteUi.edit = null; await unmount(second) }
})
