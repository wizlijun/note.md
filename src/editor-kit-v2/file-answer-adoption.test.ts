// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import { BrowserMediaResolver } from '@moraya/core/adapters/browser-media-resolver'
import { mountFileEditor, type FileMountSession } from './file-main'
import { collectCardSites } from '../lib/note-anno/answer-sites'
import { adoptAnswer } from '../lib/note-anno/adopt-answer'
import { answeredMap, answersStore, clearAnswers, loadAnswersFor } from '../lib/note-anno/answers-store.svelte'
import { parseOutline, serializeOutline } from '../lib/outline/markdown'
import { deriveAnswers } from '../lib/outline/answers'

const io = vi.hoisted(() => ({ note: '', main: '', writes: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async (path: string) => path === '/vault/repro.note.md'),
  readTextFile: vi.fn(async (path: string) => path.endsWith('.note.md') ? io.note : io.main),
  stat: vi.fn(async () => ({ mtime: new Date(0), size: io.main.length })),
  writeTextFile: vi.fn(async (path: string, text: string) => {
    if (path.endsWith('.note.md')) { io.writes(text); io.note = text }
    else io.main = text
  }),
  watchImmediate: vi.fn(async () => vi.fn()),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (s: string) => s }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'macos', type: () => 'macos' }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => vi.fn() }) }))
vi.mock('../lib/okf/identity', () => ({ humanActor: async () => 'human:test' }))
vi.mock('../lib/plugins/host-render-html', () => ({ renderMarkdownInline: (body: string) => `<p>${body}</p>` }))

