// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async (_p: string) => `/* css for ${_p} */`),
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
    await applyThemeContent('light', '/themes/.compiled/default.css')
    const slot = document.querySelector('style[data-theme-slot="light"]')!
    expect(slot.textContent).toContain('default.css')
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
