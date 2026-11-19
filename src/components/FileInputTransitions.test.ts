/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import Harness from './FileInputTransitions.test-harness.svelte'
import { tabs, activeId } from '../lib/tabs.svelte'
import { formFactor } from '../lib/platform.svelte'
import { fileEditorSession, closeFileEditorSession } from '../lib/file-editor-sessions'
import { clearToasts } from '../lib/toast.svelte'
import { i18n, t } from '../lib/i18n/runtime.svelte'
import { noteUi } from '../lib/note-anno/note-ui.svelte'
import { FILE_INPUT_WAIT_MS } from '../editor-kit-v2/file-input-error'

const { confirmClose } = vi.hoisted(() => ({ confirmClose: vi.fn(async (_: unknown, options: any) => options.buttons.no) }))
// All native IO is isolated; the tab, source input, owner and editor are real.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (s: string) => s }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), ask: vi.fn(async () => true), message: confirmClose }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'macos', type: () => 'macos' }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} }) } }))

const id = 'isolated-input-transitions'
let component: ReturnType<typeof mount> | undefined
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); noteUi.edit = null
  fileEditorSession(id)?.destroyView()
  if (component) { await unmount(component); component = undefined }
  await closeFileEditorSession(id)
  tabs.splice(0); activeId.value = null; clearToasts(); confirmClose.mockClear()
  document.body.replaceChildren()
})

async function setup() {
  i18n.locale = 'en'; formFactor.value = 'desktop'
  tabs.push({ id, filePath: '/isolated/input-transitions.md', title: 'input-transitions.md', kind: 'markdown',
    mode: 'rich', currentContent: 'A', initialContent: 'A', externalState: 'fresh',
    externalBannerDismissed: false, lastKnownMtime: 0, lastKnownHash: '' })
  activeId.value = id
  component = mount(Harness, { target: document.body })
  await vi.waitFor(() => expect(fileEditorSession(id)).toBeDefined())
  await tick()
  return fileEditorSession(id)!
}
function close() { document.querySelector<HTMLElement>('.tab .close')!.click() }
function home() { document.querySelector<HTMLButtonElement>('[data-home-tab]')!.click() }
function mode(mode: 'source' | 'rich') {
  document.querySelectorAll<HTMLButtonElement>('[role=tab]')[mode === 'rich' ? 0 : 1].click()
}
async function source() {
  mode('source')
  await vi.waitFor(() => expect(document.querySelector('textarea.src-textarea')).not.toBeNull())
  return document.querySelector<HTMLTextAreaElement>('textarea.src-textarea')!
}
function pendingButton(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('.source-pending button')].find(button => button.textContent === label)!
}
async function feedback(key: 'editorInput.richComposing' | 'editorInput.sourcePending') {
  await vi.waitFor(() => expect(document.querySelector('.toast-warn .msg')?.textContent?.trim()).toBe(t(key)))
}

it('shows feedback after a rich close timeout, retains the draft, and requires an explicit retry after a late compositionend', async () => {
  const session = await setup()
  session.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  session.view.dispatch(session.view.state.tr.insertText('中', 2).setMeta('composition', 1))
  close()
  await vi.waitFor(() => expect(document.querySelector('.toast-warn')).not.toBeNull(), { timeout: FILE_INPUT_WAIT_MS + 1000 })
  await feedback('editorInput.richComposing')
  expect(tabs.map(tab => tab.id)).toEqual([id])
  expect(session.owner.snapshot().raw).toBe('A中')
  expect(confirmClose).not.toHaveBeenCalled()

  session.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  expect((await session.owner.flush()).raw).toBe('A中')
  await tick()
  expect(tabs.map(tab => tab.id)).toEqual([id])
  expect(confirmClose).not.toHaveBeenCalled()
  close()
  await vi.waitFor(() => expect(tabs).toHaveLength(0))
  expect(confirmClose).toHaveBeenCalledOnce()
})

it('waits for the source composition final frame before closing and presenting the dirty-file choice', async () => {
  const session = await setup()
  const textarea = await source()
  const frames: FrameRequestCallback[] = []
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
  textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  textarea.value = '中文'; textarea.dispatchEvent(new Event('input', { bubbles: true }))
  textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  const finalFrame = frames.at(-1)!
  expect(finalFrame).toBeDefined()
  close()
  await tick()
  expect(tabs.map(tab => tab.id)).toEqual([id])
  expect(confirmClose).not.toHaveBeenCalled()
  expect(session.owner.snapshot().raw).toBe('A')
  expect(document.querySelector('.toast-warn')).toBeNull()

  finalFrame(1)
  await vi.waitFor(() => expect(tabs).toHaveLength(0))
  expect(session.owner.snapshot().raw).toBe('中文')
  expect(confirmClose).toHaveBeenCalledOnce()
  expect(document.querySelector('.toast-warn')).toBeNull()
})

it('preserves and copies rejected source drafts across mode, home and close attempts, then retries successfully', async () => {
  const session = await setup()
  let allow = false
  expect(session.owner.installBaseline({ documentId: '/isolated/input-transitions.md', authority: 'restricted', raw: 'A' },
    { policy: { acceptRawChange: (before, after) => before === after || allow } }).ok).toBe(true)
  const textarea = await source()
  const draft = 'Draft 中文\n\nKeep this exact text.'
  textarea.value = draft; textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  expect(document.querySelector('.source-pending')).not.toBeNull()

  for (const action of [() => mode('rich'), home, close]) {
    clearToasts(); await tick(); action()
    await feedback('editorInput.sourcePending')
    expect(activeId.value).toBe(id)
    expect(tabs[0].mode).toBe('source')
    expect(textarea.value).toBe(draft)
    expect(session.owner.snapshot().raw).toBe('A')
    expect(document.activeElement).toBe(textarea)
  }
  expect(confirmClose).not.toHaveBeenCalled()
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  pendingButton(t('editorInput.copyDraft')).click()
  await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(draft))

  allow = true
  pendingButton(t('source.retryPending')).click()
  await vi.waitFor(() => expect(document.querySelector('.source-pending')).toBeNull())
  expect(session.owner.snapshot().raw).toBe(draft)
  mode('rich')
  await vi.waitFor(() => expect(tabs[0].mode).toBe('rich'))
  home()
  await vi.waitFor(() => expect(activeId.value).toBeNull())
  expect(tabs[0].currentContent).toBe(draft)
  close()
  await vi.waitFor(() => expect(tabs).toHaveLength(0))
  expect(confirmClose).toHaveBeenCalledOnce()
})
