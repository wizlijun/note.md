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

  it('setRecentMode / getRecentMode round-trips', async () => {
    const { setRecentMode, getRecentMode } = await import('./settings.svelte')
    await setRecentMode('/tmp/foo.md', 'rich')
    expect(getRecentMode('/tmp/foo.md')).toBe('rich')
    expect(getRecentMode('/tmp/missing.md')).toBe(null)
  })
})