const body = '答复导语。\n\n- 第一项\n- 第二项\n\n```js\nconst x = 1\n```'
const raw = '---\ntitle: test\n---\n\n原文{==锚点==}{>>为什么?<<}。[^ref]\n\n后文[^other]\n\n[^ref]: 来源\n[^other]: 另一来源\n'
function resetNote() {
  io.note = serializeOutline(parseOutline('- 锚点\n  type:: annotation\n  - 为什么?\n    type:: question\n    status:: answered\n    - ````markdown\n' + body.split('\n').map(l => '      ' + l).join('\n') + '\n      ````\n      type:: answer\n'))
  io.main = raw
  io.writes.mockClear()
}
const editors: FileMountSession[] = []
afterEach(async () => {
  clearAnswers()
  for (const f of editors.splice(0)) await f.owner.close()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
it('mounts a file with an already-loaded answer index and keeps the startup refresh in sync', async () => {
  resetNote()
  await loadAnswersFor('/vault/repro.md')
  const { answerCardPlugin } = await import('../lib/note-anno/answer-card')
  const target = document.createElement('div'); document.body.append(target)
  const f = await mountFileEditor(target, {
    file: { documentId: '/vault/repro.md', authority: 'A', raw },
    adapters: { mediaResolver: new BrowserMediaResolver() },
  }, { plugins: [answerCardPlugin({ getEntries: () => answeredMap(), onAdopt: () => false })] })
  editors.push(f)
  expect(target.querySelector('.answer-card-head')).toBeTruthy()
  expect(f.owner.snapshot().raw).toBe(raw)
  expect(f.owner.execute({ kind: 'block.insert-after', blockId: f.owner.snapshot().bindings[1].id, content: '> startup answer' })).toBe(true)
  expect(f.view.state.doc.textContent).toContain('startup answer')
  expect(f.owner.snapshot().raw).toContain('> startup answer')
  expect(f.owner.undo()).toBe(true)
  expect(f.owner.snapshot().raw).toBe(raw)
})
it('failed file admission keeps the answer pending and does not write adopted', async () => {
  resetNote()
  const target = document.createElement('div'); document.body.append(target)
  const f = await mountFileEditor(target, { file: { documentId: '/vault/repro.md', authority: 'A', raw }, adapters: { mediaResolver: new BrowserMediaResolver() }, policy: { acceptRawChange: () => false } }, {})
  editors.push(f)
  await loadAnswersFor('/vault/repro.md')
  const entry = answersStore.entries[0], site = collectCardSites(f.view.state.doc, answeredMap())[0]
  await adoptAnswer(f.view, entry, site.pos, '/vault/repro.md')
  expect(f.owner.snapshot().raw).toBe(raw)
  expect(io.writes).not.toHaveBeenCalled()
  expect(deriveAnswers(parseOutline(io.note))[0].status).toBe('answered')
})
it('actual desktop card adopts a quoted answer, saves it through the owner and supports one undo/redo', async () => {
  resetNote()
  const { default: RichEditor } = await import('../components/RichEditor.svelte')
  const { tabs, activeId, activeTab, saveTab } = await import('../lib/tabs.svelte')
  const { fileEditorSession, closeFileEditorSession } = await import('../lib/file-editor-sessions')
  const tab = { id: 'answer-desktop', filePath: '/vault/repro.md', title: 'repro.md', kind: 'markdown' as const, mode: 'rich' as const, currentContent: raw, initialContent: raw, externalState: 'fresh' as const, externalBannerDismissed: false, lastKnownMtime: 0, lastKnownHash: '' }
  tabs.push(tab); activeId.value = tab.id
  const component = mount(RichEditor, { target: document.body, props: { tab, fileBacked: true } })
  try {
    await vi.waitFor(() => expect(document.querySelector('.answer-card-head')).toBeTruthy())
    ;(document.querySelector('.answer-card-head') as HTMLElement).click()
    await vi.waitFor(() => expect(document.querySelector('.answer-card-adopt')).toBeTruthy())
    const f = fileEditorSession(tab.id)!
    f.owner.setReadOnly(true)
    const adopt = document.querySelector('.answer-card-adopt') as HTMLButtonElement
    adopt.click()
    await vi.waitFor(() => expect(document.querySelector('[role=status]')?.textContent).toContain('Could not insert'))
    expect(adopt.disabled).toBe(false)
    expect(io.writes).not.toHaveBeenCalled()
    expect(document.querySelector('.answer-card')).toBeTruthy()
    f.owner.setReadOnly(false)
    adopt.click(); adopt.click()
    await vi.waitFor(() => expect(deriveAnswers(parseOutline(io.note))[0].status).toBe('adopted'))
    expect(io.writes).toHaveBeenCalledOnce()
    const saved = (await f.owner.flush()).raw
    expect(saved).toContain('> 答复导语。')
    expect(saved).toContain('> - 第一项')
    expect(saved).toContain('> ```js\n> const x = 1\n> ```')
    expect(saved.replace(/^>[^\n]*(?:\n|$)/gm, '').replace(/\n{3,}/g, '\n\n')).toBe(raw)
    await vi.waitFor(() => expect(activeTab()?.currentContent).toBe(saved))
    const vault = await import('../lib/sotvault.svelte')
    vi.spyOn(vault, 'pushSourceToVaultIfTracked').mockResolvedValue()
    await saveTab(tab.id)
    expect(io.main).toBe(saved)
    expect(activeTab()?.initialContent).toBe(saved)
    expect(await f.setMode('source')).toBe(true)
    expect((await f.owner.flush()).raw).toBe(saved)
    expect(await f.setMode('rich')).toBe(true)
    expect(f.owner.undo()).toBe(true); expect(f.owner.snapshot().raw).toBe(raw)
    expect(f.owner.redo()).toBe(true); expect(f.owner.snapshot().raw).toBe(saved)
    expect(document.querySelector('.answer-card')).toBeNull()
  } finally { await unmount(component); await closeFileEditorSession(tab.id); const watcher = await import('../lib/file-watcher.svelte'); await watcher.stopWatchingTab(tab.id); tabs.splice(0); activeId.value = null }
})

it.each(['cold', 'warm'])('adopts through the current file session after leaving and returning to the same tab (%s index)', async index => {
  resetNote()
  const { default: RichEditor } = await import('../components/RichEditor.svelte')
  const { tabs, activeId } = await import('../lib/tabs.svelte')
  const { fileEditorSession, closeFileEditorSession } = await import('../lib/file-editor-sessions')
  const tab = { id: 'answer-remount', filePath: '/vault/repro.md', title: 'repro.md', kind: 'markdown' as const, mode: 'rich' as const, currentContent: raw, initialContent: raw, externalState: 'fresh' as const, externalBannerDismissed: false, lastKnownMtime: 0, lastKnownHash: '' }
  tabs.push(tab); activeId.value = tab.id
  if (index === 'warm') await loadAnswersFor(tab.filePath)
  let component = mount(RichEditor, { target: document.body, props: { tab, fileBacked: true } })
  try {
    await vi.waitFor(() => expect(document.querySelector('.answer-card-head')).toBeTruthy())
    const session = fileEditorSession(tab.id)!
    await unmount(component)
    component = mount(RichEditor, { target: document.body, props: { tab, fileBacked: true } })
    await vi.waitFor(() => expect(document.querySelector('.answer-card-head')).toBeTruthy())
    expect(fileEditorSession(tab.id)).toBe(session)
    ;(document.querySelector('.answer-card-head') as HTMLElement).click()
    await vi.waitFor(() => expect(document.querySelector('.answer-card-adopt')).toBeTruthy())
    const adopt = document.querySelector('.answer-card-adopt') as HTMLButtonElement
    activeId.value = 'other'
    adopt.click()
    await vi.waitFor(() => expect(adopt.disabled).toBe(false))
    expect(io.writes).not.toHaveBeenCalled()
    expect(session.owner.snapshot().raw).toBe(raw)
    activeId.value = tab.id
    session.owner.setReadOnly(true)
    adopt.click()
    await vi.waitFor(() => expect(adopt.disabled).toBe(false))
    expect(io.writes).not.toHaveBeenCalled()
    expect(session.owner.snapshot().raw).toBe(raw)
    session.owner.setReadOnly(false)
    adopt.click()
    await vi.waitFor(() => expect(deriveAnswers(parseOutline(io.note))[0].status).toBe('adopted'))
    expect(session.owner.snapshot().raw).toContain('> 答复导语。')
    expect(io.writes).toHaveBeenCalledOnce()
    expect(session.owner.undo()).toBe(true)
    expect(session.owner.snapshot().raw).toBe(raw)
    expect(session.owner.redo()).toBe(true)
    expect(session.owner.snapshot().raw).toContain('> 答复导语。')
  } finally {
    await unmount(component); await closeFileEditorSession(tab.id)
    const watcher = await import('../lib/file-watcher.svelte'); await watcher.stopWatchingTab(tab.id)
    tabs.splice(0); activeId.value = null
  }
})
