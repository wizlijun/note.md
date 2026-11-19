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
  it('retains all recent files for DrawerNav without publishing a menu', async () => {
    recentFiles = ['/a.md', '/b.md', '/c.md']
    const { refreshRecentMenu, mergedRecents } = await import('./recent-sync.svelte')
    await refreshRecentMenu()
    expect(mergedRecents.paths).toEqual(['/a.md', '/b.md', '/c.md'])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('retains raw open history for DrawerNav when a Vault is configured', async () => {
    vault.vaultRoot = '/vault'
    recentFiles = ['/vault/brief-preview.md', '/outside/temporary.md']
    const { refreshRecentMenu, mergedRecents } = await import('./recent-sync.svelte')
    await refreshRecentMenu()
    expect(mergedRecents.paths).toEqual(recentFiles)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not overwrite history after the configured Vault changes during an await', async () => {
    const { exists } = await import('@tauri-apps/plugin-fs')
    let resolveExists!: (value: boolean) => void
    vi.mocked(exists).mockImplementationOnce(() => new Promise(resolve => { resolveExists = resolve }))
    const { refreshRecentMenu, mergedRecents } = await import('./recent-sync.svelte')
    mergedRecents.paths = ['/new-vault/current.md']
    vault.vaultRoot = '/old-vault'
    recentFiles = ['/old-vault/stale.md']
    const refreshing = refreshRecentMenu()
    await vi.waitFor(() => expect(resolveExists).toBeDefined())
    vault.vaultRoot = '/new-vault'
    resolveExists(false)
    await refreshing
    expect(mergedRecents.paths).toEqual(['/new-vault/current.md'])
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

  it('defers history refresh until settings have loaded', async () => {
    const { installRecentsSync, mergedRecents } = await import('./recent-sync.svelte')
    mergedRecents.paths = ['/existing.md']
    await installRecentsSync()
    expect(mergedRecents.paths).toEqual(['/existing.md'])
    expect(invoke).not.toHaveBeenCalled()
  })
})
