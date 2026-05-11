import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGet = vi.fn()
const mockSet = vi.fn()
const mockSave = vi.fn()
const mockDelete = vi.fn()

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: vi.fn(async () => ({ get: mockGet, set: mockSet, save: mockSave, delete: mockDelete })) },
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

describe('theme settings', () => {
  it('migrates legacy `skin: "effie"` into theme.{light,dark,followSystem:false}', async () => {
    mockGet.mockImplementation(async (key: string) => {
      if (key === 'skin') return 'effie'
      if (key === 'theme') return undefined
      return undefined
    })
    const { loadSettings, settings } = await import('./settings.svelte')
    await loadSettings()
    expect(settings.theme).toEqual({
      light: 'effie',
      dark: 'effie',
      followSystem: false,
    })
    const deleteCall = mockSet.mock.calls.find((args) => args[0] === 'skin')
    // The migration should also delete the legacy `skin` key on save.
    expect(deleteCall).toBeUndefined()
  })

  it('respects existing theme settings when present', async () => {
    const stored = { light: 'default', dark: 'effie', followSystem: true }
    mockGet.mockImplementation(async (key: string) =>
      key === 'theme' ? stored : undefined,
    )
    const { loadSettings, settings } = await import('./settings.svelte')
    await loadSettings()
    expect(settings.theme).toEqual(stored)
  })

  it('defaults to {light:"default", dark:"default", followSystem:true} when nothing stored', async () => {
    mockGet.mockResolvedValue(undefined)
    const { loadSettings, settings } = await import('./settings.svelte')
    await loadSettings()
    expect(settings.theme).toEqual({
      light: 'default',
      dark: 'default',
      followSystem: true,
    })
  })

  it('persists theme via saveSettings', async () => {
    mockGet.mockResolvedValue(undefined)
    const { loadSettings, saveSettings, settings } = await import('./settings.svelte')
    await loadSettings()
    settings.theme = { light: 'effie', dark: 'default', followSystem: false }
    await saveSettings()
    const setCall = mockSet.mock.calls.find((args) => args[0] === 'theme')
    expect(setCall?.[1]).toEqual({ light: 'effie', dark: 'default', followSystem: false })
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

  it('mergePluginScoped replaces value at each fully-qualified key (shallow, not recursive)', async () => {
    mockGet.mockResolvedValue({ share: { records: { a: 1 } } })
    const { loadSettings, getPluginScopedAll, mergePluginScoped } = await import('./settings.svelte')
    await loadSettings()
    await mergePluginScoped({ 'share.records': { b: 2 }, 'share.baseUrl': 'https://y' })
    // share.records is REPLACED entirely — { a: 1 } is gone.
    // Plugins must read-modify-write the full sub-map themselves if they
    // want to preserve other entries (see spec § Actions § settings.merge).
    expect(getPluginScopedAll('share')).toEqual({
      'share.records': { b: 2 },
      'share.baseUrl': 'https://y',
    })
    const setCall = mockSet.mock.calls.find((args) => args[0] === 'plugins')
    expect(setCall?.[1]).toEqual({
      share: { records: { b: 2 }, baseUrl: 'https://y' },
    })
  })

  it('preserves untouched keys at the same level (only patched keys are replaced)', async () => {
    mockGet.mockResolvedValue({ share: { baseUrl: 'https://x', apiKey: 'secret' } })
    const { loadSettings, getPluginScopedAll, mergePluginScoped } = await import('./settings.svelte')
    await loadSettings()
    await mergePluginScoped({ 'share.baseUrl': 'https://y' })
    // apiKey is preserved because it wasn't in the patch.
    expect(getPluginScopedAll('share')).toEqual({
      'share.baseUrl': 'https://y',
      'share.apiKey': 'secret',
    })
  })
})

describe('plugins.enabled', () => {
  it('returns true (default-on) for a plugin not in the map', async () => {
    mockGet.mockResolvedValue(undefined)
    const { loadSettings, isPluginEnabled } = await import('./settings.svelte')
    await loadSettings()
    expect(isPluginEnabled('newplugin')).toBe(true)
  })

  it('reads explicit false from the store', async () => {
    mockGet.mockImplementation(async (k: string) =>
      k === 'plugins.enabled' ? { share: false } : undefined,
    )
    const { loadSettings, isPluginEnabled } = await import('./settings.svelte')
    await loadSettings()
    expect(isPluginEnabled('share')).toBe(false)
    expect(isPluginEnabled('md2pdf')).toBe(true)  // default-on for missing
  })

  it('round-trips a disabled plugin via setPluginEnabled', async () => {
    mockGet.mockResolvedValue(undefined)
    const { loadSettings, isPluginEnabled, setPluginEnabled } = await import('./settings.svelte')
    await loadSettings()
    await setPluginEnabled('foo', false)
    expect(isPluginEnabled('foo')).toBe(false)
    await setPluginEnabled('foo', true)
    expect(isPluginEnabled('foo')).toBe(true)
  })

  it('persists the enabled map under "plugins.enabled" key', async () => {
    mockGet.mockResolvedValue(undefined)
    const { loadSettings, setPluginEnabled } = await import('./settings.svelte')
    await loadSettings()
    await setPluginEnabled('foo', false)
    const setCall = mockSet.mock.calls.find((args) => args[0] === 'plugins.enabled')
    expect(setCall?.[1]).toEqual({ foo: false })
  })
})
