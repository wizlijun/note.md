import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPreferenceSaver, defaultPreferences, defaultVaultPreference, MAX_RECENT_DATASETS,
  normalizePreferences, preferenceForVault, setVaultPreference, touchDatasetPreference,
  vaultPreferenceKey,
} from './preferences'

afterEach(() => vi.useRealTimers())

describe('knowledge browser preferences', () => {
  it('partitions by an irreversible Vault key without persisting the absolute root', async () => {
    const root = '/Users/example/private-vault'
    const key = await vaultPreferenceKey(root)
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(key).not.toContain(root)
    const value = setVaultPreference(defaultPreferences(), key, { ...defaultVaultPreference(), recursive: true })
    expect(preferenceForVault(value, key).recursive).toBe(true)
    expect(JSON.stringify(value)).not.toContain(root)
  })

  it('repairs malformed fields and keeps only 50 newest dataset locations', () => {
    let vault = defaultVaultPreference()
    for (let i = 0; i < 55; i++) {
      vault = touchDatasetPreference(vault, { path: `research/${i}.knowledge.json`, datasetId: `ks_${i}`, view: 'reading', ref: `q${i + 1}`, touchedAt: i })
    }
    expect(vault.recent).toHaveLength(MAX_RECENT_DATASETS)
    expect(vault.recent[0].datasetId).toBe('ks_54')
    expect(vault.recent.at(-1)?.datasetId).toBe('ks_5')
    const key = 'a'.repeat(64)
    const normalized = normalizePreferences({ schemaVersion: 1, vaults: { [key]: { directory: '../escape', recursive: 'yes', listWidth: 999, sort: 'unknown', recent: vault.recent } } })
    expect(normalized.vaults[key]).toMatchObject({ directory: 'research', recursive: false, listWidth: 480, sort: 'core' })
  })

  it('debounces writes, flushes the latest value, and reports failures without throwing', async () => {
    vi.useFakeTimers()
    const write = vi.fn(async () => {})
    const onError = vi.fn()
    const saver = createPreferenceSaver(write, 100, onError)
    const first = defaultPreferences()
    const second = { ...defaultPreferences(), vaults: { ['b'.repeat(64)]: defaultVaultPreference() } }
    saver.schedule(first)
    saver.schedule(second)
    await vi.advanceTimersByTimeAsync(100)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(second)
    write.mockRejectedValueOnce(new Error('disk full'))
    saver.schedule(first)
    await saver.flush()
    expect(onError).toHaveBeenCalledOnce()
    saver.schedule(second)
    saver.cancel()
    await vi.advanceTimersByTimeAsync(200)
    expect(write).toHaveBeenCalledTimes(2)
  })
})
