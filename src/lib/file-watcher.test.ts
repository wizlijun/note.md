/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./fs', () => ({
  readMd: vi.fn(),
  writeMd: vi.fn(),
  basename: (p: string) => p.split('/').pop() ?? p,
  classifyPath: () => ({ kind: 'markdown' }),
  isSupportedPath: () => true,
  looksBinary: () => false,
  modeKeyFor: () => 'md',
  statFile: vi.fn(),
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

describe('verifyAllOpen', () => {
  it('marks a clean tab autoReload when disk content differs', async () => {
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')          // initial open
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })  // open
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('B')          // verify pass
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 2000, size: 1 })  // verify
    const tabs = await import('./tabs.svelte')
    const watcher = await import('./file-watcher.svelte')
    await tabs.openFile('/tmp/foo.md')
    await watcher.verifyAllOpen()
    const t = tabs.tabs[0]
    expect(t.externalState).toBe('fresh')         // clean → auto-reloaded, stays fresh
    expect(t.initialContent).toBe('B')
    expect(t.currentContent).toBe('B')
    expect(t.lastKnownMtime).toBe(2000)
  })

  it('marks a dirty tab as changed when disk content differs', async () => {
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('B')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 2000, size: 1 })
    const tabs = await import('./tabs.svelte')
    const watcher = await import('./file-watcher.svelte')
    await tabs.openFile('/tmp/foo.md')
    tabs.setContent(tabs.tabs[0].id, 'edited')
    await watcher.verifyAllOpen()
    const t = tabs.tabs[0]
    expect(t.externalState).toBe('changed')
    expect(t.pendingExternal?.content).toBe('B')
    expect(t.pendingExternal?.mtime).toBe(2000)
  })

  it('marks a tab as deleted when stat returns null', async () => {
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)        // deleted
    const tabs = await import('./tabs.svelte')
    const watcher = await import('./file-watcher.svelte')
    await tabs.openFile('/tmp/foo.md')
    await watcher.verifyAllOpen()
    expect(tabs.tabs[0].externalState).toBe('deleted')
  })

  it('does nothing when stat returns the same mtime and content (no-op poll)', async () => {
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })
    const tabs = await import('./tabs.svelte')
    const watcher = await import('./file-watcher.svelte')
    await tabs.openFile('/tmp/foo.md')
    await watcher.verifyAllOpen()
    expect(tabs.tabs[0].externalState).toBe('fresh')
  })
})
