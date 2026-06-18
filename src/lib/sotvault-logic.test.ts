import { describe, it, expect } from 'vitest'
import { isTracked, canSyncToVault, dialogActionFor, sourceForVault, localYmd, type SotRecord } from './sotvault-logic'

const rec = (vault: string, source: string): SotRecord => ({
  vault_path: vault, source_path: source, synced_at: 1, source_hash: 'a', vault_hash: 'a',
})

describe('isTracked', () => {
  it('matches by vault_path', () => {
    const recs = [rec('/v/Imported/a.md', '/src/a.md')]
    expect(isTracked('/v/Imported/a.md', recs)).toBe(true)
    expect(isTracked('/src/a.md', recs)).toBe(false)
    expect(isTracked(null, recs)).toBe(false)
  })
})

describe('canSyncToVault', () => {
  const recs = [rec('/v/Imported/a.md', '/src/a.md')]
  it('true for a saved file outside the vault and not tracked', () => {
    expect(canSyncToVault('/src/b.md', '/v', recs)).toBe(true)
  })
  it('false when no path or no vault root', () => {
    expect(canSyncToVault(null, '/v', recs)).toBe(false)
    expect(canSyncToVault('/src/b.md', null, recs)).toBe(false)
  })
  it('false when the file already lives under the vault root', () => {
    expect(canSyncToVault('/v/Imported/a.md', '/v', recs)).toBe(false)
    expect(canSyncToVault('/v/notes.md', '/v', recs)).toBe(false)
  })
  it('does not treat a sibling dir sharing a prefix as inside the vault', () => {
    expect(canSyncToVault('/vault-backup/x.md', '/vault', recs)).toBe(true)
  })
  it('false when the source file has already been synced', () => {
    expect(canSyncToVault('/src/a.md', '/v', recs)).toBe(false)
  })
})

describe('dialogActionFor', () => {
  it('maps outcomes to actions', () => {
    expect(dialogActionFor('origin_updated')).toBe('confirm-origin')
    expect(dialogActionFor('conflict')).toBe('conflict')
    expect(dialogActionFor('source_missing')).toBe('source-missing')
    expect(dialogActionFor('up_to_date')).toBe('none')
    expect(dialogActionFor('not_tracked')).toBe('none')
    expect(dialogActionFor('anything-else')).toBe('none')
  })
})

describe('sourceForVault', () => {
  const recs = [rec('/v/Sync/a.md', '/src/a.md')]
  it('returns the source path for a tracked vault copy', () => {
    expect(sourceForVault('/v/Sync/a.md', recs)).toBe('/src/a.md')
  })
  it('returns null for an untracked or missing path', () => {
    expect(sourceForVault('/v/Sync/other.md', recs)).toBe(null)
    expect(sourceForVault(null, recs)).toBe(null)
  })
})

describe('localYmd', () => {
  it('formats a local date as zero-padded yyyy-MM-dd', () => {
    expect(localYmd(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(localYmd(new Date(2026, 11, 31))).toBe('2026-12-31')
  })
})

