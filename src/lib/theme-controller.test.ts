// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  document.head.innerHTML = ''
  const { settings } = await import('./settings.svelte')
  settings.theme = { light: 'effie', dark: 'effie', followSystem: false }
})

describe('first editor theme', () => {
  it('awaits selected CSS before readiness and does not re-read it from initial observers', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    let resolveCss!: (css: string) => void
    const css = new Promise<string>((resolve) => { resolveCss = resolve })
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'theme_list') return [{ id: 'effie' }]
      if (command === 'theme_load_compiled') return css
      return undefined
    })
    const { initializeThemes } = await import('./theme-controller.svelte')
    const { activeTheme } = await import('./active-theme.svelte')
    let ready = false
    const startup = initializeThemes().then((stop) => { ready = true; return stop })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('theme_load_compiled', { id: 'effie' }))
    expect(ready).toBe(false)
    resolveCss('[data-theme="effie"] { color: teal; }')
    const stop = await startup
    flushSync()
    expect(ready).toBe(true)
    expect(activeTheme.id).toBe('effie')
    expect(document.querySelector('style[data-theme-slot="light"]')?.textContent).toContain('teal')
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'theme_load_compiled')).toHaveLength(1)
    stop()
  })

  it('follows settings and re-publishes CSS when the same theme is reloaded', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'theme_list') return [{ id: 'effie' }, { id: 'night' }]
      if (command === 'theme_load_compiled') return `/* ${(args as { id: string }).id} */`
      return undefined
    })
    const { initializeThemes } = await import('./theme-controller.svelte')
    const { themes } = await import('./themes.svelte')
    const { settings } = await import('./settings.svelte')
    const { activeTheme } = await import('./active-theme.svelte')
    const stop = await initializeThemes()
    flushSync()
    await vi.waitFor(() => expect(activeTheme.id).toBe('effie'))
    vi.mocked(invoke).mockClear()
    themes.list = [...themes.list]
    flushSync()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin_v2_theme_changed', {
      lightId: 'effie', darkId: 'effie', followSystem: false,
    }))
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'theme_load_compiled')).toHaveLength(1)
    settings.theme.light = 'night'
    flushSync()
    await vi.waitFor(() => expect(activeTheme.id).toBe('night'))
    stop()
    vi.mocked(invoke).mockClear()
    settings.theme.light = 'effie'
    flushSync()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not leave the editor waiting forever when a theme file is missing', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'theme_list') return []
      if (command === 'theme_load_compiled') throw new Error('missing CSS')
      return undefined
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { initializeThemes } = await import('./theme-controller.svelte')
    const stop = await initializeThemes()
    stop()
    expect(document.querySelector('style[data-theme-slot="light"]')?.textContent).toBe('')
    expect(warning).toHaveBeenCalled()
    warning.mockRestore()
  })


  it('waits for a selection changed during startup before releasing the editor', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const { settings } = await import('./settings.svelte')
    const { activeTheme } = await import('./active-theme.svelte')
    const resolvers = new Map<string, (css: string) => void>()
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'theme_list') return [{ id: 'effie' }, { id: 'night' }]
      if (command === 'theme_load_compiled') {
        return new Promise<string>((resolve) => { resolvers.set((args as { id: string }).id, resolve) })
      }
      return undefined
    })
    const { initializeThemes } = await import('./theme-controller.svelte')
    let ready = false
    const startup = initializeThemes().then((stop) => { ready = true; return stop })
    await vi.waitFor(() => expect(resolvers.has('effie')).toBe(true))
    settings.theme.light = 'night'
    resolvers.get('effie')!('/* effie */')
    await vi.waitFor(() => expect(resolvers.has('night')).toBe(true))
    expect(ready).toBe(false)
    resolvers.get('night')!('/* night */')
    const stop = await startup
    expect(ready).toBe(true)
    expect(activeTheme.id).toBe('night')
    stop()
  })

})
