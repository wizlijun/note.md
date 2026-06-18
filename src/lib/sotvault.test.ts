import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
const ask = vi.fn()
const pushToast = vi.fn()
const reloadTabFromDisk = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (...a: unknown[]) => ask(...a) }))
vi.mock('./toast.svelte', () => ({ pushToast: (...a: unknown[]) => pushToast(...a) }))
vi.mock('./plugins/registry', () => ({ isPluginActive: () => true }))
vi.mock('./tabs.svelte', () => ({
  activeTab: () => ({ filePath: '/src/a.md' }),
  reloadTabFromDisk: (...a: unknown[]) => reloadTabFromDisk(...a),
}))

import { maybeCheckVaultUpdate } from './sotvault.svelte'

beforeEach(() => {
  invoke.mockReset(); ask.mockReset(); pushToast.mockReset(); reloadTabFromDisk.mockReset()
})

describe('maybeCheckVaultUpdate', () => {
  it('does nothing on up_to_date', async () => {
    invoke.mockResolvedValueOnce('up_to_date')
    await maybeCheckVaultUpdate({ filePath: '/v/Imported/a.md' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('toasts on source_missing, no dialog', async () => {
    invoke.mockResolvedValueOnce('source_missing')
    await maybeCheckVaultUpdate({ filePath: '/v/Imported/a.md' })
    expect(ask).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
  })

  it('applies update when origin_updated is confirmed', async () => {
    invoke
      .mockResolvedValueOnce('origin_updated')   // sotvault_check_update
      .mockResolvedValueOnce('NEW CONTENT')      // sotvault_apply_update
      .mockResolvedValueOnce('/v')               // sotvault_vault_root (refresh)
      .mockResolvedValueOnce([])                 // sotvault_records (refresh)
    ask.mockResolvedValueOnce(true)
    await maybeCheckVaultUpdate({ filePath: '/v/Imported/a.md' })
    expect(invoke).toHaveBeenCalledWith('sotvault_apply_update', { vaultPath: '/v/Imported/a.md' })
    expect(reloadTabFromDisk).toHaveBeenCalledWith('/v/Imported/a.md')
  })

  it('does not apply when origin_updated is declined', async () => {
    invoke.mockResolvedValueOnce('origin_updated')
    ask.mockResolvedValueOnce(false)
    await maybeCheckVaultUpdate({ filePath: '/v/Imported/a.md' })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('conflict: overwrite path applies update', async () => {
    invoke
      .mockResolvedValueOnce('conflict')
      .mockResolvedValueOnce('NEW')   // apply_update
      .mockResolvedValueOnce('/v')    // refresh root
      .mockResolvedValueOnce([])      // refresh records
    ask.mockResolvedValueOnce(true)   // overwrite? yes
    await maybeCheckVaultUpdate({ filePath: '/v/Imported/a.md' })
    expect(invoke).toHaveBeenCalledWith('sotvault_apply_update', { vaultPath: '/v/Imported/a.md' })
  })

  it('conflict: keep-vault path accepts current', async () => {
    invoke
      .mockResolvedValueOnce('conflict')
      .mockResolvedValueOnce(undefined) // accept_current
      .mockResolvedValueOnce('/v')      // refresh root
      .mockResolvedValueOnce([])        // refresh records
    ask.mockResolvedValueOnce(false)    // overwrite? no
    ask.mockResolvedValueOnce(true)     // keep vault & stop prompting? yes
    await maybeCheckVaultUpdate({ filePath: '/v/Imported/a.md' })
    expect(invoke).toHaveBeenCalledWith('sotvault_accept_current', { vaultPath: '/v/Imported/a.md' })
  })
})
