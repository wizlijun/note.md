/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (s: string) => s }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'macos', type: () => 'macos' }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }))
import { Plugin } from 'prosemirror-state'
import { BrowserMediaResolver } from '@moraya/core/adapters/browser-media-resolver'
import { mountFileEditor } from './file-main'
import type { MountedFileEditor, MountFileEditorOptions } from './file-contract'
import { noteUi } from '../lib/note-anno/note-ui.svelte'
import { mount, unmount, tick } from 'svelte'
import NoteEditPopup from '../lib/note-anno/NoteEditPopup.svelte'
import { registerFileEditorSession, closeFileEditorSession } from '../lib/file-editor-sessions'
import type { FileMountSession } from './file-main'
import type { VideoInfo } from '../lib/video-links'

async function desktopPaste(raw: string, run: (session: FileMountSession) => Promise<void>) {
  const { default: RichEditor } = await import('../components/RichEditor.svelte')
  const { tabs, activeId } = await import('../lib/tabs.svelte')
  const { fileEditorSession } = await import('../lib/file-editor-sessions')
  const tab = { id: 'resource-paste', filePath: '/vault/paste.md', title: 'paste.md',
    kind: 'markdown' as const, mode: 'rich' as const, currentContent: raw, initialContent: raw,
    externalState: 'fresh' as const, externalBannerDismissed: false, lastKnownMtime: 0, lastKnownHash: '' }
  tabs.push(tab); activeId.value = tab.id
  const component = mount(RichEditor, { target: document.body, props: { tab, fileBacked: true } })
  try { await vi.waitFor(() => expect(fileEditorSession(tab.id)).toBeDefined()); await run(fileEditorSession(tab.id)!) }
  finally { await unmount(component); await closeFileEditorSession(tab.id); tabs.splice(0); activeId.value = null }
}

it.each([false, true])('real binary attachment paste checks its captured generation: stale=%s', async stale => {
  const resources = await import('../lib/paste-resources')
  let resolve!: (path: string) => void
  const save = vi.spyOn(resources, 'saveClipboardResource').mockImplementation(() => new Promise(r => { resolve = r }))
  try { await desktopPaste('A', async session => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'application/pdf', getAsFile: () => new File(['x'], 'report.pdf', { type: 'application/pdf' }) }] } })
    session.view.dom.dispatchEvent(event)
    expect(save).toHaveBeenCalledOnce()
    if (stale) expect(session.owner.restoreContent('B').ok).toBe(true)
    resolve('/vault/report.pdf'); await tick(); await Promise.resolve()
    expect(session.owner.snapshot().raw).toBe(stale ? 'B' : '[report.pdf](/vault/report.pdf)A')
  }) } finally { save.mockRestore() }
})

it.each([false, true])('video metadata updates only its accepted placeholder: stale=%s', async stale => {
  const video = await import('../lib/video-links')
  let resolve!: (value: VideoInfo) => void
  const fetch = vi.spyOn(video, 'fetchVideoInfo').mockImplementation(() => new Promise(r => { resolve = r }))
  const href = 'https://youtu.be/abcdefghijk', raw = `[${href}](${href})\n\nTail`
  try { await desktopPaste(raw, async session => {
    const { TextSelection } = await import('prosemirror-state')
    session.view.dispatch(session.view.state.tr.setSelection(TextSelection.create(session.view.state.doc, session.view.state.doc.content.size - 1)))
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items: [], getData: () => href } })
    session.view.dom.dispatchEvent(event)
    expect(fetch).toHaveBeenCalledOnce()
    const placeholder = session.owner.snapshot().raw
    expect(placeholder).toBe(raw + `[${href}](${href})`)
    if (stale) expect(session.owner.restoreContent('Changed').ok).toBe(true)
    resolve({ title: 'Video title', thumbnailUrl: '', videoUrl: href, platform: 'youtube' }); await tick(); await Promise.resolve()
    expect(session.owner.snapshot().raw).toBe(stale ? 'Changed' : raw + `[Video title](${href})`)
  }) } finally { fetch.mockRestore() }
})

