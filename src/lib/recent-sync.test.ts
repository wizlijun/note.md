import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn(async (..._args: unknown[]) => {})
const listen = vi.fn(async (..._args: unknown[]) => () => {})
const setRecentsChangedHandler = vi.fn()
let recentFiles: string[] = []

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async () => '{}'),
  writeTextFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  readDir: vi.fn(async () => []),
  exists: vi.fn(async () => false),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(async () => '/Users/b') }))
vi.mock('@tauri-apps/plugin-os', () => ({ hostname: vi.fn(async () => 'host') }))
vi.mock('./settings.svelte', () => ({
  getRecentFiles: () => recentFiles,
  getRecentOpenedAt: () => ({}),
  getRecentTombstones: () => [],
  getDeviceId: () => 'dev1',
  setRecentsChangedHandler: (fn: unknown) => setRecentsChangedHandler(fn),
}))
vi.mock('./sotvault.svelte', () => ({ sotvaultStore: { vaultRoot: null } }))

beforeEach(() => {
  vi.clearAllMocks()
  recentFiles = []
})

describe('refreshRecentMenu', () => {
  it('pushes ALL recent files to the native menu (not just one)', async () => {
    recentFiles = ['/a.md', '/b.md', '/c.md']
    const { refreshRecentMenu, mergedRecents } = await import('./recent-sync.svelte')
    await refreshRecentMenu()
    expect(mergedRecents.paths).toEqual(['/a.md', '/b.md', '/c.md'])
    const call = invoke.mock.calls.find((c) => c[0] === 'update_recent_menu')
    expect((call?.[1] as { items: unknown[] }).items).toHaveLength(3)
  })
})

describe('installRecentsSync', () => {
  it('registers the change handler and the recents-synced event listener', async () => {
    const { installRecentsSync } = await import('./recent-sync.svelte')
    await installRecentsSync()
    expect(setRecentsChangedHandler).toHaveBeenCalled()
    expect(listen).toHaveBeenCalledWith('editor://recents-synced', expect.any(Function))
  })

  it('does NOT push the menu during install — defers to a post-load refresh so it never publishes an empty (pre-loadSettings) list', async () => {
    const { installRecentsSync } = await import('./recent-sync.svelte')
    await installRecentsSync()
    const call = invoke.mock.calls.find((c) => c[0] === 'update_recent_menu')
    expect(call).toBeFalsy()
  })
})
