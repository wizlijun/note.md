import { describe, expect, it, vi } from 'vitest'
import { launchPluginApp, pluginCommandEnabled, observeManualAppOpens } from './app-launch'
import type { PluginManifest, EnabledWhenContext } from './types'
const manifest = (): PluginManifest => ({ id: 'app', name: 'App', binary: '', version: '1', host_capabilities: [], open_windows: { open: 'main' } })
const context = (): EnabledWhenContext => ({ currentTab: null, settings: {}, vaultConfigured: false })
function harness() {
  const m = manifest()
  const deps = { manifests: () => [m], context: vi.fn(context), openWindow: vi.fn(async () => {}),
    recordUse: vi.fn(async () => {}), reportUsageError: vi.fn(), fileView: { activeTab: () => null,
      pickOpenFile: vi.fn(async (): Promise<string | null> => null), openFile: vi.fn(async () => {}),
      flush: vi.fn(), setRichMode: vi.fn(), openView: vi.fn(), unsupported: vi.fn() } }
  return { m, deps }
}
describe('shared actual plugin app launch', () => {
  it('counts only a successful window open and never blocks on usage storage', async () => {
    const { deps } = harness()
    deps.recordUse.mockImplementation(() => new Promise(() => {}))
    expect(await launchPluginApp('app', 'open', deps)).toBe(true)
    expect(deps.openWindow).toHaveBeenCalledWith('app', 'main')
    expect(deps.recordUse).toHaveBeenCalledExactlyOnceWith('app')
  })
  it('does not count rejected opens or unknown plugins', async () => {
    const { deps } = harness()
    deps.openWindow.mockRejectedValue(new Error('failed'))
    await expect(launchPluginApp('app', 'open', deps)).rejects.toThrow('failed')
    await launchPluginApp('unknown', 'open', deps)
    expect(deps.recordUse).not.toHaveBeenCalled()
  })
  it('uses the live plugin, actual settings and home-null context for both gates', async () => {
    const { m, deps } = harness()
    m.available_when = 'vaultConfigured'
    expect(pluginCommandEnabled(m, 'open', context())).toBe(false)
    expect(pluginCommandEnabled(m, null, context())).toBe(false)
    await launchPluginApp('app', 'open', deps)
    m.available_when = 'true'
    m.menus = [{ command: 'open', label: 'Open', location: 'plugins', enabled_when: 'settings.allowed && !currentTab' }]
    expect(pluginCommandEnabled(m, null, context())).toBe(true)
    await launchPluginApp('app', 'open', deps)
    expect(deps.openWindow).not.toHaveBeenCalled()
    deps.context.mockReturnValue({ ...context(), settings: { allowed: true } })
    await launchPluginApp('app', 'open', deps)
    expect(deps.recordUse).toHaveBeenCalledOnce()
    deps.manifests = () => []
    await launchPluginApp('app', 'open', deps)
    expect(deps.recordUse).toHaveBeenCalledOnce()
  })
  it('respects context-menu enabled_when and fails closed for invalid gates', async () => {
    const { m, deps } = harness()
    m.context_menus = [{ command: 'open', label: 'Open', location: 'tab', enabled_when: 'currentTab.hasContent' }]
    await launchPluginApp('app', 'open', deps)
    expect(deps.openWindow).not.toHaveBeenCalled()
    m.context_menus[0].enabled_when = 'settings.allowed'
    deps.context.mockReturnValue({ ...context(), settings: { allowed: true } })
    await launchPluginApp('app', 'open', deps)
    expect(deps.openWindow).toHaveBeenCalledOnce()
    m.available_when = '!!!'
    await launchPluginApp('app', 'open', deps)
    expect(deps.openWindow).toHaveBeenCalledOnce()
  })

  it('reports rejected usage persistence without failing the open', async () => {
    const { deps } = harness()
    deps.recordUse.mockRejectedValue(new Error('disk full'))
    await expect(launchPluginApp('app', 'open', deps)).resolves.toBe(true)
    await Promise.resolve()
    expect(deps.reportUsageError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }))
  })
  it('does not count cancelled or unmatched file views and waits for acceptance callback', async () => {
    const { m, deps } = harness()
    delete m.open_windows
    m.file_views = [{ id: 'view', entry: 'index.html', open_command: 'open', selectors: [{ file_extensions: ['md'] }] }]
    await launchPluginApp('app', 'open', deps)
    expect(deps.recordUse).not.toHaveBeenCalled()
    const tab = { id: 'doc', filePath: '/file.txt', kind: 'code', currentContent: '', mode: 'rich' } as any
    deps.fileView.activeTab = () => tab
    await launchPluginApp('app', 'open', deps)
    expect(deps.recordUse).not.toHaveBeenCalled()
    tab.filePath = '/file.md'; tab.kind = 'markdown'
    let accepted!: (ok: boolean) => void
    deps.fileView.openView.mockImplementation((_detail, complete) => { accepted = complete })
    await launchPluginApp('app', 'open', deps)
    expect(deps.recordUse).not.toHaveBeenCalled()
    accepted(false); expect(deps.recordUse).not.toHaveBeenCalled()
    await launchPluginApp('app', 'open', deps)
    accepted(true); accepted(true)
    await Promise.resolve()
    expect(deps.recordUse).toHaveBeenCalledOnce()
  })
})

it('records the exact backend manual-open success event and returns listener cleanup', async () => {
  const { deps } = harness()
  let handler!: (event: { payload: string }) => void
  const stop = vi.fn()
  const subscribe = vi.fn(async (_name, callback) => { handler = callback; return stop })
  const unlisten = await observeManualAppOpens(subscribe, deps)
  expect(subscribe).toHaveBeenCalledWith('plugin-manual-opened', expect.any(Function))
  handler({ payload: 'app' }); await Promise.resolve()
  expect(deps.recordUse).toHaveBeenCalledExactlyOnceWith('app')
  unlisten(); expect(stop).toHaveBeenCalledOnce()
})