it('desktop bridge captures extras before the first view and reattaches the same file owner', async () => {
  const { mountRichEditor } = await import('../lib/editor-bridge')
  const { fileEditorSession } = await import('../lib/file-editor-sessions')
  const target = document.createElement('div'); document.body.append(target)
  const frames: string[] = []
  const plugin = new Plugin({ view(view) { frames.push(view.state.doc.textContent); return {} } })
  const tab = { id: 'desktop-file-test', filePath: '/vault/a.md', currentContent: '\ufeffA\r\n', mode: 'rich' as const }
  const changes: string[] = []
  const editor = await mountRichEditor(target, tab.currentContent, raw => changes.push(raw), undefined,
    new BrowserMediaResolver(), false, { tab, plugins: [plugin] })
  const session = fileEditorSession(tab.id)
  expect(session).toBeDefined()
  try {
    expect(frames).toEqual(['A'])
    expect(editor.getMarkdown()).toBe(tab.currentContent)
    expect(changes).toEqual([])
    editor.view.dispatch(editor.view.state.tr.insertText('B', 2))
    expect(session!.owner.undo()).toBe(true)
    editor.destroy()
    const next = await mountRichEditor(target, 'ignored', raw => changes.push(raw), undefined,
      new BrowserMediaResolver(), false, { tab, plugins: [plugin] })
    expect(fileEditorSession(tab.id)).toBe(session)
    expect(next.view).toBe(editor.view)
    expect(session!.owner.redo()).toBe(true)
    expect(next.getMarkdown()).toBe('\ufeffAB\r\n')
    next.destroy()
  } finally { await closeFileEditorSession(tab.id) }
})

it('desktop RichEditor uses the first captured state and its shared annotation owner', async () => {
  const { default: RichEditor } = await import('../components/RichEditor.svelte')
  const { tabs, activeId } = await import('../lib/tabs.svelte')
  const { fileEditorSession } = await import('../lib/file-editor-sessions')
  const tab = { id: 'desktop-component-test', filePath: '/vault/file.md', title: 'file.md',
    kind: 'markdown' as const, mode: 'rich' as const, currentContent: '{>>old<<}\n', initialContent: '{>>old<<}\n',
    externalState: 'fresh' as const, externalBannerDismissed: false, lastKnownMtime: 0, lastKnownHash: '' }
  tabs.push(tab); activeId.value = tab.id
  const component = mount(RichEditor, { target: document.body, props: { tab, fileBacked: true } })
  try {
    await vi.waitFor(() => expect(fileEditorSession(tab.id)).toBeDefined())
    await vi.waitFor(() => expect(document.querySelector('.diag.err')).toBeNull())
    const session = fileEditorSession(tab.id)!
    expect(session.owner.snapshot().raw).toBe('{>>old<<}\n')
    expect(session.view.state.plugins.some(p => String((p as unknown as { key: string }).key).includes('note-badges'))).toBe(true)
    expect(session.annotations.editAt(1)).toBe(true); await tick()
    const textarea = document.querySelector<HTMLTextAreaElement>('.note-edit-popup textarea') ?? document.querySelector('textarea')!
    textarea.value = 'saved'; textarea.dispatchEvent(new Event('input', { bubbles: true })); await tick()
    expect((await session.owner.flush()).raw).toBe('{>>saved<<}\n')
    await Promise.resolve()
    expect(tabs.find(t => t.id === tab.id)!.currentContent).toBe('{>>saved<<}\n')
  } finally { noteUi.edit = null; await unmount(component); await closeFileEditorSession(tab.id); tabs.splice(0); activeId.value = null }
})

