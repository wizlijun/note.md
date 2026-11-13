// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
import { t } from '../lib/i18n/store.svelte'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), copy: vi.fn(), reveal: vi.fn(), prepare: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: mocks.copy }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: mocks.reveal }))
vi.mock('../lib/tabs.svelte', () => ({ prepareVaultChange: mocks.prepare }))
vi.mock('../lib/dialogs', () => ({ confirmDirtyClose: vi.fn() }))
vi.mock('../lib/sotvault.svelte', () => ({ refreshSotvault: vi.fn(async () => {}) }))
vi.mock('../lib/vault-settings.svelte', () => ({ loadVaultSettings: vi.fn(async () => {}) }))
vi.mock('../lib/outline/dirs.svelte', () => ({ loadOutlineDirs: vi.fn(async () => {}) }))
vi.mock('../lib/quick-note.svelte', () => ({ loadInboxDir: vi.fn(async () => {}) }))
import DesktopVaultSettings from './DesktopVaultSettings.svelte'
import { vaultManagement, type VaultInspection } from '../lib/vault-management.svelte'
const info = (root: string | null = '/Users/me/Vault'): VaultInspection => ({
  root, homeDir: '/Users/me', documentsDir: '/Users/me/Documents', accessible: !!root, error: null,
  git: { state: 'none', branch: null, remote: null, hasCommits: false, authorConfigured: false, error: null }, syncEnabled: false, onboarding: 'completed',
})
let component: ReturnType<typeof mount> | null = null
let current: VaultInspection
async function settle() { flushSync(); for (let i = 0; i < 10; i++) await Promise.resolve(); flushSync() }
function button(label: string, root: ParentNode = document): HTMLButtonElement {
  const value = Array.from(root.querySelectorAll('button')).find(b => b.textContent?.trim() === label)
  if (!value) throw new Error(`Missing ${label}`)
  return value
}
beforeEach(() => {
  vi.clearAllMocks()
  current = info()
  Object.assign(vaultManagement, { info: null, loading: false, error: null, onboardingOpen: false, onboardingShownThisRun: false })
  mocks.open.mockResolvedValue('/Users/me/Other')
  mocks.prepare.mockResolvedValue(true)
  mocks.invoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'vault_inspect') return current
    if (cmd === 'vault_sync_status') return { repo_path: current.root, state: 'stopped', last_sync: null, error_message: null }
    if (cmd === 'vault_activate') { current = info(args.path); return current }
    if (cmd === 'vault_init_git') { current = { ...current, git: { ...current.git, state: 'ready', branch: 'main' } }; return current }
    return undefined
  })
  document.body.innerHTML = ''
})
afterEach(async () => { if (component) await unmount(component); component = null; document.body.innerHTML = '' })
async function setup() { component = mount(DesktopVaultSettings, { target: document.body }); await settle() }

describe('Desktop Vault settings', () => {
  it('shows only one setup action when unconfigured, with no Git form', async () => {
    current = info(null)
    await setup()
    expect(button(t('vaultManage.setup'))).toBeTruthy()
    expect(document.body.textContent).not.toContain(t('vaultManage.initGit'))
    button(t('vaultManage.setup')).click(); await settle()
    expect(vaultManagement.onboardingOpen).toBe(true)
  })
  it('abbreviates the displayed root but copies the absolute path, with changes hidden in advanced', async () => {
    await setup()
    expect(document.querySelector('code')?.textContent).toBe('~/Vault')
    button(t('vaultManage.copy')).click(); await settle()
    expect(mocks.copy).toHaveBeenCalledWith('/Users/me/Vault')
    expect(document.querySelector('details')?.open).toBe(false)
    expect(document.body.textContent).not.toContain(t('vaultManage.create'))
  })
  it('picking a replacement does not activate it until the explicit path comparison confirmation', async () => {
    await setup()
    document.querySelector('details')!.open = true
    button(t('vaultManage.change')).click(); await settle()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('~/Vault')
    expect(dialog.textContent).toContain('~/Other')
    expect(mocks.invoke).not.toHaveBeenCalledWith('vault_activate', expect.anything())
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(document.activeElement).toBe(button(t('common.cancel'), dialog))
    button(t('common.cancel'), dialog).click(); await settle()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(current.root).toBe('/Users/me/Vault')
  })
  it('stops before activation when an unfinished document cancels preparation', async () => {
    mocks.prepare.mockResolvedValue(false)
    await setup()
    button(t('vaultManage.change')).click(); await settle()
    button(t('vaultManage.confirmChange')).click(); await settle()
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(mocks.invoke).not.toHaveBeenCalledWith('vault_activate', expect.anything())
    expect(document.body.textContent).toContain(t('vaultManage.saveFirst'))
  })
  it('binds a confirmed change to the original root and reports backend failures without losing selection', async () => {
    const impl = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (cmd, args) => cmd === 'vault_activate' ? Promise.reject(new Error('old worker still stopping')) : impl(cmd, args))
    await setup()
    button(t('vaultManage.change')).click(); await settle()
    button(t('vaultManage.confirmChange')).click(); await settle()
    expect(mocks.invoke).toHaveBeenCalledWith('vault_activate', { path: '/Users/me/Other', expectedRoot: '/Users/me/Vault' })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('old worker still stopping')
    expect(vaultManagement.info?.root).toBe('/Users/me/Vault')
  })
  it('initializing Git requires confirmation and never enables synchronization', async () => {
    await setup()
    button(t('vaultManage.initGit')).click(); await settle()
    expect(mocks.invoke).not.toHaveBeenCalledWith('vault_init_git', expect.anything())
    button(t('vaultManage.initialize')).click(); await settle()
    expect(mocks.invoke).toHaveBeenCalledWith('vault_init_git', { expectedRoot: '/Users/me/Vault' })
    expect(mocks.invoke).not.toHaveBeenCalledWith('vault_set_sync', expect.anything())
    expect(document.body.textContent).toContain(t('vaultManage.gitNoCommits'))
  })
  it('blocks location and Git mutations while a Vault-scoped setting is being saved', async () => {
    component = mount(DesktopVaultSettings, { target: document.body, props: { externalBusy: true } })
    await settle()
    expect(button(t('vaultManage.change')).disabled).toBe(true)
    expect(button(t('vaultManage.initGit')).disabled).toBe(true)
  })
  it('requires remote, main branch, initial commit and author before enabling sync', async () => {
    current = { ...info(), git: { state: 'ready', branch: 'other', remote: 'https://example.test/repo.git', hasCommits: true, authorConfigured: true, error: null } }
    await setup()
    expect(button(t('vaultManage.enableSync')).disabled).toBe(true)
    expect(mocks.invoke).not.toHaveBeenCalledWith('vault_set_sync', expect.anything())
  })

  it('shows the actual worker failure instead of treating authorization as a running worker', async () => {
    current = { ...info(), syncEnabled: true }
    const impl = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (cmd, args) => cmd === 'vault_sync_status'
      ? { repo_path: current.root, state: 'error', last_sync: null, error_message: 'worker failed' }
      : impl(cmd, args))
    await setup()
    expect(document.querySelector('[role="status"]')?.textContent).toBe(t('vault.unknownError'))
    expect(document.body.textContent).toContain('worker failed')
    expect(button(t('vaultManage.pauseSync'))).toBeTruthy()
  })

})
