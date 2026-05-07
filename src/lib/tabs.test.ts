import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./fs', () => ({
  readMd: vi.fn(async (p: string) => `# content of ${p}`),
  writeMd: vi.fn(async () => {}),
  basename: (p: string) => p.split('/').pop() ?? p,
  isMarkdownPath: (p: string) => p.endsWith('.md'),
}))

vi.mock('./settings.svelte', () => ({
  pushRecentFile: vi.fn(async () => {}),
  getRecentMode: vi.fn(() => null),
  setRecentMode: vi.fn(async () => {}),
  settings: { autoSave: false },
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

  it('openFile rejects non-markdown extensions', async () => {
    const m = await import('./tabs.svelte')
    await expect(m.openFile('/tmp/foo.txt')).rejects.toThrow(/markdown/i)
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

  it('closeTab removes when not dirty without prompt', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    const ok = await m.closeTab(id, async () => 'cancel')
    expect(ok).toBe(true)
    expect(m.tabs.length).toBe(0)
    expect(m.activeId.value).toBe(null)
  })

  it('closeTab dirty → calls confirm; cancel keeps tab', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    m.setContent(id, 'edited')
    const ok = await m.closeTab(id, async () => 'cancel')
    expect(ok).toBe(false)
    expect(m.tabs.length).toBe(1)
  })

  it('closeTab dirty → save branch saves and removes', async () => {
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

  it('closeTab dirty → discard branch removes without saving', async () => {
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

  it('closeTab dirty non-active tab → save restores original active', async () => {
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
    expect(settings.setRecentMode).toHaveBeenCalledWith('/tmp/bar.md', 'rich')
  })

  it('openFile uses recent mode when available', async () => {
    const settings = await import('./settings.svelte')
    ;(settings.getRecentMode as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce('rich')
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    expect(m.tabs[0].mode).toBe('rich')
  })
})