it.each(['generation', 'tab', 'source', 'readonly', 'selection', 'current'] as const)('guards delayed real Rich context-menu paste after %s', async change => {
  const { default: RichEditor } = await import('../components/RichEditor.svelte')
  const { tabs, activeId, setMode } = await import('../lib/tabs.svelte')
  const { fileEditorSession } = await import('../lib/file-editor-sessions')
  const tab = { id: 'rich-delayed-paste', filePath: '/vault/paste.md', title: 'paste.md',
    kind: 'markdown' as const, mode: 'rich' as const, currentContent: 'A', initialContent: 'A',
    externalState: 'fresh' as const, externalBannerDismissed: false, lastKnownMtime: 0, lastKnownHash: '' }
  tabs.push(tab); activeId.value = tab.id
  let resolve!: (text: string) => void
  const clipboard = vi.spyOn(navigator.clipboard, 'readText').mockImplementation(() => new Promise(r => { resolve = r }))
  const component = mount(RichEditor, { target: document.body, props: { tab, fileBacked: true } })
  try {
    await vi.waitFor(() => expect(fileEditorSession(tab.id)).toBeDefined())
    const session = fileEditorSession(tab.id)!
    session.view.dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await tick()
    const paste = [...document.querySelectorAll<HTMLElement>('.menu-row')].find(row => /^Paste/.test(row.textContent?.trim() ?? ''))!
    expect(paste).toBeTruthy(); paste.click(); await tick()
    expect(clipboard).toHaveBeenCalledOnce()
    if (change === 'generation') expect(session.owner.restoreContent('B').ok).toBe(true)
    if (change === 'tab') activeId.value = 'other'
    if (change === 'source') await setMode(tab.id, 'source')
    if (change === 'readonly') session.owner.setReadOnly(true)
    if (change === 'selection') {
      const { TextSelection } = await import('prosemirror-state')
      session.view.dispatch(session.view.state.tr.setSelection(TextSelection.create(session.view.state.doc, 2)))
    }
    resolve('stale'); await tick(); await Promise.resolve()
    expect(session.owner.snapshot().raw).toBe(change === 'generation' ? 'B' : change === 'current' ? 'staleA' : 'A')
  } finally { clipboard.mockRestore(); await unmount(component); await closeFileEditorSession(tab.id); tabs.splice(0); activeId.value = null }
})

it('slash annotations keep the trigger on rejection and share one undo entry', async () => {
  let allow = false
  const target = document.createElement('div'); document.body.append(target)
  const session = await mountFileEditor(target, { file: { documentId: 'slash', authority: 'a', raw: '/note\n' },
    adapters: { mediaResolver: new BrowserMediaResolver() }, policy: { acceptRawChange: (before, after) => before === after || allow } }, {})
  editors.push(session)
  const { TextSelection } = await import('prosemirror-state')
  session.view.dispatch(session.view.state.tr.setSelection(TextSelection.create(session.view.state.doc, 6)))
  expect(session.view.state.selection.from).toBe(6)
  expect(session.insertSlashNote()).toBe(false)
  expect(session.owner.snapshot().raw).toBe('/note\n')
  allow = true
  const inserted = session.insertSlashNote()
  expect(inserted, JSON.stringify({ snapshot: session.owner.snapshot(), doc: session.view.state.doc.toJSON(), edit: noteUi.edit })).toBe(true)
  expect(session.owner.snapshot().raw).toBe('{>><<}\n')
  expect(noteUi.edit?.save('text')).toBe(true)
  noteUi.edit = null
  expect(session.owner.undo()).toBe(true)
  expect(session.owner.snapshot().raw).toBe('/note\n')
  expect(session.owner.canUndo()).toBe(false)
})

