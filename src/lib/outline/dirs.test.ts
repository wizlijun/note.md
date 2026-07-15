// src/lib/outline/dirs.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

const storeGet = vi.fn()
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: async () => ({ get: storeGet, set: vi.fn(), save: vi.fn() }) },
}))

import { normalizeDirName, DEFAULT_DIRS, outlineDirs, loadOutlineDirs, setOutlineDir } from './dirs.svelte'

describe('normalizeDirName', () => {
  it('keeps legal names, sanitizes illegal chars', () => {
    expect(normalizeDirName('wikipage', 'wikipage')).toBe('wikipage')
    expect(normalizeDirName('我的wiki', 'wikipage')).toBe('我的wiki')
    expect(normalizeDirName('a/b', 'wikipage')).toBe('a-b')
  })
  it('empty/blank falls back to provided default', () => {
    expect(normalizeDirName('', 'wikipage')).toBe('wikipage')
    expect(normalizeDirName('   ', 'dailynote')).toBe('dailynote')
  })
})

describe('DEFAULT_DIRS', () => {
  it('matches spec defaults', () => {
    expect(DEFAULT_DIRS).toEqual({ wikipage: 'wikipage', dailynote: 'dailynote' })
  })
})

function routeVault(dto: Record<string, unknown>) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'notemd_vault_settings_get') return Promise.resolve(dto)
    if (cmd === 'notemd_vault_settings_set') return Promise.resolve(dto)
    return Promise.reject(new Error(`unexpected ${cmd}`))
  })
}

beforeEach(() => {
  invoke.mockReset()
  storeGet.mockReset()
  storeGet.mockResolvedValue(undefined) // no legacy app-store values by default
  outlineDirs.wikipage = DEFAULT_DIRS.wikipage
  outlineDirs.dailynote = DEFAULT_DIRS.dailynote
})

describe('loadOutlineDirs', () => {
  it('adopts the vault config values', async () => {
    routeVault({ wikipageDir: 'pages', dailynoteDir: 'journal' })
    await loadOutlineDirs()
    expect(outlineDirs.wikipage).toBe('pages')
    expect(outlineDirs.dailynote).toBe('journal')
  })

  it('falls back to the legacy app-store value when the vault config omits it', async () => {
    routeVault({}) // vault config empty
    storeGet.mockImplementation(async (k: string) =>
      k === 'outline.wikipageDir' ? 'oldwiki' : undefined,
    )
    await loadOutlineDirs()
    expect(outlineDirs.wikipage).toBe('oldwiki')
    expect(outlineDirs.dailynote).toBe(DEFAULT_DIRS.dailynote)
  })

  it('migrates a legacy value into the vault config (write-through)', async () => {
    routeVault({})
    storeGet.mockImplementation(async (k: string) =>
      k === 'outline.wikipageDir' ? 'oldwiki' : undefined,
    )
    await loadOutlineDirs()
    expect(invoke).toHaveBeenCalledWith('notemd_vault_settings_set', { wikipageDir: 'oldwiki' })
  })

  it('uses defaults when neither vault config nor legacy has a value', async () => {
    routeVault({})
    await loadOutlineDirs()
    expect(outlineDirs.wikipage).toBe(DEFAULT_DIRS.wikipage)
    expect(outlineDirs.dailynote).toBe(DEFAULT_DIRS.dailynote)
    expect(invoke).not.toHaveBeenCalledWith('notemd_vault_settings_set', expect.anything())
  })

  it('does not throw when the vault is not configured', async () => {
    invoke.mockRejectedValue(new Error('Vault not configured'))
    await loadOutlineDirs()
    expect(outlineDirs.wikipage).toBe(DEFAULT_DIRS.wikipage)
  })
})

describe('setOutlineDir', () => {
  it('normalizes and writes the field to the vault config', async () => {
    routeVault({ wikipageDir: 'foo-bar' })
    await setOutlineDir('wikipage', '  foo bar  ')
    expect(outlineDirs.wikipage).not.toBe('')
    expect(invoke).toHaveBeenCalledWith(
      'notemd_vault_settings_set',
      expect.objectContaining({ wikipageDir: outlineDirs.wikipage }),
    )
  })
})
