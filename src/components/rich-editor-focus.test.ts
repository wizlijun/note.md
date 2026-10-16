// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import RichEditor from './RichEditor.svelte'
import { tabs, activeId } from '../lib/tabs.svelte'
import { fileEditorSession, closeFileEditorSession } from '../lib/file-editor-sessions'
import { requestEditorFocus } from '../lib/editor-focus.svelte'
import { newFileText } from '../lib/new-file'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (s: string) => s }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'macos', type: () => 'macos' }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => vi.fn() }) }))
vi.mock('../lib/note-anno/answers-store.svelte', () => ({ answersStore: { version: 0 }, loadAnswersFor: vi.fn(), answeredMap: () => new Map() }))
const components: ReturnType<typeof mount>[] = []
afterEach(async () => {
  for (const component of components.splice(0)) await unmount(component)
  for (const tab of tabs) await closeFileEditorSession(tab.id)
  tabs.splice(0); activeId.value = null; document.body.replaceChildren(); vi.restoreAllMocks()
})
async function editor(raw: string, focus = true, readOnly = false) {
  const tab = { id: `focus-${tabs.length}`, filePath: `/vault/focus-${tabs.length}.md`, title: 'focus.md', kind: 'markdown' as const, mode: 'rich' as const, currentContent: raw, initialContent: raw, externalState: 'fresh' as const, externalBannerDismissed: false, lastKnownMtime: 0, lastKnownHash: '' }
  tabs.push(tab); activeId.value = tab.id
  if (focus) requestEditorFocus(tab.filePath)
  const component = mount(RichEditor, { target: document.body, props: { tab, fileBacked: true, readOnly } }); components.push(component)
  await vi.waitFor(() => expect(fileEditorSession(tab.id)).toBeDefined())
  return { tab, component, session: fileEditorSession(tab.id)! }
}
const cases = [
  newFileText(''),
  newFileText('', { by: 'human:test', at: '2026-10-16T04:00:00Z' }),
  '---\ntitle: draft\n---',
  '\ufeff---\r\ntitle: draft\r\n---\r\n',
]
it.each(cases)('new Rich focus and actual multiline paste stay outside collapsed metadata: %j', async raw => {
  const { session: f } = await editor(raw)
  const metadata = f.view.state.doc.firstChild!.textContent
  await vi.waitFor(() => expect(f.view.state.selection.$from.parent.type.name).toBe('paragraph'))
  expect(document.activeElement).toBe(f.view.dom)
  const details = f.view.dom.querySelector('details')!
  expect(details.open).toBe(false)
  expect(f.view.state.doc.firstChild!.textContent).toBe(metadata)
  expect(f.owner.snapshot().raw.startsWith(raw)).toBe(true)
  if (raw.includes('\r\n')) expect(f.owner.snapshot().raw.replace(/\r\n/g, '')).not.toContain('\n')
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files: [], items: [], getData: (type: string) => type === 'text/plain' ? '第一段\n\n第二段' : '' } })
  f.view.dom.dispatchEvent(event)
  expect(f.owner.snapshot().raw).toContain('第一段')
  expect(f.view.dom.querySelectorAll('p')[0]?.textContent).toBe('第一段')
  expect(f.view.state.doc.firstChild!.textContent).toBe(metadata)
  expect(details.open).toBe(false)
  const saved = (await f.owner.flush()).raw
  expect(await f.setMode('source')).toBe(true); expect((await f.owner.flush()).raw).toBe(saved)
  expect(await f.setMode('rich')).toBe(true)
  expect(f.owner.undo()).toBe(true); expect(f.view.state.doc.firstChild!.textContent).toBe(metadata)
  expect(f.owner.redo()).toBe(true); expect(f.owner.snapshot().raw).toBe(saved)
})
it('a file with existing body starts with a body selection before any focus request', async () => {
  const raw = '---\ntitle: draft\n---\n\n正文\n'
  const { session: f } = await editor(raw, false)
  expect(f.view.state.selection.$from.parent.type.name).toBe('paragraph')
  expect(f.owner.snapshot().raw).toBe(raw)
  expect(f.owner.canUndo()).toBe(false)
})
it('does not materialize a body or edit metadata in a read-only file', async () => {
  const raw = newFileText(''), { session: f } = await editor(raw, true, true)
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(f.owner.snapshot().raw).toBe(raw)
  expect(f.owner.canUndo()).toBe(false)
})
it('a delayed focus request cannot steal focus after another tab becomes active', async () => {
  const { session: f } = await editor('---\ntitle: draft\n---\n\n正文\n', false)
  const focus = vi.spyOn(f.view, 'focus')
  requestEditorFocus(tabs[0].filePath)
  activeId.value = 'another-tab'
  focus.mockClear()
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(focus).not.toHaveBeenCalled()
})