it.each(['image', 'file'] as const)('admits supported prepared %s or preserves the whole slash on rejection', async kind => {
  const target = document.createElement('div'); document.body.append(target)
  const session = await mountFileEditor(target, { file: { documentId: 'slash', authority: 'a', raw: '/insert\n' },
    adapters: { mediaResolver: new BrowserMediaResolver() } }, {})
  editors.push(session)
  const { TextSelection } = await import('prosemirror-state')
  session.view.dispatch(session.view.state.tr.setSelection(TextSelection.create(session.view.state.doc, 8)))
  const accepted = session.insertSlashAttachment(kind, '/vault/a.png')
  // ROOT schedules the existing desktop image producer gap as Task5. This
  // boundary assertion proves no partial trigger deletion, not image support.
  if (kind === 'image') {
    expect(accepted).toBe(false); expect(session.owner.snapshot().raw).toBe('/insert\n'); expect(session.owner.canUndo()).toBe(false); return
  }
  expect(accepted).toBe(true)
  expect(session.owner.snapshot().raw).toContain('[a.png](/vault/a.png)')
  expect(session.owner.undo()).toBe(true)
  expect(session.owner.snapshot().raw).toBe('/insert\n')
})

it('records the current admission boundary for actual desktop image helpers', async () => {
  const { insertImageAtCursor, insertImageAtPos, insertAttachmentLink } = await import('../lib/attachment-insert')
  const target = document.createElement('div'); document.body.append(target)
  const session = await mountFileEditor(target, { file: { documentId: 'image-probe', authority: 'a', raw: 'A\n' },
    adapters: { mediaResolver: new BrowserMediaResolver() } }, {})
  editors.push(session)
  insertImageAtCursor(session.view, '/vault/a.png')
  expect(session.owner.snapshot().raw).toBe('A\n')
  insertImageAtPos(session.view, '/vault/a.png', 2)
  expect(session.owner.snapshot().raw).toBe('A\n')
  insertAttachmentLink(session.view, '/vault/a.pdf')
  expect(session.owner.snapshot().raw).toContain('[a.pdf](/vault/a.pdf)')
})

const editors: MountedFileEditor[] = []
const popups: ReturnType<typeof mount>[] = []
afterEach(async () => {
  for (const p of popups.splice(0)) await unmount(p)
  noteUi.edit = null
  for (const e of editors.splice(0)) { e.destroyView(); await e.owner.close().catch(() => {}) }
  document.body.replaceChildren()
})
async function setup(raw = 'A\r\n', extra: Partial<MountFileEditorOptions> = {}) {
  const container = document.createElement('div'); document.body.append(container)
  const editor = await mountFileEditor(container, {
    file: { documentId: 'file.md', authority: 'a', raw }, adapters: { mediaResolver: new BrowserMediaResolver() }, ...extra,
  })
  editors.push(editor)
  return { ...editor, container }
}

it('loads the shared Kit stylesheet for the public file factory once', async () => {
  document.querySelectorAll('link[href$="editor-kit-v1.css"]').forEach(link => link.remove())
  const first = await setup()
  expect(first.container.querySelector('.file-editor')?.classList.contains('kit-host')).toBe(true)
  expect(document.querySelectorAll('link[href$="editor-kit-v1.css"]')).toHaveLength(1)
  await setup()
  expect(document.querySelectorAll('link[href$="editor-kit-v1.css"]')).toHaveLength(1)
})

it.each(['\ufeff---\r\ntitle: Hello\r\n---\r\n\r\nBody\r\n', '---\r\n---\r\n'])('captures raw on the first NodeView frame and preserves three mode switches: %j', async raw => {
  const yaml: string[] = []
  const changes: string[] = []
  const f = await setup(raw, { adapters: { mediaResolver: new BrowserMediaResolver(), frontmatterViewFactory: {
    render(container, value) { yaml.push(value); container.textContent = value; return { destroy() {} } },
  } }, onChange: value => changes.push(value.raw) })
  expect(yaml).toEqual([raw.includes('title') ? 'title: Hello' : ''])
  expect(f.owner.snapshot().raw).toBe(raw)
  expect(f.owner.canUndo()).toBe(false)
  for (let i = 0; i < 3; i++) { expect(await f.setMode('source')).toBe(true); expect(await f.setMode('rich')).toBe(true) }
  expect((await f.owner.flush()).raw).toBe(raw)
  expect(changes).toEqual([])
})

