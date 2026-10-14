/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (s: string) => s }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'macos', type: () => 'macos' }))
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async () => false, readTextFile: async () => '', writeTextFile: async () => {} }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: async () => null, save: async () => null }))
import SourceView from './SourceView.svelte'
import { attachFileSourceInput, type FileSourceOptions, type FileSourceInput } from '../editor-kit-v2/file-source-input'
import { open } from '../editor-kit-v2/file-test-utils'
import { tabs, activeId } from '../lib/tabs.svelte'
const components: ReturnType<typeof mount>[] = []
afterEach(async () => { for (const component of components.splice(0)) await unmount(component); tabs.splice(0); activeId.value = null; document.body.replaceChildren() })

async function fileSource(raw: string, allowed: () => boolean = () => true) {
  const controller = open(raw, [], undefined, { acceptRawChange: allowed })
  const owner = { snapshot: controller.snapshot, replaceSource: controller.replaceSource, observe: controller.observe,
    undo: () => controller.runHistory('undo', true), redo: () => controller.runHistory('redo', true) }
  const target = document.createElement('div'); document.body.append(target)
  tabs.push({ id: 'file-source', title: 'file', filePath: '', kind: 'markdown', mode: 'source', currentContent: raw, initialContent: raw,
    externalState: 'fresh', externalBannerDismissed: false, lastKnownMtime: 0, lastKnownHash: '' }); activeId.value = 'file-source'
  let input!: FileSourceInput
  components.push(mount(SourceView, { target, props: { value: raw, tabId: 'file-source', oninput() { throw new Error('adapter bypass') },
    attachFileSource(el: HTMLTextAreaElement, options?: FileSourceOptions) { input = attachFileSourceInput(el, owner, options); return input } } })); await tick()
  return { controller, target, textarea: target.querySelector('textarea')!, input }
}

it.each([
  ['b', false, '**Alpha**'], ['n', true, '{==Alpha==}{>><<}'], ['?', false, '{==Alpha==}{>>?<<}'],
] as const)('sends the real Source keyboard %s action through pending admission', async (key, shiftKey, expected) => {
  const f = await fileSource('Alpha', () => false)
  f.textarea.setSelectionRange(0, 5)
  f.textarea.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, ctrlKey: true, bubbles: true, cancelable: true })); await tick()
  expect(f.textarea.value).toBe(expected)
  expect(f.input.pending()?.value).toBe(expected)
  expect(f.controller.snapshot().raw).toBe('Alpha')
})

it('commits actual Source auto-pair and context-menu formatting through the same buffer', async () => {
  const f = await fileSource('[')
  f.textarea.setSelectionRange(1, 1)
  f.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true })); await tick()
  expect(f.controller.snapshot().raw).toBe('[[]]')
  f.textarea.setSelectionRange(0, 4)
  f.textarea.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await tick()
  const bold = [...f.target.querySelectorAll<HTMLElement>('.menu-row')].find(button => /Bold/.test(button.textContent ?? ''))!
  expect(bold).toBeTruthy(); bold.click(); await tick()
  expect(f.controller.snapshot().raw).toBe('**[[]]**')
})
it('shows the rejected real file buffer and routes formatting through the same adapter', async () => {
  const controller = open('A\n', [], undefined, { acceptRawChange: () => false })
  const owner = { snapshot: controller.snapshot, replaceSource: controller.replaceSource, observe: controller.observe,
    undo: () => controller.runHistory('undo', true), redo: () => controller.runHistory('redo', true) }
  let input: FileSourceInput | undefined
  const target = document.createElement('div'); document.body.append(target)
  const props = { value: 'A\n', oninput() { throw new Error('file input bypassed adapter') }, tabId: 'pending',
    attachFileSource(el: HTMLTextAreaElement, options: FileSourceOptions) { input = attachFileSourceInput(el, owner, options); return input } }
  components.push(mount(SourceView, { target, props })); await tick()
  const textarea = target.querySelector('textarea')!
  textarea.value = 'draft'; textarea.dispatchEvent(new Event('input', { bubbles: true })); await tick()
  expect(input?.pending()?.value).toBe('draft')
  expect(target.textContent).toContain('Discard')
  textarea.setSelectionRange(0, 5)
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })); await tick()
  expect(textarea.value).toBe('**draft**')
  expect(controller.snapshot().raw).toBe('A\n')
  ;[...target.querySelectorAll('button')].find(b => /Discard/.test(b.textContent ?? ''))!.click(); await tick()
  expect(textarea.value).toBe('A\n')
  expect(input?.pending()).toBeNull()
})
