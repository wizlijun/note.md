// @vitest-environment happy-dom
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const { invoke, capabilities, cached } = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilities: {
    distributionChannel: 'package-manager', cliInstall: false, themeFontInstall: false,
    setDefaultApp: false, location: false, globalShortcuts: true, windowDecorations: true,
  },
  cached: { last_checked_at: new Date().toISOString(), latest_version_seen: '999.0.0', dismissed_version: null, check_on_startup: false },
}))
// Keep updater/Store implementations real; replace only the native IPC transport.

beforeEach(() => {
  vi.resetModules()
  capabilities.distributionChannel = 'package-manager'
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'desktop_capabilities') return { ...capabilities }
    if (command === 'plugin:app|version') return '6.1.0'
    if (command === 'plugin:store|load') return 7
    if (command === 'plugin:store|get') return [cached, true]
    if (command === 'plugin:store|set' || command === 'plugin:store|save') return
    if (command === 'plugin:updater|download_and_install') return
    if (command === 'plugin:updater|check') return { rid: 8, currentVersion: '6.1.0', version: '6.2.0', body: 'Release notes', rawJson: {} }
    throw new Error(`Unexpected native command: ${command}`)
  })
  mockIPC((command, args) => invoke(command, args))
})
afterEach(() => clearMocks())

describe('distribution updater policy', () => {
  it('package-manager startup, forced checks and downloads ignore the old updater cache', async () => {
    const api = await import('./updater.svelte')
    await api.initUpdater()
    await api.runCheck({ forceFresh: true })
    await api.downloadAndInstall()
    await api.dismissCurrent()
    await api.setCheckOnStartup(false)
    await api.restartApp()
    expect(api.updater.currentVersion).toBe('6.1.0')
    expect(api.updater.state).toBe('idle')
    expect(api.updater.latestVersion).toBe(null)
    expect(api.shouldShowBanner()).toBe(false)
    expect(api.hasUpdateForSettings()).toBe(false)
    expect(invoke.mock.calls.some(([cmd]) => cmd.startsWith('plugin:store|') || cmd.startsWith('plugin:updater|') || cmd === 'plugin:process|restart')).toBe(false)
  })

  it('malformed native capabilities never fall back to direct updates', async () => {
    const normalInvoke = invoke.getMockImplementation()!
    invoke.mockImplementation(async (command, args) => command === 'desktop_capabilities' ? { distributionChannel: 'unexpected' } : normalInvoke(command, args))
    const api = await import('./updater.svelte')
    await api.initUpdater()
    expect(api.updater.state).toBe('error')
    expect(api.updater.error).toBeTruthy()
    expect(invoke.mock.calls.some(([cmd]) => cmd.startsWith('plugin:store|') || cmd.startsWith('plugin:updater|') || cmd === 'plugin:process|restart')).toBe(false)
  })

  it('direct channel retains cached startup updates and fresh manual checks', async () => {
    capabilities.distributionChannel = 'direct'
    const api = await import('./updater.svelte')
    await api.initUpdater()
    expect(api.updater.state).toBe('available')
    expect(api.updater.latestVersion).toBe('999.0.0')
    expect(api.shouldShowBanner()).toBe(true)
    await api.runCheck({ forceFresh: true })
    expect(api.updater.state).toBe('available')
    expect(api.updater.latestVersion).toBe('6.2.0')
    expect(api.updater.notes).toBe('Release notes')
    await api.downloadAndInstall()
    expect(api.updater.state).toBe('ready')
    expect(api.shouldShowBanner()).toBe(true)
  })

  it('failed identity blocks startup/cache and manual checks, then retries successfully', async () => {
    const normalInvoke = invoke.getMockImplementation()!
    let failures = 0
    invoke.mockImplementation(async (command, args) => {
      if (command === 'desktop_capabilities' && failures++ < 2) throw new Error('capabilities unavailable')
      return normalInvoke(command, args)
    })
    const api = await import('./updater.svelte')
    await api.initUpdater()
    expect(api.updater.state).toBe('error')
    expect(api.updater.error).toContain('capabilities unavailable')
    expect(api.shouldShowBanner()).toBe(false)
    expect(invoke.mock.calls.some(([cmd]) => cmd.startsWith('plugin:store|') || cmd.startsWith('plugin:updater|') || cmd === 'plugin:process|restart')).toBe(false)
    await api.runCheck({ forceFresh: true })
    expect(api.updater.state).toBe('error')
    expect(api.updater.error).toContain('capabilities unavailable')
    expect(invoke.mock.calls.some(([cmd]) => cmd.startsWith('plugin:store|') || cmd.startsWith('plugin:updater|'))).toBe(false)
    await api.runCheck({ forceFresh: true })
    expect(api.updater.state).toBe('idle')
    expect(api.updater.error).toBe(null)
    expect(invoke.mock.calls.some(([cmd]) => cmd.startsWith('plugin:store|') || cmd.startsWith('plugin:updater|') || cmd === 'plugin:process|restart')).toBe(false)
  })
})