it('shares Source and Rich history and has reachable pending/discard controls', async () => {
  let allowed = false
  const f = await setup('A\n', { policy: { acceptRawChange: () => allowed } })
  await f.setMode('source')
  const ta = f.container.querySelector('textarea')!
  ta.value = 'draft'; ta.dispatchEvent(new Event('input'))
  await expect(f.owner.flush()).rejects.toThrow()
  expect(await f.setMode('rich')).toBe(false)
  expect(f.owner.installBaseline({ documentId: 'file.md', authority: 'b', raw: 'other' }).ok).toBe(false)
  expect(f.container.textContent).toContain('Discard')
  const discard = [...f.container.querySelectorAll('button')].find(b => /Discard/.test(b.textContent ?? ''))!
  discard.click()
  allowed = true
  ta.value = 'B'; ta.dispatchEvent(new Event('input'))
  expect(await f.setMode('rich')).toBe(true)
  expect(f.owner.undo()).toBe(true)
  expect((await f.owner.flush()).raw).toBe('A\n')
  expect(f.owner.redo()).toBe(true)
  expect((await f.owner.flush()).raw).toBe('B')
})

it('keeps decoration layers outside raw, history and change notifications', async () => {
  let changes = 0
  const f = await setup('A\n\nB\n', { onChange() { changes++ } })
  const id = f.owner.snapshot().bindings[0].id
  const original = f.owner.snapshot()
  f.decorations.setLayer('review', [{ blockId: id, kind: 'proposal', label: 'Review' }])
  expect(f.container.querySelector('[data-cdr-kind="proposal"]')?.textContent).toBe('A')
  f.decorations.removeLayer('review')
  expect(f.container.querySelector('[data-cdr-kind="proposal"]')).toBeNull()
  expect(f.owner.snapshot()).toEqual(original)
  expect(f.owner.canUndo()).toBe(false)
  expect(changes).toBe(0)
})

it('isolates owner observer failures and honors unsubscribe before queued delivery', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const f = await setup('A', { onChange() { throw new Error('host callback') } })
    const seen: string[] = [], removed = vi.fn()
    f.owner.observe(() => { throw new Error('owner callback') })
    f.owner.observe(value => seen.push(value.raw))
    const stop = f.owner.observe(removed)
    expect(f.owner.restoreContent('B').ok).toBe(true)
    stop()
    await Promise.resolve()
    expect(seen).toEqual(['B'])
    expect(removed).not.toHaveBeenCalled()
    expect(f.owner.snapshot().raw).toBe('B')
  } finally { errors.mockRestore() }
})

it('admits native Rich composition transactions while flush and mode switch wait for end', async () => {
  const target = document.createElement('div'); document.body.append(target)
  const session = await mountFileEditor(target, { file: { documentId: 'ime', authority: 'a', raw: 'A' },
    adapters: { mediaResolver: new BrowserMediaResolver() } }, {})
  editors.push(session)
  session.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  session.view.dispatch(session.view.state.tr.insertText('中', 2).setMeta('composition', 1))
  expect(session.owner.snapshot().raw).toBe('A中')
  expect(session.owner.undo()).toBe(false)
  let finished = false
  const flush = session.owner.flush().then(value => { finished = true; return value })
  const switchMode = session.setMode('source')
  await Promise.resolve()
  expect(finished).toBe(false)
  session.view.dispatch(session.view.state.tr.insertText('文', 3).setMeta('composition', 1))
  session.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  expect((await flush).raw).toBe('A中文')
  expect(await switchMode).toBe(true)
  expect(target.querySelector('textarea')?.value).toBe('A中文')
})

