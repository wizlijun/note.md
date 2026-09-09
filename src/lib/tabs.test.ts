import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CanvasProbeResult } from './canvas/io'

vi.mock('./fs', () => ({
  readMd: vi.fn(async (p: string) => `# content of ${p}`),
  writeMd: vi.fn(async () => {}),
  basename: (p: string) => p.split('/').pop() ?? p,
  classifyPath: (p: string) => {
    const lower = p.toLowerCase()
    if (/\.(md|markdown|mdown|mkd)$/.test(lower)) return { kind: 'markdown' }
    if (/\.html?$/.test(lower)) return { kind: 'html' }
    if (/\.py$/.test(lower)) return { kind: 'code', language: 'python' }
    if (/\.json$/.test(lower)) return { kind: 'code', language: 'json' }
    if (/\.txt$/.test(lower)) return { kind: 'code', language: '' }
    if (/\.csv$/.test(lower)) return { kind: 'spreadsheet' }
    if (/\.canvas$/.test(lower)) return { kind: 'canvas' }
    if (/\.tsv$/.test(lower)) return { kind: 'code', language: '' }
    if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|heic|heif|avif)$/.test(lower)) return { kind: 'image' }
    return null
  },
  isSupportedPath: (p: string) => /\.(md|markdown|mdown|mkd|html?|py|json|txt|csv|tsv|canvas|png|jpg|jpeg|gif|webp|svg|bmp|heic|heif|avif)$/i.test(p),
  looksBinary: (s: string) => s.indexOf('\x00') >= 0,
  modeKeyFor: (p: string) => {
    const base = (p.split('/').pop() ?? p).toLowerCase()
    const dot = base.lastIndexOf('.')
    return dot <= 0 ? base : base.slice(dot + 1)
  },
  statFile: vi.fn(async () => ({ mtime: 1_700_000_000_000, size: 100 })),
}))

vi.mock('./settings.svelte', () => ({
  pushRecentFile: vi.fn(async () => {}),
  getRecentMode: vi.fn(() => null),
  setRecentMode: vi.fn(async () => {}),
  settings: { autoSave: false },
}))

vi.mock('./file-watcher.svelte', () => ({
  startWatchingTab: vi.fn(async () => {}),
  stopWatchingTab: vi.fn(async () => {}),
  rebindTabPath: vi.fn(async () => {}),
  verifyAllOpen: vi.fn(async () => {}),
}))

// Default: pickSaveFile returns a path (simulates user completing the save panel)
vi.mock('./dialogs', () => ({
  pickSaveFile: vi.fn(async (defaultPath?: string) => defaultPath ?? '/tmp/untitled.md'),
  pickSaveCanvasFile: vi.fn(async (defaultPath?: string) => defaultPath ?? '/tmp/untitled.canvas'),
  confirmDirtyClose: vi.fn(async () => 'discard'),
  pickOpenFile: vi.fn(async () => null),
  showError: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn(async () => false),  // default: user clicks "Keep Editing"
}))

const canvasRevision = { mtimeNs: '1700000000000000000', size: 27, sha256: 'canvas-hash' }
const canvasOpen = vi.fn(async (path: string) => ({
  text: '{"nodes":[],"edges":[]}\n', revision: canvasRevision,
  requestedPath: path, canonicalPath: path,
}))
const canvasCreate = vi.fn(async (path: string, _text: string) => ({ revision: canvasRevision, canonicalPath: path }))
const canvasProbe = vi.fn<(path: string) => Promise<CanvasProbeResult>>(async (path: string) => ({
  kind: 'present' as const, revision: canvasRevision, requestedPath: path, canonicalPath: path,
}))
const canvasSave = vi.fn(async (
  path: string,
  _text: string,
  _revision?: typeof canvasRevision,
  _force?: boolean,
) => ({ revision: canvasRevision, canonicalPath: path }))
vi.mock('./i18n/store.svelte', () => ({
  t: (k: string) => k,
}))

vi.mock('./platform.svelte', () => ({ isIOS: vi.fn(async () => false) }))

const fsRename = vi.fn(async (_from: string, _to: string) => {})
const fsExists = vi.fn(async (_path: string) => false)
const fsMkdir = vi.fn(async (_path: string, _options: { recursive: boolean }) => {})
const tauriInvoke = vi.fn(async (_command: string, ..._args: unknown[]): Promise<unknown> => null)
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, ...args: unknown[]) => tauriInvoke(command, ...args),
}))
vi.mock('@tauri-apps/plugin-fs', () => ({
  rename: (from: string, to: string) => fsRename(from, to),
  exists: (path: string) => fsExists(path),
  mkdir: (path: string, options: { recursive: boolean }) => fsMkdir(path, options),
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: vi.fn(async () => ({
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => false),
      save: vi.fn(async () => {}),
    })),
  },
}))

// Default: identity cache is cold (matches app boot before warmHumanActor()
// resolves) — newFile() must sign nothing until a test opts into a warm cache.
const humanActorNowMock = vi.fn((): string | null => null)
vi.mock('./okf/identity', () => ({
  humanActorNow: () => humanActorNowMock(),
}))

beforeEach(async () => {
  // Let dynamic imports started by the preceding save/watcher operation
  // finish before invalidating the module graph.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  vi.clearAllMocks()
  vi.resetModules()
  tauriInvoke.mockReset().mockImplementation(async (command, rawArgs) => {
    const args = rawArgs as { path: string; text: string; expected: { revision: typeof canvasRevision }; force: boolean }
    if (command === 'canvas_document_open') return canvasOpen(args.path)
    if (command === 'canvas_document_probe') return canvasProbe(args.path)
    if (command === 'canvas_document_create') return canvasCreate(args.path, args.text)
    if (command === 'canvas_document_save') return canvasSave(args.path, args.text, args.expected.revision, args.force)
    if (command === 'sotvault_vault_root') return '/vault'
    if (command === 'notemd_quick_note_dir') return '/vault/inbox'
    if (command === 'sotvault_check_update') return { outcome: 'untracked' }
    return null
  })
  fsMkdir.mockReset().mockResolvedValue(undefined)
  fsRename.mockReset().mockResolvedValue(undefined)
  fsExists.mockResolvedValue(false)
  humanActorNowMock.mockReturnValue(null)
  const fs = await import('./fs')
  vi.mocked(fs.readMd).mockReset().mockImplementation(async (path) => `# content of ${path}`)
  vi.mocked(fs.writeMd).mockReset().mockResolvedValue(undefined)
})

afterEach(() => { vi.useRealTimers() })

async function readPersistedMarkdown(): Promise<void> {
  const fs = await import('./fs')
  vi.mocked(fs.readMd).mockImplementation(async (path) =>
    [...vi.mocked(fs.writeMd).mock.calls].reverse().find(([writtenPath]) => writtenPath === path)?.[1] ?? `# content of ${path}`)
}

