import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGet = vi.fn()
const mockSet = vi.fn()
const mockSave = vi.fn()

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: vi.fn(async () => ({ get: mockGet, set: mockSet, save: mockSave })) },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  mockGet.mockResolvedValue(undefined)
})

describe('settings', () => {
  it('loadSettings hydrates autoSave from store, defaults to false', async () => {
    const { loadSettings, settings } = await import('./settings.svelte')
    mockGet.mockImplementation(async (key: string) => key === 'autoSave' ? true : undefined)
    await loadSettings()
    expect(settings.autoSave).toBe(true)
  })

  it('pushRecentFile prepends and de-dupes, capped at 10', async () => {
    const { pushRecentFile, getRecentFiles } = await import('./settings.svelte')
    for (let i = 0; i < 12; i++) await pushRecentFile(`/tmp/${i}.md`)
    await pushRecentFile('/tmp/3.md')  // existing → moves to front
    const list = getRecentFiles()
    expect(list.length).toBe(10)
    expect(list[0]).toBe('/tmp/3.md')
    expect(list).not.toContain('/tmp/0.md')
    expect(list).not.toContain('/tmp/1.md')
  })

  it('setRecentMode / getRecentMode round-trips by key (extension)', async () => {
    const { setRecentMode, getRecentMode } = await import('./settings.svelte')
    await setRecentMode('md', 'rich')
    expect(getRecentMode('md')).toBe('rich')
    expect(getRecentMode('html')).toBe(null)
  })

  it('loadSettings hydrates recentModesByExt and getRecentMode reads it', async () => {
    const stored = { md: 'rich', py: 'source' }
    mockGet.mockImplementation(async (key: string) =>
      key === 'recentModesByExt' ? stored : undefined,
    )
    const { loadSettings, getRecentMode } = await import('./settings.svelte')
    await loadSettings()
    expect(getRecentMode('md')).toBe('rich')
    expect(getRecentMode('py')).toBe('source')
    expect(getRecentMode('json')).toBe(null)
  })
})

describe('plugin-scoped settings', () => {
  it('loads plugin-scoped keys from the store', async () => {
    mockGet.mockImplementation(async (k: string) => {
      if (k === 'plugins') return { share: { baseUrl: 'https://x', records: { a: 1 } } }
      return undefined
    })
    const { loadSettings, getPluginScopedAll } = await import('./settings.svelte')
    await loadSettings()
    expect(getPluginScopedAll('share')).toEqual({ 'share.baseUrl': 'https://x', 'share.records': { a: 1 } })
  })

  it('returns empty object for unknown plugin', async () => {
    mockGet.mockResolvedValue(undefined)
    const { loadSettings, getPluginScopedAll } = await import('./settings.svelte')
    await loadSettings()
    expect(getPluginScopedAll('mystery')).toEqual({})
  })

  it('mergePluginScoped writes deeply', async () => {
    mockGet.mockResolvedValue({ share: { records: { a: 1 } } })
    const { loadSettings, getPluginScopedAll, mergePluginScoped } = await import('./settings.svelte')
    await loadSettings()
    await mergePluginScoped({ 'share.records': { b: 2 }, 'share.baseUrl': 'https://y' })
    expect(getPluginScopedAll('share')).toEqual({
      'share.records': { b: 2 },
      'share.baseUrl': 'https://y',
    })
    // Verify the underlying store.set was called with the nested form.
    const setCall = mockSet.mock.calls.find((args) => args[0] === 'plugins')
    expect(setCall?.[1]).toEqual({
      share: { records: { b: 2 }, baseUrl: 'https://y' },
    })
  })
})
