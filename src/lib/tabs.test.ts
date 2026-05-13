import { describe, it, expect, vi, beforeEach } from 'vitest'

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
    if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|heic|heif|avif)$/.test(lower)) return { kind: 'image' }
    return null
  },
  isSupportedPath: (p: string) => /\.(md|markdown|mdown|mkd|html?|py|json|txt|png|jpg|jpeg|gif|webp|svg|bmp|heic|heif|avif)$/i.test(p),
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
  confirmDirtyClose: vi.fn(async () => 'discard'),
  pickOpenFile: vi.fn(async () => null),
  showError: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn(async () => false),  // default: user clicks "Keep Editing"
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

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

  it('openFile rejects unsupported extensions', async () => {
    const m = await import('./tabs.svelte')
    await expect(m.openFile('/tmp/foo.exe')).rejects.toThrow(/unsupported/i)
    expect(m.tabs.length).toBe(0)
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

  it('closeTab dirty → user picks save path → saves to chosen path and closes', async () => {
    const dialogs = await import('./dialogs')
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    vi.mocked(dialogs.pickSaveFile).mockResolvedValueOnce('/tmp/saved.md')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    m.setContent(id, 'edited')
    const ok = await m.closeTab(id, async () => 'cancel')
    expect(ok).toBe(true)
    expect(fs.writeMd).toHaveBeenCalledWith('/tmp/saved.md', 'edited')
    expect(m.tabs.length).toBe(0)
  })

  it('closeTab dirty → user cancels save panel + keeps editing → tab stays', async () => {
    const dialogs = await import('./dialogs')
    const tauri = await import('@tauri-apps/plugin-dialog')
    const m = await import('./tabs.svelte')
    vi.mocked(dialogs.pickSaveFile).mockResolvedValueOnce(null)
    vi.mocked(tauri.ask).mockResolvedValueOnce(false)  // Keep Editing
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    m.setContent(id, 'edited')
    const ok = await m.closeTab(id, async () => 'cancel')
    expect(ok).toBe(false)
    expect(m.tabs.length).toBe(1)
  })

  it('closeTab dirty → user cancels save panel + discards → tab closes without saving', async () => {
    const dialogs = await import('./dialogs')
    const tauri = await import('@tauri-apps/plugin-dialog')
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    vi.mocked(dialogs.pickSaveFile).mockResolvedValueOnce(null)
    vi.mocked(tauri.ask).mockResolvedValueOnce(true)  // Close without Saving
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    m.setContent(id, 'edited')
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
    expect(m.tabs[0].mode).toBe('source')
    m.toggleMode(id)
    expect(m.tabs[0].mode).toBe('rich')
    m.toggleMode(id)
    expect(m.tabs[0].mode).toBe('source')
  })

  it('closeTab dirty non-active tab → save to same path restores original active', async () => {
    const dialogs = await import('./dialogs')
    const fs = await import('./fs')
    const m = await import('./tabs.svelte')
    vi.mocked(dialogs.pickSaveFile).mockResolvedValueOnce('/tmp/b.md')
    await m.openFile('/tmp/a.md')
    await m.openFile('/tmp/b.md')
    await m.openFile('/tmp/c.md')
    const aId = m.tabs[0].id
    const bId = m.tabs[1].id
    m.activate(aId)             // A is active
    m.setContent(bId, 'edited') // B dirty
    const ok = await m.closeTab(bId, async () => 'cancel')
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
    m.toggleMode(id)              // mode = 'rich'
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
    expect(settings.setRecentMode).toHaveBeenCalledWith('md', 'rich')
  })

  it('openFile uses stored mode for extension', async () => {
    const settings = await import('./settings.svelte')
    ;(settings.getRecentMode as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce('rich')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    expect(m.tabs[0].mode).toBe('rich')
  })

  it('openFile defaults to source when no stored mode', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    expect(m.tabs[0].mode).toBe('source')
  })

  it('setMode persists choice keyed by extension', async () => {
    const settings = await import('./settings.svelte')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    m.toggleMode(m.tabs[0].id)
    await new Promise((r) => setTimeout(r, 0))
    expect(settings.setRecentMode).toHaveBeenCalledWith('md', 'rich')
  })

  it('openFile classifies markdown', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    expect(m.tabs[0].kind).toBe('markdown')
    expect(m.tabs[0].language).toBeUndefined()
    expect(m.tabs[0].mode).toBe('source')
  })

  it('openFile classifies html with default source mode', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/index.html')
    expect(m.tabs[0].kind).toBe('html')
    expect(m.tabs[0].mode).toBe('source')
  })

  it('openFile classifies code with language', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/script.py')
    expect(m.tabs[0].kind).toBe('code')
    expect(m.tabs[0].language).toBe('python')
    expect(m.tabs[0].mode).toBe('source')
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
})
