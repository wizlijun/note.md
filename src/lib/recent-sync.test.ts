import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn(async (..._args: unknown[]) => {})
const listen = vi.fn(async (..._args: unknown[]) => () => {})
const setRecentsChangedHandler = vi.fn()
let recentFiles: string[] = []
const vault = vi.hoisted(() => ({ vaultRoot: null as string | null }))

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
vi.mock('./sotvault.svelte', () => ({ sotvaultStore: vault }))

beforeEach(() => {
  vi.clearAllMocks()
  recentFiles = []
  vault.vaultRoot = null
})

describe('refreshRecentMenu', () => {
  it('pushes ALL recent files to the native menu (not just one)', async () => {
    recentFiles = ['/a.md', '/b.md', '/c.md']
    const { refreshRecentMenu, mergedRecents } = await import('./recent-sync.svelte')
    await refreshRecentMenu()
    expect(mergedRecents.paths).toEqual(['/a.md', '/b.md', '/c.md'])
    const call = invoke.mock.calls.find((c) => c[0] === 'update_recent_menu')
    expect((call?.[1] as { items: unknown[] }).items).toHaveLength(3)
    expect(call?.[1]).toEqual({ history: true, items: recentFiles.map(path => ({ path, label: path.slice(1) })) })
  })

  it('retains raw open history in its separate menu when a Vault is configured', async () => {
    vault.vaultRoot = '/vault'
    recentFiles = ['/vault/brief-preview.md', '/outside/temporary.md']
    const { refreshRecentMenu, mergedRecents } = await import('./recent-sync.svelte')
    await refreshRecentMenu()
    expect(mergedRecents.paths).toEqual(recentFiles)
    expect(invoke).toHaveBeenCalledWith('update_recent_menu', { history: true, items: [
      { path: recentFiles[0], label: 'brief-preview.md — /vault' },
      { path: recentFiles[1], label: 'temporary.md — /outside' },
    ] })
  })

  it('does not overwrite history after the configured Vault changes during an await', async () => {
    const { homeDir } = await import('@tauri-apps/api/path')
    let resolveHome!: (value: string) => void
    vi.mocked(homeDir).mockImplementationOnce(() => new Promise(resolve => { resolveHome = resolve }))
    const { refreshRecentMenu } = await import('./recent-sync.svelte')
    const refreshing = refreshRecentMenu()
    await vi.waitFor(() => expect(resolveHome).toBeDefined())
    vault.vaultRoot = '/new-vault'
    resolveHome('/Users/b')
    await refreshing
    expect(invoke).not.toHaveBeenCalled()
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
