// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import RichEditor from './RichEditor.svelte'
import { tabs, activeId } from '../lib/tabs.svelte'
import { fileEditorSession, closeFileEditorSession } from '../lib/file-editor-sessions'
import { requestEditorFocus } from '../lib/editor-focus.svelte'
import { newFileText } from '../lib/new-file'

vi.mock('../lib/platform-sync', () => ({ isApplePlatformSync: () => true }))
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
it.each(cases)('new Rich focus and actual multiline paste stay outside hidden metadata: %j', async raw => {
  const { session: f } = await editor(raw)
  const metadata = f.view.state.doc.firstChild!.textContent
  await vi.waitFor(() => expect(f.view.state.selection.$from.parent.type.name).toBe('paragraph'))
  expect(document.activeElement).toBe(f.view.dom)
  const metadataView = f.view.dom.querySelector('.frontmatter-node-view') as HTMLElement
  expect(metadataView.hidden).toBe(true)
  expect(metadataView.style.display).toBe('none')
  expect(metadataView.childElementCount).toBe(0)
  expect(f.view.state.doc.firstChild!.textContent).toBe(metadata)
  expect(f.owner.snapshot().raw.startsWith(raw)).toBe(true)
  if (raw.includes('\r\n')) expect(f.owner.snapshot().raw.replace(/\r\n/g, '')).not.toContain('\n')
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files: [], items: [], getData: (type: string) => type === 'text/plain' ? '第一段\n\n第二段' : '' } })
  f.view.dom.dispatchEvent(event)
  expect(f.owner.snapshot().raw).toContain('第一段')
  expect(f.view.dom.querySelectorAll('p')[0]?.textContent).toBe('第一段')
  expect(f.view.state.doc.firstChild!.textContent).toBe(metadata)
  expect(metadataView.hidden).toBe(true)
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
it('explicit owner focus preserves the Rich selection and cannot focus its hidden Source sibling', async () => {
  const { TextSelection } = await import('prosemirror-state')
  const { tick } = await import('svelte')
  const { tab, session: f } = await editor('Alpha beta gamma', false)
  await tick()
  f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(f.view.state.doc, 2, 5)))
  const before = f.view.state.selection
  const focus = vi.spyOn(f.view, 'focus')
  window.dispatchEvent(new CustomEvent('notemd:focus-editor', { detail: { path: tab.filePath, preserveSelection: true } }))
  expect(focus).toHaveBeenCalledOnce()
  expect(f.view.state.selection.eq(before)).toBe(true)
  tabs[0].mode = 'source'; await tick(); focus.mockClear()
  window.dispatchEvent(new CustomEvent('notemd:focus-editor', { detail: { path: tab.filePath, preserveSelection: true } }))
  expect(focus).not.toHaveBeenCalled()
  expect(f.view.state.selection.eq(before)).toBe(true)
})

it.each(['正文\n', '\n'])('hidden metadata is protected at the first body Backspace boundary: %j', async body => {
  const raw = '\ufeff---\r\n# keep comment\r\ntitle: "draft"\r\ntags: [a, b]\r\n---\r\n\r\n' + body
  const { session: f } = await editor(raw, false)
  for (let i = 0; i < 3; i++) {
    f.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
    expect((await f.owner.flush()).raw).toBe(raw)
    expect(f.view.state.selection.$from.parent.type.name).toBe('paragraph')
  }
  expect(f.owner.canUndo()).toBe(false)
  f.view.dispatch(f.view.state.tr.insertText('新'))
  expect(f.view.state.doc.child(1).textContent).toContain('新')
  expect(f.owner.snapshot().raw.startsWith(raw.slice(0, raw.lastIndexOf('---') + 3))).toBe(true)
})

