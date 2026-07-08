import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
const ask = vi.fn()
const pushToast = vi.fn()
const reloadTabFromDisk = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (...a: unknown[]) => ask(...a) }))
vi.mock('./toast.svelte', () => ({ pushToast: (...a: unknown[]) => pushToast(...a) }))
let sotvaultActive = true
vi.mock('./plugins/registry', () => ({ isPluginActive: () => sotvaultActive }))
vi.mock('./tabs.svelte', () => ({
  activeTab: () => ({ filePath: '/src/a.md' }),
  reloadTabFromDisk: (...a: unknown[]) => reloadTabFromDisk(...a),
}))

import { maybeCheckVaultUpdate, refreshSotvault, sotvaultStore } from './sotvault.svelte'

const VAULT = '/v/Sync/a.md'

/** check_update result for opening the vault copy. */
const vaultCheck = (outcome: string) => ({ outcome, vaultPath: VAULT, openedIsSource: false })
/** check_update result for opening the source file. */
const sourceCheck = (outcome: string) => ({ outcome, vaultPath: VAULT, openedIsSource: true })

beforeEach(() => {
  invoke.mockReset(); ask.mockReset(); pushToast.mockReset(); reloadTabFromDisk.mockReset()
  sotvaultActive = true
  sotvaultStore.vaultRoot = null
  sotvaultStore.records = []
})

describe('refreshSotvault', () => {
  it('loads the vault root even when the sotvault plugin is inactive', async () => {
    // The vault root is a global setting (VaultSyncManager.repo_path), independent
    // of the sotvault plugin. Features like reading-insights rely on it, so it must
    // load regardless — otherwise they wrongly report "no vault configured".
    sotvaultActive = false
    invoke.mockResolvedValueOnce('/v') // sotvault_vault_root
    await refreshSotvault()
    expect(sotvaultStore.vaultRoot).toBe('/v')
    // Records are sotvault-specific: skipped (no sotvault_records IPC) when inactive.
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('sotvault_vault_root')
    expect(sotvaultStore.records).toEqual([])
  })

  it('loads root and records when the plugin is active', async () => {
    invoke
      .mockResolvedValueOnce('/v')                          // sotvault_vault_root
      .mockResolvedValueOnce([{ source: '/s', vault: '/v/Sync/s.md' }]) // sotvault_records
    await refreshSotvault()
    expect(sotvaultStore.vaultRoot).toBe('/v')
    expect(sotvaultStore.records).toHaveLength(1)
  })
})

describe('maybeCheckVaultUpdate', () => {
  it('does nothing on up_to_date', async () => {
    invoke.mockResolvedValueOnce(vaultCheck('up_to_date'))
    await maybeCheckVaultUpdate({ filePath: VAULT })
    expect(ask).not.toHaveBeenCalled()
  })

  it('does nothing when not tracked', async () => {
    invoke.mockResolvedValueOnce({ outcome: 'not_tracked', vaultPath: null, openedIsSource: false })
    await maybeCheckVaultUpdate({ filePath: '/random/x.md' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('toasts on source_missing, no dialog', async () => {
    invoke.mockResolvedValueOnce(vaultCheck('source_missing'))
    await maybeCheckVaultUpdate({ filePath: VAULT })
    expect(ask).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
  })

  it('applies update when origin_updated is confirmed (vault copy opened)', async () => {
    invoke
      .mockResolvedValueOnce(vaultCheck('origin_updated')) // sotvault_check_update
      .mockResolvedValueOnce('NEW CONTENT')                // sotvault_apply_update
      .mockResolvedValueOnce('/v')                         // sotvault_vault_root (refresh)
      .mockResolvedValueOnce([])                           // sotvault_records (refresh)
    ask.mockResolvedValueOnce(true)
    await maybeCheckVaultUpdate({ filePath: VAULT })
    expect(invoke).toHaveBeenCalledWith('sotvault_apply_update', { vaultPath: VAULT })
    expect(reloadTabFromDisk).toHaveBeenCalledWith(VAULT)
  })

  it('prompts to sync when the opened SOURCE file changed since last sync', async () => {
    invoke
      .mockResolvedValueOnce(sourceCheck('origin_updated')) // check_update keyed by source
      .mockResolvedValueOnce('NEW CONTENT')                 // apply_update
      .mockResolvedValueOnce('/v')                          // refresh root
      .mockResolvedValueOnce([])                            // refresh records
    ask.mockResolvedValueOnce(true)
    await maybeCheckVaultUpdate({ filePath: '/src/a.md' })
    // applies to the resolved vault path, not the opened source path
    expect(invoke).toHaveBeenCalledWith('sotvault_apply_update', { vaultPath: VAULT })
  })

  it('does not apply when origin_updated is declined', async () => {
    invoke.mockResolvedValueOnce(vaultCheck('origin_updated'))
    ask.mockResolvedValueOnce(false)
    await maybeCheckVaultUpdate({ filePath: VAULT })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('conflict: overwrite path applies update', async () => {
    invoke
      .mockResolvedValueOnce(vaultCheck('conflict'))
      .mockResolvedValueOnce('NEW')   // apply_update
      .mockResolvedValueOnce('/v')    // refresh root
      .mockResolvedValueOnce([])      // refresh records
    ask.mockResolvedValueOnce(true)   // overwrite? yes
    await maybeCheckVaultUpdate({ filePath: VAULT })
    expect(invoke).toHaveBeenCalledWith('sotvault_apply_update', { vaultPath: VAULT })
  })

  it('conflict: keep-vault path accepts current', async () => {
    invoke
      .mockResolvedValueOnce(vaultCheck('conflict'))
      .mockResolvedValueOnce(undefined) // accept_current
      .mockResolvedValueOnce('/v')      // refresh root
      .mockResolvedValueOnce([])        // refresh records
    ask.mockResolvedValueOnce(false)    // overwrite? no
    ask.mockResolvedValueOnce(true)     // keep vault & stop prompting? yes
    await maybeCheckVaultUpdate({ filePath: VAULT })
    expect(invoke).toHaveBeenCalledWith('sotvault_accept_current', { vaultPath: VAULT })
  })
})
