// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
import { t } from '../lib/i18n/store.svelte'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }))
vi.mock('../lib/sotvault.svelte', () => ({ refreshSotvault: vi.fn(async () => {}) }))
vi.mock('../lib/vault-settings.svelte', () => ({ loadVaultSettings: vi.fn(async () => {}) }))
vi.mock('../lib/outline/dirs.svelte', () => ({ loadOutlineDirs: vi.fn(async () => {}) }))
vi.mock('../lib/quick-note.svelte', () => ({ loadInboxDir: vi.fn(async () => {}) }))
import VaultOnboarding from './VaultOnboarding.svelte'
import { vaultManagement, type VaultInspection } from '../lib/vault-management.svelte'
const info = (root: string | null = null): VaultInspection => ({ root, homeDir: '/Users/me', documentsDir: '/Users/me/Documents', accessible: !!root, error: null,
  git: { state: 'none', branch: null, remote: null, hasCommits: false, authorConfigured: false, error: null }, syncEnabled: false, onboarding: root ? 'completed' : null })
let component: ReturnType<typeof mount> | null = null
async function settle() { flushSync(); for (let i = 0; i < 10; i++) await Promise.resolve(); flushSync() }
function button(label: string): HTMLButtonElement {
  const result = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === label)
  if (!result) throw new Error(`Missing ${label}`)
  return result
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(vaultManagement, { info: info(), loading: false, error: null, onboardingOpen: true, onboardingShownThisRun: true })
  mocks.open.mockResolvedValue(null)
  mocks.invoke.mockResolvedValue(undefined)
  document.body.innerHTML = ''
})
afterEach(async () => { if (component) await unmount(component); component = null; document.body.innerHTML = '' })
async function setup() { component = mount(VaultOnboarding, { target: document.body }); await settle() }

describe('Vault first-run guidance', () => {
  it('cancelling the native picker returns to guidance without marking it completed or skipped', async () => {
    await setup()
    button(t('vaultManage.openExisting')).click(); await settle()
    expect(vaultManagement.onboardingOpen).toBe(true)
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(button(t('vaultManage.create'))).toBeTruthy()
  })
  it('Escape persists an explicit skip instead of making an implicit Vault', async () => {
    await setup()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(mocks.invoke).toHaveBeenCalledWith('vault_set_onboarding', { value: 'skipped' })
    expect(vaultManagement.onboardingOpen).toBe(false)
  })
  it('creates exactly once using absolute paths and shows a completion page, without Git', async () => {
    let finish!: (value: VaultInspection) => void
    mocks.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await setup()
    button(t('vaultManage.create')).click(); await settle()
    expect(document.body.textContent).toContain('~/Documents/My Vault')
    const form = document.querySelector('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('vault_create', { parent: '/Users/me/Documents', name: 'My Vault', expectedRoot: null })
    finish(info('/Users/me/Documents/My Vault')); await settle()
    expect(document.body.textContent).toContain(t('vaultManage.ready'))
    expect(mocks.invoke).not.toHaveBeenCalledWith('vault_init_git', expect.anything())
    button(t('vaultManage.begin')).click(); await settle()
    expect(vaultManagement.onboardingOpen).toBe(false)
  })
  it('keeps the creation form and name when activation fails', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('permission denied'))
    await setup()
    button(t('vaultManage.create')).click(); await settle()
    const field = document.querySelector<HTMLInputElement>('input')!
    field.value = 'Work'; field.dispatchEvent(new Event('input', { bubbles: true })); await settle()
    button(t('vaultManage.create')).click(); await settle()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('permission denied')
    expect(field.value).toBe('Work')
    expect(vaultManagement.info?.root).toBeNull()
  })
  it('rejects path traversal before invoking the backend', async () => {
    await setup()
    button(t('vaultManage.create')).click(); await settle()
    const field = document.querySelector<HTMLInputElement>('input')!
    field.value = '../other'; field.dispatchEvent(new Event('input', { bubbles: true })); await settle()
    expect(button(t('vaultManage.create')).disabled).toBe(true)
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
