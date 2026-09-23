// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (_cmd: string, args: { id: string }) => `/* css for ${args.id} */`),
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  document.head.innerHTML = ''
})

describe('theme-loader', () => {
  it('installs two style slots on first call', async () => {
    const { ensureThemeSlots, applyThemeContent } = await import('./theme-loader')
    ensureThemeSlots()
    expect(document.querySelectorAll('style[data-theme-slot]').length).toBe(2)
    expect(document.querySelector('style[data-theme-slot="light"]')).toBeTruthy()
    expect(document.querySelector('style[data-theme-slot="dark"]')).toBeTruthy()
    void applyThemeContent
  })

  it('writes CSS content into the named slot', async () => {
    const { applyThemeContent } = await import('./theme-loader')
    await applyThemeContent('light', 'default')
    const slot = document.querySelector('style[data-theme-slot="light"]')!
    expect(slot.textContent).toContain('css for default')
  })

  it('computeActiveThemeId picks light when !followSystem', () => {
    return import('./theme-loader').then(({ computeActiveThemeId }) => {
      const id = computeActiveThemeId(
        { light: 'a', dark: 'b', followSystem: false },
        true,    // systemDark
      )
      expect(id).toBe('a')
    })
  })

  it('computeActiveThemeId follows system when enabled', () => {
    return import('./theme-loader').then(({ computeActiveThemeId }) => {
      expect(computeActiveThemeId({ light: 'a', dark: 'b', followSystem: true }, true)).toBe('b')
      expect(computeActiveThemeId({ light: 'a', dark: 'b', followSystem: true }, false)).toBe('a')
    })
  })

  it('observePrefersColorScheme reports current value and updates on change', async () => {
    // jsdom does not implement matchMedia properly; mock it.
    let listeners: Array<(e: MediaQueryListEvent) => void> = []
    let matches = false
    ;(globalThis as unknown as { matchMedia: unknown }).matchMedia = vi.fn((q: string) => ({
      media: q,
      matches,
      addEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) => { listeners.push(cb) },
      removeEventListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }))
    const { observePrefersColorScheme } = await import('./theme-loader')
    const updates: boolean[] = []
    const stop = observePrefersColorScheme((dark) => updates.push(dark))
    expect(updates).toEqual([false])
    matches = true
    listeners.forEach((cb) => cb({ matches: true } as MediaQueryListEvent))
    expect(updates).toEqual([false, true])
    stop()
  })
})

describe('theme request ordering', () => {
  it('shares one read for identical light/dark themes and reuses loaded slots', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const { applyThemeContent } = await import('./theme-loader')
    await Promise.all([applyThemeContent('light', 'effie'), applyThemeContent('dark', 'effie')])
    await applyThemeContent('light', 'effie')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(document.querySelector('style[data-theme-slot="dark"]')?.textContent).toContain('effie')
  })

  it('does not let an old response overwrite a newer selection', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    let resolveOld!: (css: string) => void
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<string>((resolve) => { resolveOld = resolve }) as never)
    const { applyThemeContent } = await import('./theme-loader')
    const old = applyThemeContent('light', 'old')
    await applyThemeContent('light', 'effie')
    resolveOld('old CSS')
    await old
    expect(document.querySelector('style[data-theme-slot="light"]')?.textContent).toContain('effie')
  })

  it('reloads an edited theme after registry invalidation', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const { applyThemeContent, invalidateThemeContent } = await import('./theme-loader')
    await applyThemeContent('light', 'effie')
    invalidateThemeContent()
    vi.mocked(invoke).mockResolvedValueOnce('edited CSS')
    await applyThemeContent('light', 'effie')
    expect(document.querySelector('style[data-theme-slot="light"]')?.textContent).toBe('edited CSS')
  })
})
