import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), refresh: vi.fn(), load: vi.fn(), outline: vi.fn(), inbox: vi.fn(), settings: vi.fn(), close: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('./sotvault.svelte', () => ({ refreshSotvault: mocks.refresh }))
vi.mock('./vault-settings.svelte', () => ({ loadVaultSettings: mocks.load }))
vi.mock('./outline/dirs.svelte', () => ({ loadOutlineDirs: mocks.outline }))
vi.mock('./quick-note.svelte', () => ({ loadInboxDir: mocks.inbox }))
vi.mock('./ui-state.svelte', () => ({ openSettings: mocks.settings, closeSettings: mocks.close }))
import { abbreviateHome, validVaultName, vaultChildPath, vaultManagement, refreshVaultManagement,
  initializeVaultOnboarding, openVaultManagement, skipVaultOnboarding, createVault, applyVaultInspection, type VaultInspection } from './vault-management.svelte'

const inspection = (root: string | null = null): VaultInspection => ({ root, homeDir: '/Users/person', documentsDir: '/Users/person/Documents', accessible: !!root,
  error: null, git: { state: 'none', branch: null, remote: null, hasCommits: false, authorConfigured: false, error: null }, syncEnabled: false, onboarding: null })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.invoke.mockResolvedValue(inspection())
  mocks.load.mockResolvedValue(undefined)
  mocks.outline.mockResolvedValue(undefined)
  mocks.inbox.mockResolvedValue(undefined)
  mocks.refresh.mockResolvedValue(undefined)
  Object.assign(vaultManagement, { info: null, loading: false, error: null, onboardingOpen: false, onboardingShownThisRun: false })
})

describe('Vault presentation and operation state', () => {
  it('abbreviates only the current home at a path-component boundary, with Windows semantics', () => {
    expect(abbreviateHome('/Users/person', '/Users/person/')).toBe('~')
    expect(abbreviateHome('/Users/person/Notes', '/Users/person')).toBe('~/Notes')
    expect(abbreviateHome('/Users/person-two/Notes', '/Users/person')).toBe('/Users/person-two/Notes')
    expect(abbreviateHome('/Volumes/Notes', '/Users/person')).toBe('/Volumes/Notes')
    expect(abbreviateHome('C:\\Users\\Person\\Notes', 'c:\\users\\person')).toBe('~\\Notes')
    expect(abbreviateHome('C:\\Users\\Person-two\\Notes', 'C:\\Users\\Person')).toBe('C:\\Users\\Person-two\\Notes')
  })
  it('checks a single safe folder name and preserves full creation paths', () => {
    for (const value of ['', ' ', '..', '../outside', 'a/b', 'a\\b', 'CON', 'file.', 'name ']) expect(validVaultName(value)).toBe(false)
    expect(validVaultName('My Vault')).toBe(true)
    expect(validVaultName('我的笔记')).toBe(true)
    expect(vaultChildPath('/Users/person/Documents/', 'My Vault')).toBe('/Users/person/Documents/My Vault')
  })
  it('shows first setup only when no existing root and no recorded choice', async () => {
    await initializeVaultOnboarding()
    expect(vaultManagement.onboardingOpen).toBe(true)
    expect(vaultManagement.onboardingShownThisRun).toBe(true)
    await skipVaultOnboarding()
    expect(mocks.invoke).toHaveBeenCalledWith('vault_set_onboarding', { value: 'skipped' })
    expect(vaultManagement.onboardingOpen).toBe(false)
    mocks.invoke.mockResolvedValue({ ...inspection(), onboarding: 'skipped' })
    await initializeVaultOnboarding()
    expect(vaultManagement.onboardingOpen).toBe(false)
  })
  it('routes missing existing roots to settings without offering to create another Vault', async () => {
    mocks.invoke.mockResolvedValue({ ...inspection('/missing'), accessible: false })
    await initializeVaultOnboarding()
    expect(vaultManagement.onboardingOpen).toBe(false)
    expect(mocks.invoke).not.toHaveBeenCalledWith('vault_set_onboarding', expect.anything())
    await openVaultManagement()
    expect(mocks.settings).toHaveBeenCalledWith('vault')
  })
  it('marks an existing accessible root completed and preserves first-run choice on write failure', async () => {
    mocks.invoke.mockImplementation(async (cmd) => cmd === 'vault_inspect' ? inspection('/vault') : undefined)
    await initializeVaultOnboarding()
    expect(mocks.invoke).toHaveBeenCalledWith('vault_set_onboarding', { value: 'completed' })
    vaultManagement.onboardingOpen = true
    mocks.invoke.mockRejectedValueOnce(new Error('cannot persist'))
    await expect(skipVaultOnboarding()).rejects.toThrow('cannot persist')
    expect(vaultManagement.onboardingOpen).toBe(true)
  })
  it('does not let an old inspection overwrite a newly activated root', async () => {
    let finish!: (info: VaultInspection) => void
    mocks.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const old = refreshVaultManagement()
    await applyVaultInspection(inspection('/new'))
    finish(inspection('/old'))
    await old
    expect(vaultManagement.info?.root).toBe('/new')
  })
  it('does not misreport creation as failed when a consumer refresh fails', async () => {
    mocks.invoke.mockResolvedValue(inspection('/created'))
    mocks.load.mockRejectedValueOnce(new Error('index consumer failed'))
    await expect(createVault('/parent', 'created')).resolves.toMatchObject({ root: '/created' })
    expect(mocks.invoke).toHaveBeenCalledWith('vault_create', { parent: '/parent', name: 'created', expectedRoot: null })
    expect(vaultManagement.error).toContain('index consumer failed')
  })
  it('waits for both Vault-scoped directory consumers before resolving a successful activation', async () => {
    let finishOutline!: () => void, finishInbox!: () => void
    mocks.outline.mockImplementationOnce(() => new Promise<void>(resolve => { finishOutline = resolve }))
    mocks.inbox.mockImplementationOnce(() => new Promise<void>(resolve => { finishInbox = resolve }))
    let finished = false
    const changed = applyVaultInspection(inspection('/new')).then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(mocks.outline).toHaveBeenCalledOnce()
    expect(mocks.inbox).toHaveBeenCalledOnce()
    finishOutline()
    await Promise.resolve()
    expect(finished).toBe(false)
    finishInbox()
    await changed
    expect(finished).toBe(true)
  })

})
