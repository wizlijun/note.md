// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'

const mocks = vi.hoisted(() => ({
  root: { vaultRoot: '/home/alice/Notes' as string | null },
  invoke: vi.fn(), copy: vi.fn(), reveal: vi.fn(), open: vi.fn(), refresh: vi.fn(async () => {}),
  watch: vi.fn(async (..._args: unknown[]) => () => {}),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-fs', () => ({ watchImmediate: mocks.watch }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: mocks.copy }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: mocks.reveal }))
vi.mock('../lib/sotvault.svelte', () => ({ sotvaultStore: mocks.root }))
vi.mock('../lib/plugins/runtime.svelte', () => ({ pluginRuntime: { manifests: [] } }))
vi.mock('../lib/vault-stats', () => ({ vaultDocumentRules: () => ({ extensions: ['md'], names: [] }), formatContentBytes: (n: number) => `${n} B` }))
vi.mock('../lib/vault-management.svelte', () => ({
  vaultManagement: { info: { homeDir: '/home/alice' } },
  refreshVaultManagement: mocks.refresh, openVaultManagement: mocks.open,
  abbreviateHome: (path: string) => path.replace(/^\/home\/alice(?=\/|$)/, '~'),
}))
vi.mock('../lib/i18n/store.svelte', () => ({ i18n: { locale: 'en' }, t: (key: string, vars?: Record<string, unknown>) => `${key}${vars ? JSON.stringify(vars) : ''}` }))
import VaultOverview from './VaultOverview.svelte'
let app: ReturnType<typeof mount> | undefined
const snapshot = { root: '/home/alice/Notes', documents: 3, files: 5, bytes: 120, skipped: 0, completedAt: 1000 }
async function settle() { await new Promise((r) => setTimeout(r, 0)); flushSync() }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.root.vaultRoot = '/home/alice/Notes'
  mocks.invoke.mockResolvedValue(snapshot)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  document.body.innerHTML = ''
})
afterEach(async () => { if (app) await unmount(app); app = undefined; vi.useRealTimers() })

describe('welcome Vault overview', () => {
  it('shows a setup action, not zero statistics, without a Vault', async () => {
    mocks.root.vaultRoot = null
    app = mount(VaultOverview, { target: document.body })
    await settle()
    expect(document.body.textContent).toContain('vaultOverview.unconfigured')
    expect(document.body.textContent).not.toContain('vaultOverview.documents')
    const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'vaultOverview.setup')!
    button.click(); await settle()
    expect(mocks.open).toHaveBeenCalledOnce()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('abbreviates display, copies full path and prevents double-click propagation', async () => {
    const doubleClick = vi.fn()
    document.addEventListener('dblclick', doubleClick)
    app = mount(VaultOverview, { target: document.body }); await settle()
    expect(document.querySelector('.path')?.textContent).toBe('~/Notes')
    const button = document.querySelector<HTMLButtonElement>('[aria-label="vaultOverview.copyPath"]')!
    button.click(); await settle()
    expect(mocks.copy).toHaveBeenCalledWith('/home/alice/Notes')
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(doubleClick).not.toHaveBeenCalled()
    document.removeEventListener('dblclick', doubleClick)
    expect(document.body.textContent).toContain('120 B')
  })
  it('keeps unknown distinct from zero and cancels pending scans on teardown', async () => {
    mocks.root.vaultRoot = '/home/alice/NewNotes'
    mocks.invoke.mockReturnValue(new Promise(() => {}))
    app = mount(VaultOverview, { target: document.body }); await settle()
    expect(document.body.textContent).toContain('vaultOverview.counting')
    expect(document.body.textContent).not.toContain('vaultOverview.documents')
    const args = mocks.invoke.mock.calls[0][1]
    await unmount(app); app = undefined
    expect(mocks.invoke).toHaveBeenCalledWith('notemd_vault_stats_cancel', { requestId: args.requestId })
  })
  it('labels incomplete results without a successful timestamp', async () => {
    mocks.invoke.mockResolvedValue({ ...snapshot, skipped: 2, completedAt: null })
    app = mount(VaultOverview, { target: document.body }); await settle()
    expect(document.body.textContent).toContain('vaultOverview.partial')
    expect(document.body.textContent).not.toContain('vaultOverview.countedAt')
  })
  it('reuses the same-root snapshot while refreshing after remount', async () => {
    app = mount(VaultOverview, { target: document.body }); await settle()
    await unmount(app); app = undefined
    mocks.invoke.mockReturnValue(new Promise(() => {}))
    app = mount(VaultOverview, { target: document.body }); await settle()
    expect(document.body.textContent).toContain('120 B')
    expect(document.body.textContent).toContain('vaultOverview.counting')
  })
  it('cancels active work when the welcome page becomes hidden', async () => {
    mocks.root.vaultRoot = '/home/alice/Hidden'
    mocks.invoke.mockReturnValue(new Promise(() => {}))
    app = mount(VaultOverview, { target: document.body }); await settle()
    const args = mocks.invoke.mock.calls[0][1]
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mocks.invoke).toHaveBeenCalledWith('notemd_vault_stats_cancel', { requestId: args.requestId })
  })
  it('ignores watcher events exclusively inside internal management directories', async () => {
    app = mount(VaultOverview, { target: document.body }); await settle()
    const notify = mocks.watch.mock.calls[0][1] as (event: unknown) => void
    const originalCalls = mocks.invoke.mock.calls.length
    vi.useFakeTimers()
    notify({ type: { modify: 'any' }, paths: ['/home/alice/Notes/.notemd/index.db', '/home/alice/Notes/.git/index'] })
    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.invoke.mock.calls.length).toBe(originalCalls)
    notify({ type: { modify: 'any' }, paths: ['/home/alice/Notes/new.md'] })
    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.invoke.mock.calls.length).toBe(originalCalls + 1)
    vi.useRealTimers()
  })

})