describe('tabs', () => {
  it('openFile reads file and creates a tab', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    expect(m.tabs.length).toBe(1)
    expect(m.tabs[0].filePath).toBe('/tmp/foo.md')
    expect(m.tabs[0].title).toBe('foo.md')
    expect(m.tabs[0].currentContent).toContain('content of /tmp/foo.md')
    expect(m.activeId.value).toBe(m.tabs[0].id)
  })

  it('openFile is idempotent: same path → switch tab, no duplicate', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/a.md')
    await m.openFile('/tmp/b.md')
    expect(m.tabs.length).toBe(2)
    expect(m.activeId.value).toBe(m.tabs[1].id)
    await m.openFile('/tmp/a.md')
    expect(m.tabs.length).toBe(2)
    expect(m.activeId.value).toBe(m.tabs[0].id)
  })

  it('replaceCurrentFile reuses the source tab identity and watcher', async () => {
    const watcher = await import('./file-watcher.svelte')
    const settings = await import('./settings.svelte')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/2026-09-09.timeline.md')
    const id = m.tabs[0].id
    vi.clearAllMocks()

    await m.replaceCurrentFile('/tmp/2026-09-10.timeline.md', '/tmp/2026-09-09.timeline.md')

    expect(m.tabs).toHaveLength(1)
    expect(m.tabs[0].id).toBe(id)
    expect(m.tabs[0].filePath).toBe('/tmp/2026-09-10.timeline.md')
    expect(m.tabs[0].currentContent).toContain('/tmp/2026-09-10.timeline.md')
    expect(m.activeId.value).toBe(id)
    expect(watcher.stopWatchingTab).toHaveBeenCalledWith(id)
    expect(watcher.startWatchingTab).toHaveBeenCalledWith(m.tabs[0])
    expect(settings.pushRecentFile).toHaveBeenCalledWith('/tmp/2026-09-10.timeline.md')
  })

  it('replaceCurrentFile binds to the named source tab instead of whichever tab is active', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/2026-09-09.timeline.md')
    const sourceId = m.tabs[0].id
    await m.openFile('/tmp/other.md')
    expect(m.activeTab()?.filePath).toBe('/tmp/other.md')

    await m.replaceCurrentFile('/tmp/2026-09-10.timeline.md', '/tmp/2026-09-09.timeline.md')

    expect(m.tabs).toHaveLength(2)
    expect(m.tabs.find((tab) => tab.id === sourceId)?.filePath).toBe('/tmp/2026-09-10.timeline.md')
    expect(m.activeId.value).toBe(sourceId)
    expect(m.tabs.some((tab) => tab.filePath === '/tmp/other.md')).toBe(true)
  })

  it('replaceCurrentFile refuses to discard source edits', async () => {
    const watcher = await import('./file-watcher.svelte')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/2026-09-09.timeline.md')
    const id = m.tabs[0].id
    m.setContent(id, '# edited')
    vi.clearAllMocks()

    await expect(m.replaceCurrentFile(
      '/tmp/2026-09-10.timeline.md',
      '/tmp/2026-09-09.timeline.md',
    )).rejects.toThrow('未保存')

    expect(m.tabs).toHaveLength(1)
    expect(m.tabs[0].filePath).toBe('/tmp/2026-09-09.timeline.md')
    expect(watcher.stopWatchingTab).not.toHaveBeenCalled()
  })

  it('replaceCurrentFile activates an existing destination and closes the clean source tab', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/2026-09-09.timeline.md')
    const sourceId = m.tabs[0].id
    await m.openFile('/tmp/2026-09-10.timeline.md')
    const destinationId = m.tabs[1].id

    await m.replaceCurrentFile('/tmp/2026-09-10.timeline.md', '/tmp/2026-09-09.timeline.md')

    expect(m.tabs).toHaveLength(1)
    expect(m.tabs[0].id).toBe(destinationId)
    expect(m.tabs.some((tab) => tab.id === sourceId)).toBe(false)
    expect(m.activeId.value).toBe(destinationId)
  })

  it('keeps a controlled memory projection read-only across edit and save paths', async () => {
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('# MEMORY\n')
    const projection = await import('./memory-projection')
    projection.setMemoryProjectionVaultRoot('/vault')
    const m = await import('./tabs.svelte')
    await m.openFile('/vault/MEMORY.md')
    const tab = m.tabs[0]
    const original = tab.currentContent

    expect(m.isManagedMemoryTab(tab)).toBe(true)
    m.setContent(tab.id, '# direct edit')
    expect(tab.currentContent).toBe(original)

    // A second guard at persistence time covers any component that mutates the
    // tab object without going through setContent.
    tab.currentContent = '# bypassed UI guard'
    await m.saveActive()
    await m.saveTab(tab.id)
    await m.overwriteOnDisk(tab.id)
    await m.restoreVersion(tab.id, '# old version')
    await m.saveAs(tab.id, '/tmp/copy.md')

    expect(fs.writeMd).not.toHaveBeenCalled()
    expect(tab.filePath).toBe('/vault/MEMORY.md')
    expect(tab.initialContent).toBe(original)
  })

  it('openFile falls back to plain text (kind=code) for an unknown extension with no plugin', async () => {
    // file-over-app: an unrecognised extension (and no custom-editor plugin
    // claiming it) opens as plain text instead of throwing.
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/notes.base')
    expect(m.tabs.length).toBe(1)
    const t = m.tabs[0]
    expect(t.kind).toBe('code')
    expect(t.language).toBe('')
    expect(t.currentContent).toContain('content of /tmp/notes.base')
    expect(m.activeId.value).toBe(t.id)
  })

  it('openFile plain-text fallback still refuses binary content', async () => {
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('bin\x00ary')
    const m = await import('./tabs.svelte')
    await expect(m.openFile('/tmp/foo.weird')).rejects.toThrow(/binary/i)
    expect(m.tabs.length).toBe(0)
  })

  it('openFile plain-text fallback is idempotent (same path → switch, no dup)', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/a.unknownext')
    await m.openFile('/tmp/a.unknownext')
    expect(m.tabs.length).toBe(1)
  })

  it('openFile routes to a custom editor when a v2 plugin claims the extension', async () => {
    // Register a plugin (in the same fresh module graph) that owns .base, then
    // open a .base → the tab becomes kind=custom carrying the editor binding.
    const rt = await import('./plugins/runtime.svelte')
    rt.pluginRuntime.manifests = [{
      id: 'notemd.base', name: 'Base', version: '1.0.0', binary: '',
      host_capabilities: [],
      custom_editors: [{ id: 'base-table', file_extensions: ['.base'], entry: 'editor.html' }],
    }]
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/table.base')
    const t = m.tabs[0]
    expect(t.kind).toBe('custom')
    expect(t.editorPluginId).toBe('notemd.base')
    expect(t.editorId).toBe('base-table')
    expect(t.editorEntry).toBe('editor.html')
    // Content is still read as text (host owns document I/O).
    expect(t.currentContent).toContain('content of /tmp/table.base')
  })

  it('openFile keeps .canvas on the built-in surface when a plugin claims it', async () => {
    const rt = await import('./plugins/runtime.svelte')
    rt.pluginRuntime.manifests = [{
      id: 'canvas.hijacker', name: 'Canvas Hijacker', version: '1.0.0', binary: '',
      host_capabilities: [],
      custom_editors: [{ id: 'canvas-editor', file_extensions: ['.canvas'], entry: 'editor.html' }],
    }]
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/board.canvas')
    expect(m.tabs[0].kind).toBe('canvas')
    expect(m.tabs[0].mode).toBe('rich')
    expect(m.tabs[0].editorId).toBeUndefined()
  })

  it('canvas mode is fixed to rich and never writes a recent editor mode', async () => {
    const settings = await import('./settings.svelte')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/board.canvas')
    const tab = m.tabs[0]
    m.setMode(tab.id, 'source')
    m.toggleMode(tab.id)
    expect(tab.mode).toBe('rich')
    expect(settings.setRecentMode).not.toHaveBeenCalled()
    await m.saveActive()
    expect(settings.setRecentMode).not.toHaveBeenCalled()
  })

  it('saveAs keeps the canvas extension boundary in both directions', async () => {
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/board.canvas')
    const canvas = m.tabs[0]
    await expect(m.saveAs(canvas.id, '/tmp/board.json')).rejects.toThrow(/\.canvas/i)
    expect(fs.writeMd).not.toHaveBeenCalled()

    await m.openFile('/tmp/note.md')
    const markdown = m.tabs[1]
    await expect(m.saveAs(markdown.id, '/tmp/note.canvas')).rejects.toThrow(/only canvas/i)
    expect(fs.writeMd).not.toHaveBeenCalled()
  })

  it('saves canvas through the revision-checked writer and marks that snapshot clean', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/board.canvas')
    const canvas = m.tabs[0]
    const next = '{"nodes":[{"id":"n","type":"text","text":"one","x":0,"y":0,"width":100,"height":100}],"edges":[]}'
    m.setContent(canvas.id, next)

    await m.saveActive()

    expect(canvasSave).toHaveBeenCalledWith('/tmp/board.canvas', next, canvasRevision, false)
    expect(canvas.initialContent).toBe(next)
    expect(canvas.currentContent).toBe(next)
    expect(canvas.externalState).toBe('fresh')
  })

  it.each(['saveActive', 'saveTab'] as const)('%s names an untitled canvas from its first usable text card exactly once', async (saveMethod) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 8, 9, 7, 5))
    const m = await import('./tabs.svelte')
    await m.openFile('/vault/canvas/untitled-2.canvas')
    const canvas = m.tabs[0]
    const snapshot = JSON.stringify({ nodes: [
      { id: 'link', type: 'link', url: 'https://example.com', x: 0, y: 0, width: 100, height: 100 },
      { id: 'empty', type: 'text', text: ' \n ', x: 100, y: 0, width: 100, height: 100 },
      { id: 'placeholder', type: 'text', text: '# 新卡片\n\n双击开始编辑', x: 200, y: 0, width: 100, height: 100 },
      { id: 'title', type: 'text', text: '\n\n## 产品 思考\n\n正文', x: 300, y: 0, width: 100, height: 100 },
      { id: 'later', type: 'text', text: '# Later title', x: 400, y: 0, width: 100, height: 100 },
    ], edges: [] })
    m.setContent(canvas.id, snapshot)

    if (saveMethod === 'saveActive') await m.saveActive()
    else await m.saveTab(canvas.id)

    expect(canvasSave).toHaveBeenCalledWith('/vault/canvas/untitled-2.canvas', snapshot, canvasRevision, false)
    expect(fsRename).toHaveBeenCalledWith('/vault/canvas/untitled-2.canvas', '/vault/canvas/2026-09-08-产品-思考.canvas')
    expect(canvasSave.mock.invocationCallOrder[0]).toBeLessThan(fsRename.mock.invocationCallOrder[0])
    expect(canvas.filePath).toBe('/vault/canvas/2026-09-08-产品-思考.canvas')
    expect(canvas.title).toBe('2026-09-08-产品-思考.canvas')
    expect(canvas.initialContent).toBe(snapshot)
    expect(m.isDirty(canvas.id)).toBe(false)

    m.setContent(canvas.id, snapshot.replace('产品 思考', '新的名字'))
    if (saveMethod === 'saveActive') await m.saveActive()
    else await m.saveTab(canvas.id)
    expect(fsRename).toHaveBeenCalledOnce()
    expect(canvasSave.mock.calls.at(-1)?.[0]).toBe('/vault/canvas/2026-09-08-产品-思考.canvas')
  })

  it('explicitly saving a canvas without a usable title names it with the local date and time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 8, 9, 7, 5))
    const m = await import('./tabs.svelte')
    await m.openFile('/vault/canvas/untitled.canvas')
    await m.saveActive()
    expect(fsRename).toHaveBeenCalledWith('/vault/canvas/untitled.canvas', '/vault/canvas/2026-09-08-090705.canvas')
  })

  it('canvas autosave persists the temporary path without naming a partially typed title', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/vault/canvas/untitled.canvas')
    const canvas = m.tabs[0]
    const snapshot = JSON.stringify({ nodes: [{ id: 't', type: 'text', text: '# 产品', x: 0, y: 0, width: 100, height: 100 }], edges: [] })
    m.setContent(canvas.id, snapshot)
    await m.persistCanvasSnapshot(canvas, snapshot)
    expect(canvasSave).toHaveBeenCalledWith('/vault/canvas/untitled.canvas', snapshot, canvasRevision, false)
    expect(fsRename).not.toHaveBeenCalled()
    expect(canvas.filePath).toBe('/vault/canvas/untitled.canvas')
    expect(canvas.initialContent).toBe(snapshot)
  })

  it('canvas naming skips an existing date-title filename', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 8, 9, 7, 5))
    fsExists.mockImplementation(async (path) => path === '/vault/canvas/2026-09-08-090705.canvas')
    const m = await import('./tabs.svelte')
    await m.openFile('/vault/canvas/untitled.canvas')
    await m.saveActive()
    expect(fsRename).toHaveBeenCalledWith('/vault/canvas/untitled.canvas', '/vault/canvas/2026-09-08-090705-2.canvas')
  })

  it('a failed canvas rename keeps the saved temporary document and its clean baseline', async () => {
    fsRename.mockRejectedValueOnce(new Error('EPERM'))
    const m = await import('./tabs.svelte')
    await m.openFile('/vault/canvas/untitled.canvas')
    const canvas = m.tabs[0]
    m.setContent(canvas.id, '{"nodes":[],"edges":[],"saved":true}')
    await expect(m.saveActive()).resolves.toBeUndefined()
    expect(canvasSave).toHaveBeenCalledOnce()
    expect(fsRename).toHaveBeenCalledOnce()
    expect(canvas.filePath).toBe('/vault/canvas/untitled.canvas')
    expect(canvas.initialContent).toBe(canvas.currentContent)
    expect(m.isDirty(canvas.id)).toBe(false)
  })

  it('queues canvas autosave behind an in-flight rename and persists to the new identity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 8, 9, 7, 5))
    let finishRename: (() => void) | undefined
    fsRename.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRename = resolve }))
    const m = await import('./tabs.svelte')
    await m.openFile('/vault/canvas/untitled.canvas')
    const canvas = m.tabs[0]
    const manualSave = m.saveActive()
    await vi.waitFor(() => expect(fsRename).toHaveBeenCalledOnce())
    const newer = '{"nodes":[],"edges":[],"newer":true}'
    m.setContent(canvas.id, newer)
    const autosave = m.persistCanvasSnapshot(canvas, newer)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(canvasSave).toHaveBeenCalledOnce()
    finishRename?.()
    await Promise.all([manualSave, autosave])
    expect(canvasSave).toHaveBeenNthCalledWith(2, '/vault/canvas/2026-09-08-090705.canvas', newer, canvasRevision, false)
    expect(canvas.initialContent).toBe(newer)
    expect(canvas.currentContent).toBe(newer)
  })

  it('serializes automatic naming across canvas tabs so simultaneous saves choose distinct names', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 8, 9, 7, 5))
    const files = new Set<string>()
    fsExists.mockImplementation(async (path) => files.has(path))
    let finishFirstRename: (() => void) | undefined
    fsRename.mockImplementation(async (_from, to) => {
      if (fsRename.mock.calls.length === 1) await new Promise<void>((resolve) => { finishFirstRename = resolve })
      files.add(to)
    })
    const m = await import('./tabs.svelte')
    await m.openFile('/vault/canvas/untitled.canvas')
    await m.openFile('/vault/canvas/untitled-2.canvas')
    const saves = m.tabs.map((canvas) => m.saveTab(canvas.id))
    await vi.waitFor(() => expect(fsRename).toHaveBeenCalledOnce())
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(fsRename).toHaveBeenCalledOnce()
    finishFirstRename?.()
    await Promise.all(saves)
    expect(fsRename.mock.calls.map(([, to]) => to)).toEqual([
      '/vault/canvas/2026-09-08-090705.canvas', '/vault/canvas/2026-09-08-090705-2.canvas',
    ])
    expect(new Set(m.tabs.map((canvas) => canvas.filePath)).size).toBe(2)
  })

  it.each(['newer edit', 'original baseline'] as const)('keeps a canvas dirty when its buffer becomes the %s during an older save', async (bufferState) => {
    let finishSave: ((value: { revision: typeof canvasRevision; canonicalPath: string }) => void) | undefined
    canvasSave.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve }))
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/board.canvas')
    const canvas = m.tabs[0]
    const originalSnapshot = canvas.currentContent
    const savedSnapshot = '{"nodes":[],"edges":[],"snapshot":1}'
    const newerSnapshot = bufferState === 'original baseline' ? originalSnapshot : '{"nodes":[],"edges":[],"snapshot":2}'
    m.setContent(canvas.id, savedSnapshot)

    const saving = m.saveActive()
    await vi.waitFor(() => expect(canvasSave).toHaveBeenCalledTimes(1))
    m.setContent(canvas.id, newerSnapshot)
    finishSave?.({ revision: canvasRevision, canonicalPath: '/tmp/board.canvas' })
    await saving

    expect(canvas.initialContent).toBe(savedSnapshot)
    expect(canvas.currentContent).toBe(newerSnapshot)
    expect(m.isDirty(canvas.id)).toBe(true)
  })

  it('serializes Canvas Save As behind an in-flight save and keeps the new identity', async () => {
    const oldSavedRevision = { mtimeNs: '1700000001000000000', size: 28, sha256: 'old-saved' }
    const targetRevision = { mtimeNs: '1700000002000000000', size: 29, sha256: 'target-before' }
    const targetSavedRevision = { mtimeNs: '1700000003000000000', size: 30, sha256: 'target-saved' }
    let finishOldSave: ((value: { revision: typeof canvasRevision; canonicalPath: string }) => void) | undefined
    canvasSave
      .mockImplementationOnce(() => new Promise((resolve) => { finishOldSave = resolve }))
      .mockResolvedValueOnce({ revision: targetSavedRevision, canonicalPath: '/tmp/copy.canvas' })
    canvasProbe.mockResolvedValueOnce({
      kind: 'present', revision: targetRevision,
      requestedPath: '/tmp/copy.canvas', canonicalPath: '/tmp/copy.canvas',
    })
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/board.canvas')
    const canvas = m.tabs[0]
    m.setContent(canvas.id, '{"nodes":[],"edges":[],"save":1}')

    const saving = m.saveActive()
    await vi.waitFor(() => expect(canvasSave).toHaveBeenCalledTimes(1))
    const savingAs = m.saveAs(canvas.id, '/tmp/copy.canvas')
    await Promise.resolve()
    expect(canvasProbe).not.toHaveBeenCalled()

    finishOldSave?.({ revision: oldSavedRevision, canonicalPath: '/tmp/board.canvas' })
    await saving
    await savingAs

    expect(canvasSave).toHaveBeenNthCalledWith(1, '/tmp/board.canvas', expect.any(String), canvasRevision, false)
    expect(canvasSave).toHaveBeenNthCalledWith(2, '/tmp/copy.canvas', expect.any(String), targetRevision, false)
    expect(canvas.filePath).toBe('/tmp/copy.canvas')
    expect(canvas.title).toBe('copy.canvas')
    expect(canvas.canvasRevision).toEqual(targetSavedRevision)
  })

  it('drops an autosave snapshot whose captured path became stale while queued', async () => {
    const targetRevision = { mtimeNs: '1700000002000000000', size: 29, sha256: 'target-before' }
    const targetSavedRevision = { mtimeNs: '1700000003000000000', size: 30, sha256: 'target-saved' }
    let finishSaveAs: ((value: { revision: typeof canvasRevision; canonicalPath: string }) => void) | undefined
    canvasProbe.mockResolvedValueOnce({
      kind: 'present', revision: targetRevision,
      requestedPath: '/tmp/copy.canvas', canonicalPath: '/tmp/copy.canvas',
    })
    canvasSave.mockImplementationOnce(() => new Promise((resolve) => { finishSaveAs = resolve }))
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/board.canvas')
    const canvas = m.tabs[0]
    const oldPath = canvas.filePath

    const savingAs = m.saveAs(canvas.id, '/tmp/copy.canvas')
    await vi.waitFor(() => expect(canvasSave).toHaveBeenCalledTimes(1))
    const staleAutosave = m.persistCanvasSnapshot(canvas, '{"stale":true}', false, oldPath)
    finishSaveAs?.({ revision: targetSavedRevision, canonicalPath: '/tmp/copy.canvas' })
    await savingAs
    await staleAutosave

    expect(canvas.filePath).toBe('/tmp/copy.canvas')
    expect(canvas.canvasRevision).toEqual(targetSavedRevision)
    expect(canvasSave).toHaveBeenCalledTimes(1)
  })

  it('does not let an old Canvas save completion restore a rebound identity', async () => {
    const reboundRevision = { mtimeNs: '1700000004000000000', size: 31, sha256: 'rebound' }
    let finishSave: ((value: { revision: typeof canvasRevision; canonicalPath: string }) => void) | undefined
    canvasSave.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve }))
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/board.canvas')
    const canvas = m.tabs[0]
    m.setContent(canvas.id, '{"nodes":[],"edges":[],"save":1}')

    const saving = m.saveActive()
    await vi.waitFor(() => expect(canvasSave).toHaveBeenCalledTimes(1))
    canvas.filePath = '/tmp/rebound.canvas'
    canvas.title = 'rebound.canvas'
    canvas.canvasRevision = reboundRevision
    finishSave?.({ revision: canvasRevision, canonicalPath: '/tmp/board.canvas' })
    await saving

    expect(canvas.filePath).toBe('/tmp/rebound.canvas')
    expect(canvas.title).toBe('rebound.canvas')
    expect(canvas.canvasRevision).toEqual(reboundRevision)
  })

  it('exports a Canvas copy without changing the open tab identity or dirty baseline', async () => {
    canvasProbe.mockResolvedValueOnce({
      kind: 'missing', requestedPath: '/tmp/export.canvas', canonicalPath: '/tmp/export.canvas',
    })
    const watcher = await import('./file-watcher.svelte')
    const settings = await import('./settings.svelte')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/board.canvas')
    const canvas = m.tabs[0]
    const edited = '{"nodes":[],"edges":[],"edited":true}'
    m.setContent(canvas.id, edited)
    const identityBefore = {
      filePath: canvas.filePath,
      title: canvas.title,
      revision: canvas.canvasRevision,
      initialContent: canvas.initialContent,
      lastKnownMtime: canvas.lastKnownMtime,
      lastKnownHash: canvas.lastKnownHash,
      externalState: canvas.externalState,
    }

    await m.exportCanvasCopy(canvas.id, '/tmp/export.canvas')

    expect(canvasCreate).toHaveBeenCalledWith('/tmp/export.canvas', edited)
    expect(canvas).toMatchObject({
      filePath: identityBefore.filePath,
      title: identityBefore.title,
      canvasRevision: identityBefore.revision,
      initialContent: identityBefore.initialContent,
      lastKnownMtime: identityBefore.lastKnownMtime,
      lastKnownHash: identityBefore.lastKnownHash,
      externalState: identityBefore.externalState,
    })
    expect(m.isDirty(canvas.id)).toBe(true)
    expect(watcher.rebindTabPath).not.toHaveBeenCalled()
    expect(settings.pushRecentFile).toHaveBeenCalledTimes(1)
  })

  it('surfaces a revision conflict as an external canvas change and keeps the local buffer', async () => {
    const actualRevision = { mtimeNs: '1700000001000000000', size: 31, sha256: 'external-hash' }
    canvasSave.mockRejectedValueOnce({
      kind: 'conflict', message: 'canvas changed on disk',
      expected: { kind: 'present', revision: canvasRevision },
      actual: { kind: 'present', revision: actualRevision },
      canonicalPath: '/tmp/board.canvas',
    })
    canvasOpen
      .mockResolvedValueOnce({
        text: '{"nodes":[],"edges":[]}', revision: canvasRevision,
        requestedPath: '/tmp/board.canvas', canonicalPath: '/tmp/board.canvas',
      })
      .mockResolvedValueOnce({
        text: '{"nodes":[],"edges":[],"external":true}', revision: actualRevision,
        requestedPath: '/tmp/board.canvas', canonicalPath: '/tmp/board.canvas',
      })
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/board.canvas')
    const canvas = m.tabs[0]
    m.setContent(canvas.id, '{"nodes":[],"edges":[],"local":true}')

    await expect(m.saveActive()).rejects.toMatchObject({ kind: 'conflict' })

    expect(canvas.externalState).toBe('changed')
    expect(canvas.pendingExternal).toMatchObject({
      content: '{"nodes":[],"edges":[],"external":true}',
      hash: 'external-hash',
    })
    expect(canvas.currentContent).toContain('"local":true')
  })

  it('setContent toggles dirty correctly', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    m.setContent(id, 'new content')
    expect(m.isDirty(id)).toBe(true)
    m.setContent(id, m.tabs[0].initialContent)
    expect(m.isDirty(id)).toBe(false)
  })

  it('saveActive writes current content and updates baseline', async () => {
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    m.setContent(id, 'edited')
    expect(m.isDirty(id)).toBe(true)
    await m.saveActive()
    expect(fs.writeMd).toHaveBeenCalledWith('/tmp/foo.md', 'edited')
    expect(m.isDirty(id)).toBe(false)
  })

  it('saveActive refuses to write when externalState is "changed"', async () => {
    // The banner provides the explicit reconciliation UI (Reload / Overwrite /
    // Save as…). A blind ⌘S during this state would silently clobber the
    // external change — so saveActive must refuse and let the caller surface
    // a useful error.
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const t = m.tabs[0]
    m.setContent(t.id, 'mine')
    t.externalState = 'changed'
    t.pendingExternal = { mtime: 5000, hash: 'h-X', content: 'theirs' }
    await expect(m.saveActive()).rejects.toThrow(/external/i)
    expect(fs.writeMd).not.toHaveBeenCalled()
    // State must not have been mutated.
    expect(t.externalState).toBe('changed')
    expect(t.currentContent).toBe('mine')
  })

  it('saveActive still works when externalState is "deleted" (Recreate-on-Save)', async () => {
    // The deleted state has no external content to clobber — the file is
    // gone, and the banner's "Recreate on Save (⌘S)" button explicitly
    // delegates here. Only 'changed' is blocked.
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const t = m.tabs[0]
    m.setContent(t.id, 'recreated body')
    t.externalState = 'deleted'
    await m.saveActive()
    expect(fs.writeMd).toHaveBeenCalledWith('/tmp/foo.md', 'recreated body')
    expect(t.externalState).toBe('fresh')
  })

  it('closeTab removes when not dirty without prompt', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    const ok = await m.closeTab(id, async () => 'cancel')
    expect(ok).toBe(true)
    expect(m.tabs.length).toBe(0)
    expect(m.activeId.value).toBe(null)
  })

  // ── NAMED dirty file: uses the confirm() callback ───────────────────────────
  it('closeTab named dirty → confirm=save → saves to same path and closes', async () => {
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    m.setContent(id, 'edited')
    const ok = await m.closeTab(id, async () => 'save')
    expect(ok).toBe(true)
    expect(fs.writeMd).toHaveBeenCalledWith('/tmp/foo.md', 'edited')
    expect(m.tabs.length).toBe(0)
  })

  it('closeTab named dirty → confirm=discard → closes without saving', async () => {
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    m.setContent(id, 'edited')
    const ok = await m.closeTab(id, async () => 'discard')
    expect(ok).toBe(true)
    expect(fs.writeMd).not.toHaveBeenCalled()
    expect(m.tabs.length).toBe(0)
  })

  it('closeTab named dirty → confirm=cancel → tab stays', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    m.setContent(id, 'edited')
    const ok = await m.closeTab(id, async () => 'cancel')
    expect(ok).toBe(false)
    expect(m.tabs.length).toBe(1)
  })

  it('closeTab named dirty passes the basename to the confirm callback', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    m.setContent(id, 'edited')
    const confirmSpy = vi.fn(async () => 'discard' as const)
    await m.closeTab(id, confirmSpy)
    expect(confirmSpy).toHaveBeenCalledWith('foo.md')
  })

  // ── UNTITLED dirty file: goes straight to NSSavePanel ───────────────────────
  it('closeTab untitled dirty → user picks save path → saves and closes', async () => {
    const dialogs = await import('./dialogs')
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    vi.mocked(dialogs.pickSaveFile).mockResolvedValueOnce('/tmp/saved.md')
    await m.openPathBackedMarkdownDraft('/tmp/untitled.md', '')
    m.tabs[0].filePath = ''
    const id = m.tabs[0].id
    m.setContent(id, 'new content')
    const ok = await m.closeTab(id, async () => 'cancel')
    expect(ok).toBe(true)
    expect(fs.writeMd).toHaveBeenCalledWith('/tmp/saved.md', 'new content')
    expect(m.tabs.length).toBe(0)
  })

  it('closeTab untitled dirty → cancels save panel + keeps editing → tab stays', async () => {
    const dialogs = await import('./dialogs')
    const tauri = await import('@tauri-apps/plugin-dialog')
    const m = await import('./tabs.svelte')
    vi.mocked(dialogs.pickSaveFile).mockResolvedValueOnce(null)
    vi.mocked(tauri.ask).mockResolvedValueOnce(false)  // Cancel (keep editing)
    await m.openPathBackedMarkdownDraft('/tmp/untitled.md', '')
    m.tabs[0].filePath = ''
    const id = m.tabs[0].id
    m.setContent(id, 'new content')
    const ok = await m.closeTab(id, async () => 'cancel')
    expect(ok).toBe(false)
    expect(m.tabs.length).toBe(1)
  })

  it('closeTab untitled dirty → cancels save panel + discards → closes without saving', async () => {
    const dialogs = await import('./dialogs')
    const tauri = await import('@tauri-apps/plugin-dialog')
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    vi.mocked(dialogs.pickSaveFile).mockResolvedValueOnce(null)
    vi.mocked(tauri.ask).mockResolvedValueOnce(true)  // Don't Save (close)
    await m.openPathBackedMarkdownDraft('/tmp/untitled.md', '')
    m.tabs[0].filePath = ''
    const id = m.tabs[0].id
    m.setContent(id, 'new content')
    const ok = await m.closeTab(id, async () => 'cancel')
    expect(ok).toBe(true)
    expect(fs.writeMd).not.toHaveBeenCalled()
    expect(m.tabs.length).toBe(0)
  })

  it('closing active tab activates a sibling', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/a.md')
    await m.openFile('/tmp/b.md')
    await m.openFile('/tmp/c.md')
    const bId = m.tabs[1].id
    m.activate(bId)
    await m.closeTab(bId, async () => 'discard')
    expect(m.tabs.length).toBe(2)
    expect(m.activeId.value).toBe(m.tabs[1].id)  // C (originally idx 2, now idx 1 after splice)
  })

  it('toggleMode flips source ⇄ rich', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    expect(m.tabs[0].mode).toBe('rich')
    m.toggleMode(id)
    expect(m.tabs[0].mode).toBe('source')
    m.toggleMode(id)
    expect(m.tabs[0].mode).toBe('rich')
  })

  it('closeTab dirty non-active named tab → save=same path restores original active', async () => {
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/a.md')
    await m.openFile('/tmp/b.md')
    await m.openFile('/tmp/c.md')
    const aId = m.tabs[0].id
    const bId = m.tabs[1].id
    m.activate(aId)             // A is active
    m.setContent(bId, 'edited') // B dirty
    const ok = await m.closeTab(bId, async () => 'save')
    expect(ok).toBe(true)
    expect(fs.writeMd).toHaveBeenCalledWith('/tmp/b.md', 'edited')
    expect(m.tabs.length).toBe(2)
    expect(m.activeId.value).toBe(aId)  // A still active, NOT C
  })

  it('saveAs renames path, updates title/baseline, clears dirty, persists mode', async () => {
    const fs = await import('./fs')
    const settings = await import('./settings.svelte')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    m.toggleMode(id)              // rich (default) → source
    m.setContent(id, 'edited')
    expect(m.isDirty(id)).toBe(true)
    await m.saveAs(id, '/tmp/bar.md')
    expect(fs.writeMd).toHaveBeenCalledWith('/tmp/bar.md', 'edited')
    expect(m.tabs[0].filePath).toBe('/tmp/bar.md')
    expect(m.tabs[0].title).toBe('bar.md')
    expect(m.isDirty(id)).toBe(false)
    expect(settings.pushRecentFile).toHaveBeenCalledWith('/tmp/bar.md')
    // Allow setRecentMode to flush
    await new Promise((r) => setTimeout(r, 0))
    expect(settings.setRecentMode).toHaveBeenCalledWith('md', 'source')
  })

  it('openFile uses stored mode for extension', async () => {
    const settings = await import('./settings.svelte')
    ;(settings.getRecentMode as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce('rich')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    expect(m.tabs[0].mode).toBe('rich')
  })

  it('openFile defaults to rich when no stored mode', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    expect(m.tabs[0].mode).toBe('rich')
  })

  it('openPathBackedMarkdownDraft uses the stored mode for the extension', async () => {
    const settings = await import('./settings.svelte')
    ;(settings.getRecentMode as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce('source')
    const m = await import('./tabs.svelte')
    await m.openPathBackedMarkdownDraft('/tmp/quick.md', '', { skipEmptySave: true })
    expect(m.tabs[0].mode).toBe('source')
  })

  it('openPathBackedMarkdownDraft honours an explicit mode over the stored one', async () => {
    const settings = await import('./settings.svelte')
    const stored = settings.getRecentMode as unknown as ReturnType<typeof vi.fn>
    // Not `mockReturnValueOnce`: an explicit mode short-circuits the lookup, so a
    // queued value would go unconsumed and leak into the next test.
    stored.mockReturnValue('source')
    try {
      const m = await import('./tabs.svelte')
      await m.openPathBackedMarkdownDraft('/tmp/note.md', '', { mode: 'rich' })
      expect(m.tabs[0].mode).toBe('rich')
    } finally {
      stored.mockReturnValue(null)
    }
  })

  it.each(['saveActive', 'saveTab'] as const)('%s keeps a newer markdown edit dirty and names only the saved snapshot', async (saveMethod) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 8, 9, 7, 5))
    const fs = await import('./fs')
    const { sha256Hex } = await import('./hash')
    const m = await import('./tabs.svelte')
    await m.openFile('/vault/inbox/untitled.md')
    const note = m.tabs[0]
    const saved = '# Saved title\n\nSaved body'
    const newer = '# Newer title\n\nNot on disk yet'
    let finishWrite!: () => void
    vi.mocked(fs.writeMd).mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve }))
    m.setContent(note.id, saved)
    const saving = m[saveMethod](note.id)
    await vi.waitFor(() => expect(fs.writeMd).toHaveBeenCalledOnce())
    m.setContent(note.id, newer)
    finishWrite()
    await saving

    expect(fs.writeMd).toHaveBeenCalledWith('/vault/inbox/untitled.md', saved)
    expect(note.currentContent).toBe(newer)
    expect(note.initialContent).toBe(saved)
    expect(m.isDirty(note.id)).toBe(true)
    expect(note.lastKnownHash).toBe(await sha256Hex(saved))
    expect(fsRename).toHaveBeenCalledWith('/vault/inbox/untitled.md', '/vault/inbox/2026-09-08-Saved-title.md')
  })

  it('keeps markdown dirty when editing returns to the old baseline during a pending save', async () => {
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/note.md')
    const note = m.tabs[0]
    const baseline = note.initialContent
    let finishWrite!: () => void
    vi.mocked(fs.writeMd).mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve }))
    m.setContent(note.id, '# Saved replacement\n')
    const saving = m.saveActive()
    await vi.waitFor(() => expect(fs.writeMd).toHaveBeenCalledOnce())
    m.setContent(note.id, baseline)
    finishWrite()
    await saving

    expect(note.currentContent).toBe(baseline)
    expect(m.isDirty(note.id)).toBe(true)
    expect(note.initialContent).toBe('# Saved replacement\n')
  })

  it('queues a markdown save behind naming and writes the new path without recreating untitled', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 8, 9, 7, 5))
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/vault/inbox/untitled.md')
    const note = m.tabs[0]
    let finishRename!: () => void
    fsRename.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRename = resolve }))
    m.setContent(note.id, '# First title\n')
    const first = m.saveActive()
    await vi.waitFor(() => expect(fsRename).toHaveBeenCalledOnce())
    m.setContent(note.id, '# Updated title\n')
    const second = m.saveTab(note.id)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const writesWhileNaming = vi.mocked(fs.writeMd).mock.calls.length
    finishRename()
    await Promise.all([first, second])

    expect(writesWhileNaming).toBe(1)
    expect(fs.writeMd).toHaveBeenNthCalledWith(2, '/vault/inbox/2026-09-08-First-title.md', '# Updated title\n')
    expect(fsRename).toHaveBeenCalledOnce()
    expect(m.isDirty(note.id)).toBe(false)
  })

  it('drops a stale markdown autosave path queued behind naming and accepts the next snapshot at its new path', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 8, 9, 7, 5))
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/vault/inbox/untitled.md')
    const note = m.tabs[0]
    const temporaryPath = note.filePath
    let finishRename!: () => void
    fsRename.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRename = resolve }))
    m.setContent(note.id, '# First title\n')
    const saving = m.saveActive()
    await vi.waitFor(() => expect(fsRename).toHaveBeenCalledOnce())
    m.setContent(note.id, '# Newer content\n')
    const staleAutosave = m.persistMarkdownSnapshot(note, note.currentContent, true, temporaryPath)
    finishRename()
    await saving

    expect(await staleAutosave).toBeUndefined()
    expect(fs.writeMd).toHaveBeenCalledOnce()
    expect(m.isDirty(note.id)).toBe(true)
    expect(note.filePath).toBe('/vault/inbox/2026-09-08-First-title.md')
    await m.persistMarkdownSnapshot(note, note.currentContent, true, note.filePath)
    expect(fs.writeMd).toHaveBeenNthCalledWith(2, note.filePath, '# Newer content\n')
    expect(m.isDirty(note.id)).toBe(false)
  })

  it('saveActive renames a titled quick note after its H1', async () => {
    const m = await import('./tabs.svelte')
    await m.openPathBackedMarkdownDraft('/vault/inbox/2026-07-25-193045-quick.md', '', {
      skipEmptySave: true,
    })
    m.setContent(m.tabs[0].id, '# 产品思考\n\nbody')
    await m.saveActive()
    expect(fsRename).toHaveBeenCalledWith(
      '/vault/inbox/2026-07-25-193045-quick.md',
      '/vault/inbox/2026-07-25-产品思考.md',
    )
    expect(m.tabs[0].filePath).toBe('/vault/inbox/2026-07-25-产品思考.md')
    expect(m.tabs[0].title).toBe('2026-07-25-产品思考.md')
  })

  it('the auto-save path holds off until the title line is finished', async () => {
    const m = await import('./tabs.svelte')
    await m.openPathBackedMarkdownDraft('/vault/inbox/2026-07-25-193045-quick.md', '', {
      skipEmptySave: true,
    })
    const t = m.tabs[0]
    // Mid-typing: an 800 ms auto-save must not freeze a partial heading.
    m.setContent(t.id, '# 产品')
    await m.renameAutoQuickNoteIfTitled(t, true)
    expect(fsRename).not.toHaveBeenCalled()
    // Enter pressed → the title is settled and the rename lands.
    m.setContent(t.id, '# 产品思考\n')
    await m.renameAutoQuickNoteIfTitled(t, true)
    expect(fsRename).toHaveBeenCalledWith(
      '/vault/inbox/2026-07-25-193045-quick.md',
      '/vault/inbox/2026-07-25-产品思考.md',
    )
  })

  it('saveActive leaves an untitled quick note under its generated name', async () => {
    const m = await import('./tabs.svelte')
    await m.openPathBackedMarkdownDraft('/vault/inbox/2026-07-25-193045-quick.md', '', {
      skipEmptySave: true,
    })
    m.setContent(m.tabs[0].id, 'no heading, just text')
    await m.saveActive()
    expect(fsRename).not.toHaveBeenCalled()
    expect(m.tabs[0].filePath).toBe('/vault/inbox/2026-07-25-193045-quick.md')
  })

  it('quick-note rename sidesteps an existing file instead of clobbering it', async () => {
    fsExists.mockImplementation(
      async (p: unknown) => p === '/vault/inbox/2026-07-25-产品思考.md',
    )
    const m = await import('./tabs.svelte')
    await m.openPathBackedMarkdownDraft('/vault/inbox/2026-07-25-193045-quick.md', '', {
      skipEmptySave: true,
    })
    m.setContent(m.tabs[0].id, '# 产品思考')
    await m.saveActive()
    expect(fsRename).toHaveBeenCalledWith(
      '/vault/inbox/2026-07-25-193045-quick.md',
      '/vault/inbox/2026-07-25-产品思考-2.md',
    )
  })

  it('a failed quick-note rename leaves the saved file in place', async () => {
    fsRename.mockRejectedValueOnce(new Error('EPERM'))
    const m = await import('./tabs.svelte')
    await m.openPathBackedMarkdownDraft('/vault/inbox/2026-07-25-193045-quick.md', '', {
      skipEmptySave: true,
    })
    m.setContent(m.tabs[0].id, '# 产品思考')
    await expect(m.saveActive()).resolves.toBeUndefined()
    expect(m.tabs[0].filePath).toBe('/vault/inbox/2026-07-25-193045-quick.md')
  })

  it('setMode persists choice keyed by extension', async () => {
    const settings = await import('./settings.svelte')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    m.toggleMode(m.tabs[0].id)   // rich (default) → source
    await new Promise((r) => setTimeout(r, 0))
    expect(settings.setRecentMode).toHaveBeenCalledWith('md', 'source')
  })

  it('openFile classifies markdown', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    expect(m.tabs[0].kind).toBe('markdown')
    expect(m.tabs[0].language).toBeUndefined()
    expect(m.tabs[0].mode).toBe('rich')
  })

  it('openFile classifies html with default rich mode', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/index.html')
    expect(m.tabs[0].kind).toBe('html')
    expect(m.tabs[0].mode).toBe('rich')
  })

  it('openFile classifies code with language', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/script.py')
    expect(m.tabs[0].kind).toBe('code')
    expect(m.tabs[0].language).toBe('python')
    expect(m.tabs[0].mode).toBe('rich')
  })

  it('openFile rejects binary content', async () => {
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('plain\x00text')
    const m = await import('./tabs.svelte')
    await expect(m.openFile('/tmp/foo.md')).rejects.toThrow(/binary/i)
    expect(m.tabs.length).toBe(0)
  })

  it('saveAs reclassifies tab when extension changes', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    await m.saveAs(id, '/tmp/foo.py')
    expect(m.tabs[0].kind).toBe('code')
    expect(m.tabs[0].language).toBe('python')
    expect(m.tabs[0].title).toBe('foo.py')
  })

  it('openFile populates externalState/lastKnownMtime/lastKnownHash', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const t = m.tabs[0]
    expect(t.externalState).toBe('fresh')
    expect(t.externalBannerDismissed).toBe(false)
    expect(typeof t.lastKnownMtime).toBe('number')
    expect(t.lastKnownHash).toMatch(/^[0-9a-f]{64}$/)
    expect(t.pendingExternal).toBeUndefined()
  })

  it('saveActive updates lastKnownMtime/lastKnownHash to post-write values', async () => {
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    m.setContent(id, 'edited')
    // Queue the post-write stat result so recordOurWrite captures it.
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      mtime: 9_999_999_999_999, size: 7,
    })
    await m.saveActive()
    const t = m.tabs.find((x) => x.id === id)!
    expect(t.lastKnownMtime).toBe(9_999_999_999_999)
    expect(t.lastKnownHash).toMatch(/^[0-9a-f]{64}$/)
    // After save, hash must be the hash of "edited"
    const { sha256Hex } = await import('./hash')
    expect(t.lastKnownHash).toBe(await sha256Hex('edited'))
  })

  it('reloadFromDisk replaces buffer with pendingExternal content and clears banner', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const t = m.tabs[0]
    // Simulate banner shown:
    m.setContent(t.id, 'edited')
    t.externalState = 'changed'
    t.pendingExternal = { mtime: 5000, hash: 'h-X', content: 'NEW DISK' }
    await m.reloadFromDisk(t.id)
    expect(t.currentContent).toBe('NEW DISK')
    expect(t.initialContent).toBe('NEW DISK')
    expect(t.externalState).toBe('fresh')
    expect(t.lastKnownMtime).toBe(5000)
    expect(t.lastKnownHash).toBe('h-X')
    expect(t.pendingExternal).toBeUndefined()
  })

  it('overwriteOnDisk writes the local buffer and clears banner', async () => {
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const t = m.tabs[0]
    m.setContent(t.id, 'mine')
    t.externalState = 'changed'
    t.pendingExternal = { mtime: 5000, hash: 'h-X', content: 'theirs' }
    await m.overwriteOnDisk(t.id)
    expect(fs.writeMd).toHaveBeenCalledWith('/tmp/foo.md', 'mine')
    expect(t.externalState).toBe('fresh')
    expect(t.pendingExternal).toBeUndefined()
  })

  it('dismissExternalBanner sets the flag without changing externalState', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const t = m.tabs[0]
    t.externalState = 'changed'
    m.dismissExternalBanner(t.id)
    expect(t.externalBannerDismissed).toBe(true)
    expect(t.externalState).toBe('changed')
  })

  it('openFile spreadsheet (csv): kind=spreadsheet, mode=rich', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/data.csv')
    const t = m.tabs[0]
    expect(t.kind).toBe('spreadsheet')
    expect(t.mode).toBe('rich')
    expect(t.currentContent).toContain('content of /tmp/data.csv')
  })

  it('openFile tsv: kind=code (tab-delimited not yet implemented), mode=rich', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/data.tsv')
    const t = m.tabs[0]
    expect(t.kind).toBe('code')
    expect(t.mode).toBe('rich')
  })

  it('openFile image: kind=image, currentContent empty, mode=rich', async () => {
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/photo.png')
    expect(m.tabs.length).toBe(1)
    const t = m.tabs[0]
    expect(t.kind).toBe('image')
    expect(t.currentContent).toBe('')
    expect(t.initialContent).toBe('')
    expect(t.mode).toBe('rich')
    expect(m.isDirty(t.id)).toBe(false)
    // readMd should NOT have been called for an image
    expect(fs.readMd).not.toHaveBeenCalled()
  })

  // ── newFile ─────────────────────────────────────────────────────────────────
  it('newCanvas creates an empty path-backed document in vault/canvas without a save panel', async () => {
    const dialogs = await import('./dialogs')
    const m = await import('./tabs.svelte')
    await m.newCanvas()
    expect(tauriInvoke).toHaveBeenCalledWith('sotvault_vault_root')
    expect(fsMkdir).toHaveBeenCalledWith('/vault/canvas', { recursive: true })
    expect(canvasCreate).toHaveBeenCalledWith('/vault/canvas/untitled.canvas', m.EMPTY_CANVAS_CONTENT)
    expect(m.tabs[0]).toMatchObject({
      filePath: '/vault/canvas/untitled.canvas', title: 'untitled.canvas', kind: 'canvas', mode: 'rich',
    })
    expect(JSON.parse(m.tabs[0].currentContent)).toEqual({ nodes: [], edges: [] })
    expect(dialogs.pickSaveCanvasFile).not.toHaveBeenCalled()
    expect(dialogs.pickSaveFile).not.toHaveBeenCalled()
  })

  it('newCanvas retries atomic creation conflicts instead of replacing an existing document', async () => {
    canvasCreate.mockRejectedValueOnce({ kind: 'conflict', message: 'already exists' })
    const m = await import('./tabs.svelte')
    await m.newCanvas()
    expect(canvasCreate).toHaveBeenNthCalledWith(1, '/vault/canvas/untitled.canvas', m.EMPTY_CANVAS_CONTENT)
    expect(canvasCreate).toHaveBeenNthCalledWith(2, '/vault/canvas/untitled-2.canvas', m.EMPTY_CANVAS_CONTENT)
    expect(m.tabs[0].filePath).toBe('/vault/canvas/untitled-2.canvas')
    expect(canvasSave).not.toHaveBeenCalled()
  })

  it('newCanvas creates distinct documents when two requests race for the same temporary filename', async () => {
    const createdPaths = new Set<string>()
    const createUnique = async (path: string) => {
      if (createdPaths.has(path)) throw { kind: 'conflict', message: 'already exists' }
      createdPaths.add(path)
      return { revision: canvasRevision, canonicalPath: path }
    }
    canvasCreate.mockImplementationOnce(createUnique).mockImplementationOnce(createUnique).mockImplementationOnce(createUnique)
    const m = await import('./tabs.svelte')
    // Concurrent dynamic imports can resolve the SDK directly in Vitest, so
    // its native transport uses the same backend fixture as the module mock.
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: tauriInvoke }, dispatchEvent: () => true })
    try {
      await Promise.all([m.newCanvas(), m.newCanvas()])
    } finally {
      vi.unstubAllGlobals()
    }

    expect(canvasCreate).toHaveBeenCalledTimes(3)
    expect([...createdPaths].sort()).toEqual(['/vault/canvas/untitled-2.canvas', '/vault/canvas/untitled.canvas'])
    expect(m.tabs.map((canvas) => canvas.filePath).sort()).toEqual([...createdPaths].sort())
    expect(canvasSave).not.toHaveBeenCalled()
  })

  it('newCanvas fails without a configured vault and writes nothing', async () => {
    const fs = await import('./fs')
    const dialogs = await import('./dialogs')
    tauriInvoke.mockResolvedValue(null)
    const m = await import('./tabs.svelte')
    await expect(m.newCanvas()).rejects.toThrow()
    expect(canvasCreate).not.toHaveBeenCalled()
    expect(fsMkdir).not.toHaveBeenCalled()
    expect(fs.writeMd).not.toHaveBeenCalled()
    expect(dialogs.pickSaveCanvasFile).not.toHaveBeenCalled()
    expect(m.tabs).toHaveLength(0)
  })

  it('newFile persists an empty OKF quick note before opening its clean path-backed tab', async () => {
    await readPersistedMarkdown()
    const fs = await import('./fs')
    const dialogs = await import('./dialogs')
    const m = await import('./tabs.svelte')
    await m.newFile()
    expect(m.tabs.length).toBe(1)
    const t = m.tabs[0]
    expect(t.filePath).toBe('/vault/inbox/untitled.md')
    expect(t.title).toBe('untitled.md')
    expect(t.kind).toBe('markdown')
    expect(t.currentContent).toBe('---\ntype: Note\n---\n')
    expect(t.initialContent).toBe(t.currentContent)
    expect(m.isDirty(t.id)).toBe(false)
    expect(m.activeId.value).toBe(t.id)
    expect(tauriInvoke).toHaveBeenCalledWith('notemd_quick_note_dir')
    expect(fs.writeMd).toHaveBeenCalledWith(t.filePath, t.currentContent)
    expect(vi.mocked(fs.writeMd).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fs.readMd).mock.invocationCallOrder[0])
    expect(dialogs.pickSaveFile).not.toHaveBeenCalled()
  })

  it('newFile uses the remembered markdown mode instead of the active code tab mode', async () => {
    await readPersistedMarkdown()
    const settings = await import('./settings.svelte')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/code.py')
    m.setMode(m.tabs[0].id, 'source')
    expect(m.tabs[0].mode).toBe('source')
    vi.mocked(settings.getRecentMode).mockReturnValueOnce('rich')
    await m.newFile()
    expect(m.tabs[1].mode).toBe('rich')
    expect(settings.getRecentMode).toHaveBeenLastCalledWith('md')
  })

  it('newFile uses the normal markdown rich mode when no mode was remembered', async () => {
    await readPersistedMarkdown()
    const m = await import('./tabs.svelte')
    await m.newFile()
    expect(m.tabs[0].mode).toBe('rich')
  })

  it('newFile allocates another inbox filename without replacing an existing note', async () => {
    await readPersistedMarkdown()
    fsExists.mockImplementation(async (path) => path === '/vault/inbox/untitled.md')
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.newFile()
    expect(m.tabs[0].filePath).toBe('/vault/inbox/untitled-2.md')
    expect(fs.writeMd).toHaveBeenCalledOnce()
    expect(fs.writeMd).toHaveBeenCalledWith('/vault/inbox/untitled-2.md', '---\ntype: Note\n---\n')
  })

  it('newFile signs the doc via humanActorNow() when the identity cache is warm', async () => {
    await readPersistedMarkdown()
    humanActorNowMock.mockReturnValue('human:testuser')
    const m = await import('./tabs.svelte')
    await m.newFile()
    expect(m.tabs[0].currentContent).toContain('generated:\n  by: human:testuser\n  at:')
  })

  it('newFile writes no generated key when the identity cache is cold', async () => {
    await readPersistedMarkdown()
    const m = await import('./tabs.svelte')
    await m.newFile()
    expect(m.tabs[0].currentContent).not.toContain('generated:')
  })

  it('path-backed markdown draft skips empty saves but writes non-empty content', async () => {
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openPathBackedMarkdownDraft('/tmp/inbox/quick.md', '', { skipEmptySave: true })
    const t = m.tabs[0]
    expect(t.filePath).toBe('/tmp/inbox/quick.md')
    expect(t.currentContent).toBe('')
    expect(m.isDirty(t.id)).toBe(false)

    await m.saveActive()
    expect(fs.writeMd).not.toHaveBeenCalled()

    m.setContent(t.id, 'hello')
    await m.saveActive()
    expect(fs.writeMd).toHaveBeenCalledWith('/tmp/inbox/quick.md', 'hello')
    expect(m.isDirty(t.id)).toBe(false)
  })

  it('path-backed markdown draft does not save over an existing file with empty content', async () => {
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openPathBackedMarkdownDraft('/tmp/inbox/quick.md', '', { skipEmptySave: true })
    const t = m.tabs[0]
    m.setContent(t.id, 'hello')
    await m.saveActive()
    ;(fs.writeMd as ReturnType<typeof vi.fn>).mockClear()

    m.setContent(t.id, '')
    await m.saveActive()
    expect(fs.writeMd).not.toHaveBeenCalled()
    expect(m.isDirty(t.id)).toBe(true)
  })

  it('newFile requests editor focus for its persisted path', async () => {
    await readPersistedMarkdown()
    const m = await import('./tabs.svelte')
    await m.newFile()
    const { consumeEditorFocus } = await import('./editor-focus.svelte')
    expect(consumeEditorFocus('/vault/inbox/untitled.md')).toBe(true)
    expect(consumeEditorFocus('/vault/inbox/untitled.md')).toBe(false)
  })

  it('openFile image: isDirty always false even after setContent', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/photo.jpg')
    const t = m.tabs[0]
    // Even if somehow content were set, isDirty stays false because initialContent=''
    expect(m.isDirty(t.id)).toBe(false)
  })

  it('openFile image: lastKnownMtime populated from stat', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/img.svg')
    const t = m.tabs[0]
    expect(t.lastKnownMtime).toBe(1_700_000_000_000)
    expect(t.lastKnownHash).toBe('')
  })

  it('updateTabPath rebinds filePath and title without touching content', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/old.md')
    const tab = m.tabs.find((t: { filePath: string }) => t.filePath === '/tmp/old.md')!
    m.setContent(tab.id, 'edited')
    await m.updateTabPath('/tmp/old.md', '/tmp/new.md')
    expect(tab.filePath).toBe('/tmp/new.md')
    expect(tab.title).toBe('new.md')
    expect(tab.currentContent).toBe('edited')
  })

  it('updateTabPath rewrites exact references in open canvases and preserves extensions', async () => {
    canvasOpen.mockResolvedValueOnce({
      text: JSON.stringify({
        nodes: [
          { id: 'f', type: 'file', file: 'asset.png', x: 0, y: 0, width: 100, height: 100, vendor: 7 },
          { id: 'g', type: 'group', label: 'G', background: 'asset.png', x: 0, y: 0, width: 200, height: 200 },
        ],
        edges: [],
      }),
      revision: canvasRevision,
      requestedPath: '/tmp/board.canvas',
      canonicalPath: '/tmp/board.canvas',
    })
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/board.canvas')

    await m.updateTabPath('/tmp/asset.png', '/tmp/renamed.png')

    const saved = JSON.parse(m.tabs[0].currentContent)
    expect(saved.nodes[0]).toMatchObject({ file: 'renamed.png', vendor: 7 })
    expect(saved.nodes[1]).toMatchObject({ background: 'renamed.png' })
    expect(m.isDirty(m.tabs[0].id)).toBe(true)
  })
  it('updateTabPath is a no-op when no tab has the path', async () => {
    const m = await import('./tabs.svelte')
    await expect(m.updateTabPath('/tmp/nope.md', '/tmp/x.md')).resolves.toBeUndefined()
  })

  // ── restoreVersion (git history "Restore this version") ──────────────────────
  it('restoreVersion writes the old content to disk and lands the tab clean', async () => {
    // Restore = confirm rollback: persist immediately and clear dirty, so the
    // user never has to press ⌘S. The buffer is re-read from disk (auto-reload
    // path), so currentContent === initialContent === the restored bytes.
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const t = m.tabs[0]
    m.setContent(t.id, 'user edits')          // dirty with unrelated content
    expect(m.isDirty(t.id)).toBe(true)
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('OLD VERSION')
    await m.restoreVersion(t.id, 'OLD VERSION')
    expect(fs.writeMd).toHaveBeenCalledWith('/tmp/foo.md', 'OLD VERSION')
    expect(t.currentContent).toBe('OLD VERSION')
    expect(t.initialContent).toBe('OLD VERSION')
    expect(m.isDirty(t.id)).toBe(false)
  })

  it('restoreVersion dispatches notemd:auto-reloaded so every editor rebuilds', async () => {
    // OutlineEditor (and SourceView cursor-preserve) only refresh on this event;
    // reusing the auto-reload path is what makes restore visible in all modes.
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const t = m.tabs[0]
    const dispatched: CustomEvent[] = []
    ;(globalThis as Record<string, unknown>).window = {
      dispatchEvent: (e: CustomEvent) => dispatched.push(e),
    }
    try {
      ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('V1')
      await m.restoreVersion(t.id, 'V1')
    } finally {
      delete (globalThis as Record<string, unknown>).window
    }
    const evt = dispatched.find((e) => e.type === 'notemd:auto-reloaded')
    expect(evt).toBeTruthy()
    expect(evt!.detail.tabId).toBe(t.id)
    expect(evt!.detail.newContent).toBe('V1')
  })

  it('restoreVersion is a no-op for an untitled (path-less) tab', async () => {
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    await m.openPathBackedMarkdownDraft('/tmp/untitled.md', '')
    m.tabs[0].filePath = ''
    const t = m.tabs[0]
    await m.restoreVersion(t.id, 'X')
    expect(fs.writeMd).not.toHaveBeenCalled()
  })
})

describe('shouldSkipEmptySave — 预置 frontmatter 的草稿仍算空', () => {
  it('treats a draft that is only an OKF concept head as empty', async () => {
    const { shouldSkipEmptySave } = await import('./tabs.svelte')
    const tab = { skipEmptySave: true, currentContent: '---\ntype: Note\n---\n' } as never
    expect(shouldSkipEmptySave(tab)).toBe(true)
  })
  it('saves once the user has written a body', async () => {
    const { shouldSkipEmptySave } = await import('./tabs.svelte')
    const tab = { skipEmptySave: true, currentContent: '---\ntype: Note\n---\n# 标题\n' } as never
    expect(shouldSkipEmptySave(tab)).toBe(false)
  })
})
