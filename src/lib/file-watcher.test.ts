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

vi.mock('@tauri-apps/plugin-fs', () => ({
  watchImmediate: vi.fn(async () => () => {}),
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
    tabs.toggleMode(tabs.tabs[0].id)              // → source: only source-mode tabs autoReload
    await watcher.verifyAllOpen()
    const t = tabs.tabs[0]
    expect(t.externalState).toBe('fresh')         // clean source tab → auto-reloaded, stays fresh
    expect(t.initialContent).toBe('B')
    expect(t.currentContent).toBe('B')
    expect(t.lastKnownMtime).toBe(2000)
  })

  it('rich-mode clean tab + external modify → changed (banner), no silent reload', async () => {
    // Regression: previously rich-mode tabs hit the autoReload fast-path,
    // which left the ProseMirror view stale while tab.currentContent was
    // swapped underneath. The next keystroke/destroy-flush then overwrote
    // the disk's new content with the editor's pre-change state.
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('B')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 2000, size: 1 })
    const tabs = await import('./tabs.svelte')
    const watcher = await import('./file-watcher.svelte')
    await tabs.openFile('/tmp/foo.md')
    tabs.setMode(tabs.tabs[0].id, 'rich')
    await watcher.verifyAllOpen()
    const t = tabs.tabs[0]
    expect(t.externalState).toBe('changed')
    expect(t.pendingExternal?.content).toBe('B')
    // Critical: tab.currentContent must NOT have been silently swapped.
    expect(t.currentContent).toBe('A')
    expect(t.initialContent).toBe('A')
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

describe('startWatchingTab / stopWatchingTab', () => {
  it('startWatchingTab subscribes via watchImmediate and stop unsubscribes', async () => {
    const unwatch = vi.fn()
    const plug = await import('@tauri-apps/plugin-fs')
    ;(plug.watchImmediate as ReturnType<typeof vi.fn>).mockResolvedValueOnce(unwatch)
    const tabs = await import('./tabs.svelte')
    const watcher = await import('./file-watcher.svelte')
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })
    await tabs.openFile('/tmp/foo.md')
    await watcher.startWatchingTab(tabs.tabs[0])
    expect(plug.watchImmediate).toHaveBeenCalledWith('/tmp/foo.md', expect.any(Function))
    await watcher.stopWatchingTab(tabs.tabs[0].id)
    expect(unwatch).toHaveBeenCalled()
  })

  it('rebindTabPath stops the old subscription and starts a new one', async () => {
    const unwatchOld = vi.fn()
    const unwatchNew = vi.fn()
    const plug = await import('@tauri-apps/plugin-fs')
    ;(plug.watchImmediate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(unwatchOld)
      .mockResolvedValueOnce(unwatchNew)
    const tabs = await import('./tabs.svelte')
    const watcher = await import('./file-watcher.svelte')
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('A')
    ;(fs.statFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtime: 1000, size: 1 })
    await tabs.openFile('/tmp/foo.md')
    await watcher.startWatchingTab(tabs.tabs[0])
    // Caller owns filePath: set it first, then rebind.
    tabs.tabs[0].filePath = '/tmp/bar.md'
    await watcher.rebindTabPath(tabs.tabs[0].id)
    expect(unwatchOld).toHaveBeenCalled()
    expect(plug.watchImmediate).toHaveBeenLastCalledWith('/tmp/bar.md', expect.any(Function))
  })
})

describe('installFocusPoll', () => {
  it('attaches a window focus listener that calls verifyAllOpen', async () => {
    const watcher = await import('./file-watcher.svelte')
    const spy = vi.spyOn(watcher, 'verifyAllOpen')
      .mockImplementation(async () => {})
    const uninstall = watcher.installFocusPoll()
    window.dispatchEvent(new Event('focus'))
    expect(spy).toHaveBeenCalledTimes(1)
    uninstall()
    window.dispatchEvent(new Event('focus'))
    expect(spy).toHaveBeenCalledTimes(1)  // not called after uninstall
  })
})
