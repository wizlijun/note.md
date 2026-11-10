// @vitest-environment happy-dom
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const { invoke, capabilities, cached, linuxCached, http } = vi.hoisted(() => ({
  invoke: vi.fn(),
  http: vi.fn(),
  linuxCached: { last_checked_at: null as string | null, latest_version_seen: null as string | null, dismissed_version: null as string | null, check_on_startup: false, last_check_succeeded: false },
  capabilities: {
    distributionChannel: 'package-manager', cliInstall: false, themeFontInstall: false,
    setDefaultApp: false, location: false, globalShortcuts: true, windowDecorations: true,
  },
  cached: { last_checked_at: new Date().toISOString(), latest_version_seen: '999.0.0', dismissed_version: null, check_on_startup: false },
}))
// Keep updater/Store implementations real; replace native IPC and HTTP boundaries.
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: http }))
const linuxRelease = { tag_name: 'v6.1110.2', draft: false, prerelease: false,
  published_at: '2026-11-10T05:00:00Z', body: 'Linux release notes',
  assets: [{ name: 'note.md_6.1110.2_amd64.deb', state: 'uploaded', size: 123,
    browser_download_url: 'https://github.com/wizlijun/note.md/releases/download/v6.1110.2/note.md_6.1110.2_amd64.deb' }] }


beforeEach(() => {
  vi.resetModules()
  capabilities.distributionChannel = 'package-manager'
  Object.assign(linuxCached, { last_checked_at: null, latest_version_seen: null, dismissed_version: null, check_on_startup: false, last_check_succeeded: false })
  http.mockReset().mockImplementation(async () => new Response(JSON.stringify([linuxRelease]), { status: 200 }))
  invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'desktop_capabilities') return { ...capabilities }
    if (command === 'plugin:app|version') return '6.1.0'
    if (command === 'plugin_market_host_triple') return 'x86_64-unknown-linux-gnu'
    if (command === 'plugin:opener|open_url') return
    if (command === 'plugin:store|load') return String(args.path).startsWith('linux-updater-') ? 9 : 7
    if (command === 'plugin:store|get') return [args.rid === 9 ? linuxCached : cached, true]
    if (command === 'plugin:store|set' || command === 'plugin:store|save') return
    if (command === 'plugin:updater|download_and_install') return
    if (command === 'plugin:updater|check') return { rid: 8, currentVersion: '6.1.0', version: '6.2.0', body: 'Release notes', rawJson: {} }
    throw new Error(`Unexpected native command: ${command}`)
  })
  mockIPC((command, args) => invoke(command, args))
})
afterEach(() => { clearMocks(); vi.useRealTimers() })