it.each(['', '\ufeff'])('Source edits hidden YAML, then Rich deletes only the body with exact metadata preservation (BOM: %j)', async bom => {
  const prefix = bom + '---\r\n# comment\r\ntitle: "draft"\r\nnested:\r\n  value: 7\r\n---\r\n\r\n'
  const raw = prefix + '正文\r\n', { session: f } = await editor(raw, false)
  expect((await f.owner.flush()).raw).toBe(raw)
  expect(f.owner.canUndo()).toBe(false)
  const textarea = document.createElement('textarea'); document.body.append(textarea)
  const input = f.attachSource(textarea)
  try {
    await f.setMode('source')
    expect(textarea.value).toContain('title: "draft"')
    textarea.value = textarea.value.replace('"draft"', '"changed"')
    textarea.dispatchEvent(new Event('input'))
    const updated = raw.replace('"draft"', '"changed"')
    expect((await input.flush()).raw).toBe(updated)
    await f.setMode('rich')
    expect(f.view.dom.querySelector('details')).toBeNull()
    expect(f.view.dom.textContent).not.toContain('changed')
    f.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true }))
    expect(f.view.state.selection.content().content.textBetween(0, f.view.state.selection.content().content.size)).toBe('正文')
    f.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
    const saved = (await f.owner.flush()).raw
    expect(saved, String((f.baselineIdentity as { diagnostic: unknown }).diagnostic)).toBe(prefix.replace('"draft"', '"changed"'))
    expect(f.owner.undo()).toBe(true)
    expect(f.owner.snapshot().raw).toBe(updated)
    expect(f.owner.redo()).toBe(true)
    expect((await f.owner.flush()).raw).toBe(saved)
  } finally { input.detach() }
})

it('opening a metadata-only note does not write source and explicit focus creates a writable body', async () => {
  const raw = '---\ntitle: private metadata\n---', { session: f } = await editor(raw, false)
  expect((await f.owner.flush()).raw).toBe(raw)
  expect(f.owner.canUndo()).toBe(false)
  expect(f.view.state.selection.empty).toBe(true)
  expect(f.view.state.selection.from).toBe(f.view.state.doc.content.size)
  f.view.focus()
  expect(f.view.state.selection.$from.parent.type.name).toBe('paragraph')
  f.view.dispatch(f.view.state.tr.insertText('开始写作'))
  expect((await f.owner.flush()).raw).toBe(raw + '\n\n开始写作\n')
})

it('read-only metadata-only Select All and Delete leave YAML untouched', async () => {
  const raw = '---\ntitle: private metadata\n---', { session: f } = await editor(raw, false, true)
  f.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true }))
  expect(f.view.state.selection.empty).toBe(true)
  expect(f.view.state.selection.content().size).toBe(0)
  f.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
  expect((await f.owner.flush()).raw).toBe(raw)
})

it('ordinary YAML code and body thematic breaks remain visible', async () => {
  const raw = '正文\n\n---\n\n```yaml\ntitle: visible\n```\n', { session: f } = await editor(raw, false)
  expect(f.view.dom.querySelector('.frontmatter-node-view')).toBeNull()
  expect(f.view.dom.querySelector('hr')).toBeTruthy()
  expect(f.view.dom.querySelector('pre')?.textContent).toContain('title: visible')
  expect((await f.owner.flush()).raw).toBe(raw)
})

it('BOM and CRLF survive Source metadata edits and unedited mode cycles', async () => {
  const raw = '\ufeff---\r\n# keep\r\ntitle: "before"\r\n---\r\n\r\n正文\r\n'
  const { session: f } = await editor(raw, false)
  const textarea = document.createElement('textarea'); document.body.append(textarea)
  const input = f.attachSource(textarea)
  try {
    for (let i = 0; i < 3; i++) { await f.setMode('source'); await f.setMode('rich') }
    expect((await f.owner.flush()).raw).toBe(raw)
    await f.setMode('source')
    textarea.value = textarea.value.replace('"before"', '"after"')
    textarea.dispatchEvent(new Event('input'))
    const changed = raw.replace('"before"', '"after"')
    expect((await input.flush()).raw).toBe(changed)
    await f.setMode('rich')
    expect(f.view.dom.textContent).not.toContain('after')
    expect(f.owner.undo()).toBe(true); expect(f.owner.snapshot().raw).toBe(raw)
    expect(f.owner.redo()).toBe(true); expect((await f.owner.flush()).raw).toBe(changed)
  } finally { input.detach() }
})
