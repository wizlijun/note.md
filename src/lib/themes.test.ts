import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('themes registry', () => {
  it('hydrates list from theme_list', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'default', name: 'Default', appearance: 'light', source: '/x/default.css', compiled: '/x/.compiled/default.css', built_in: true },
      { id: 'effie',   name: 'Effie',   appearance: 'light', source: '/x/effie.css',   compiled: '/x/.compiled/effie.css',   built_in: true },
    ])
    const { themes, loadThemes } = await import('./themes.svelte')
    await loadThemes()
    expect(themes.list.length).toBe(2)
    expect(themes.list.map((t) => t.id)).toEqual(['default', 'effie'])
    expect(themes.error).toBeNull()
  })

  it('records error when invoke rejects', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValue('boom')
    const { themes, loadThemes } = await import('./themes.svelte')
    await loadThemes()
    expect(themes.error).toBe('boom')
    expect(themes.list).toEqual([])
  })

  it('findById returns the meta or undefined', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'default', name: 'Default', appearance: 'light', source: '/a', compiled: '/b', built_in: true },
    ])
    const { findThemeById, loadThemes } = await import('./themes.svelte')
    await loadThemes()
    expect(findThemeById('default')?.name).toBe('Default')
    expect(findThemeById('missing')).toBeUndefined()
  })
})