describe('distribution updater policy', () => {
  it('package-manager checks Linux releases with an isolated cache and opens downloads without self-install', async () => {
    const api = await import('./updater.svelte')
    await api.initUpdater()
    expect(api.updater.latestVersion).toBe(null) // The direct-channel 999.0.0 cache is not Linux evidence.
    await api.runCheck({ forceFresh: true })
    expect(api.updater.state).toBe('available')
    expect(api.updater.latestVersion).toBe('6.1110.2')
    expect(api.shouldShowBanner()).toBe(true)
    expect(api.hasUpdateForSettings()).toBe(true)
    await api.downloadAndInstall()
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', expect.objectContaining({ url: 'https://github.com/wizlijun/note.md/releases/tag/v6.1110.2' }))
    expect(api.updater.state).toBe('available')
    await api.dismissCurrent()
    expect(api.shouldShowBanner()).toBe(false)
    expect(api.hasUpdateForSettings()).toBe(true)
    await api.setCheckOnStartup(true)
    expect(api.updater.checkOnStartup).toBe(true)
    await api.restartApp()
    expect(http).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls.some(([cmd]) => cmd.startsWith('plugin:updater|') || cmd === 'plugin:process|restart')).toBe(false)
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'plugin:store|load').every(([, args]) => String(args.path).startsWith('linux-updater-x86_64-unknown-linux-gnu'))).toBe(true)
  })

  it('automatically detects a Linux update after startup delay', async () => {
    vi.useFakeTimers()
    linuxCached.check_on_startup = true
    const api = await import('./updater.svelte')
    const initializing = api.initUpdater()
    await vi.advanceTimersByTimeAsync(1500)
    await initializing
    expect(http).toHaveBeenCalledTimes(1)
    expect(api.updater.state).toBe('available')
    expect(api.shouldShowBanner()).toBe(true)
  })

  it('a recent failed check is retried on startup instead of becoming up-to-date', async () => {
    vi.useFakeTimers()
    Object.assign(linuxCached, { check_on_startup: true, last_checked_at: new Date().toISOString(), last_check_succeeded: false })
    const api = await import('./updater.svelte')
    const initializing = api.initUpdater()
    await vi.advanceTimersByTimeAsync(1500)
    await initializing
    expect(http).toHaveBeenCalledTimes(1)
    expect(api.updater.state).toBe('available')
  })

  it('reuses a successful startup cache but revalidates its download target', async () => {
    vi.useFakeTimers()
    Object.assign(linuxCached, { check_on_startup: true, last_checked_at: new Date().toISOString(), last_check_succeeded: true, latest_version_seen: '6.1110.2' })
    const api = await import('./updater.svelte')
    const initializing = api.initUpdater()
    await vi.advanceTimersByTimeAsync(1500)
    await initializing
    expect(http).not.toHaveBeenCalled()
    expect(api.updater.state).toBe('available')
    await api.downloadAndInstall()
    expect(http).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', expect.objectContaining({ url: 'https://github.com/wizlijun/note.md/releases/tag/v6.1110.2' }))
  })

  it('fresh manual checks bypass successful cached results and clear a stale version when none is newer', async () => {
    Object.assign(linuxCached, { last_checked_at: new Date().toISOString(), last_check_succeeded: true, latest_version_seen: '999.0.0' })
    const api = await import('./updater.svelte')
    await api.initUpdater()
    http.mockResolvedValueOnce(new Response(JSON.stringify([{ ...linuxRelease, tag_name: 'v6.0.0', assets: [{ ...linuxRelease.assets[0], name: 'note.md_6.0.0_amd64.deb', browser_download_url: 'https://github.com/wizlijun/note.md/releases/download/v6.0.0/note.md_6.0.0_amd64.deb' }] }]), { status: 200 }))
    await api.runCheck({ forceFresh: true })
    expect(http).toHaveBeenCalledTimes(1)
    expect(api.updater.state).toBe('uptodate')
    expect(api.updater.latestVersion).toBe(null)
    expect(api.updater.notes).toBe(null)
    expect(api.hasUpdateForSettings()).toBe(false)
    const [, args] = invoke.mock.calls.filter(([cmd]) => cmd === 'plugin:store|set').at(-1)!
    expect(args.value.latest_version_seen).toBe(null)
    expect(args.value.last_check_succeeded).toBe(true)
  })

  it('failed Linux checks stay errors, persist failure, and never open a stale download target', async () => {
    const api = await import('./updater.svelte')
    await api.runCheck()
    http.mockRejectedValue(new Error('network unavailable'))
    await expect(api.runCheck()).rejects.toThrow('network unavailable')
    expect(api.updater.state).toBe('error')
    const [, args] = invoke.mock.calls.filter(([cmd]) => cmd === 'plugin:store|set').at(-1)!
    expect(args.value.last_check_succeeded).toBe(false)
    await expect(api.downloadAndInstall()).rejects.toThrow('network unavailable')
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'plugin:opener|open_url' || cmd.startsWith('plugin:updater|'))).toBe(false)
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
    expect(api.updater.state).toBe('available')
    expect(api.updater.error).toBe(null)
    expect(invoke.mock.calls.some(([cmd]) => cmd.startsWith('plugin:updater|') || cmd === 'plugin:process|restart')).toBe(false)
  })
})