it('installs the explicit new baseline policy atomically and notifies after returning', async () => {
  let fail = false, counter = 0
  const f = await setup('O\n', { policy: { acceptRawChange: (_before, after) => after.includes('O') }, ids: {
    blockId: () => { if (fail) throw new Error('candidate-fault'); return `b${++counter}` }, lineage: () => `l${++counter}`, tableId: () => `t${++counter}`,
  } })
  expect(f.owner.restoreContent('O edit\n').ok).toBe(true)
  await Promise.resolve()
  const before = f.owner.snapshot()
  fail = true
  const invalid = f.owner.installBaseline({ documentId: 'f', authority: 'b', raw: 'N\n' }, { policy: null })
  fail = false
  expect(invalid.ok).toBe(false)
  expect(f.owner.snapshot()).toEqual(before)
  expect(f.owner.restoreContent('remove O'.replace('O', '')).ok).toBe(false)
  let observed = 0
  f.owner.observe(() => observed++)
  expect(f.owner.installBaseline({ documentId: 'f', authority: 'b', raw: 'N\n' },
    { policy: { acceptRawChange: (_before, after) => after.includes('N') } }).ok).toBe(true)
  expect(observed).toBe(0)
  expect(f.owner.canUndo()).toBe(false)
  await Promise.resolve(); expect(observed).toBe(1)
  expect(f.owner.restoreContent('N edit\n').ok).toBe(true)
  expect(f.owner.restoreContent('O\n').ok).toBe(false)
})

it('flushes the owned popup latest text before debounce, rejects stale writes and allows explicit discard', async () => {
  const f = await setup('{>>old<<}\n')
  expect(f.annotations.editAt(1)).toBe(true)
  const target = document.createElement('div'); document.body.append(target)
  popups.push(mount(NoteEditPopup, { target })); await tick()
  const ta = target.querySelector('textarea')!
  ta.value = 'latest'; ta.dispatchEvent(new Event('input', { bubbles: true })); await tick()
  expect((await f.owner.flush()).raw).toBe('{>>latest<<}\n')
  const owned = noteUi.edit!
  expect(owned.save('again')).toBe(true)
  expect(f.owner.snapshot().raw).toBe('{>>again<<}\n')
  expect(f.owner.restoreContent('{>>external<<}\n').ok).toBe(true)
  expect(owned.save('stale')).toBe(false)
  await expect(f.owner.flush()).rejects.toThrow()
  await tick()
  ;[...target.querySelectorAll('button')].find(b => /Discard/.test(b.textContent ?? ''))!.click(); await tick()
  expect(await f.setMode('source')).toBe(true)
  expect(f.owner.snapshot().raw).toBe('{>>external<<}\n')
})

it('desktop tab activation waits for the same owner and preserves rejected source drafts', async () => {
  const { tabs, activeId, activate, overwriteOnDisk } = await import('../lib/tabs.svelte')
  const target = document.createElement('div'); document.body.append(target)
  const session = await mountFileEditor(target, { file: { documentId: 'a', authority: 'a', raw: 'A' },
    adapters: { mediaResolver: new BrowserMediaResolver() }, policy: { acceptRawChange: () => false } }, {})
  editors.push(session); registerFileEditorSession('file-owner-test-a', session)
  const base = { filePath: '', title: 'test', initialContent: 'A', currentContent: 'A', mode: 'source' as const,
    kind: 'markdown' as const, externalState: 'fresh' as const, externalBannerDismissed: false, lastKnownMtime: 0, lastKnownHash: '' }
  tabs.push({ ...base, id: 'file-owner-test-a' }, { ...base, id: 'file-owner-test-b' }); activeId.value = 'file-owner-test-a'
  try {
    await session.setMode('source')
    const textarea = target.querySelector('textarea')!
    textarea.value = 'Draft'; textarea.dispatchEvent(new Event('input'))
    await expect(overwriteOnDisk('file-owner-test-a')).rejects.toThrow('file-rejected')
    await activate('file-owner-test-b')
    expect(activeId.value).toBe('file-owner-test-a')
    expect(textarea.value).toBe('Draft')
    ;[...target.querySelectorAll('button')].find(b => /Discard/.test(b.textContent ?? ''))!.click()
    await activate('file-owner-test-b')
    expect(activeId.value).toBe('file-owner-test-b')
  } finally { tabs.splice(0); activeId.value = null; await closeFileEditorSession('file-owner-test-a').catch(() => {}) }
})
