import { describe, it, expect, beforeEach } from 'vitest'
import { loadCache, saveCache } from './cache'

beforeEach(() => localStorage.clear())

describe('cache', () => {
  it('round-trips entry names keyed by vault root + kind', () => {
    saveCache('/Users/x/vault', 'weekly-review', ['2026-W30-weekly-review.md'])
    expect(loadCache('/Users/x/vault', 'weekly-review')).toEqual(['2026-W30-weekly-review.md'])
  })
  it('is isolated per kind', () => {
    saveCache('/v', 'diary', ['a.md'])
    expect(loadCache('/v', 'weekly-review')).toBeNull()
    expect(loadCache('/v', 'diary')).toEqual(['a.md'])
  })
  it('is isolated per vault root', () => {
    saveCache('/vault/a', 'diary', ['a.md'])
    expect(loadCache('/vault/b', 'diary')).toBeNull()
  })
  it('supports a per-year dailynote kind', () => {
    saveCache('/v', 'dailynote:2026', ['2026-07-20.note.md'])
    expect(loadCache('/v', 'dailynote:2026')).toEqual(['2026-07-20.note.md'])
    expect(loadCache('/v', 'dailynote:2025')).toBeNull()
  })
  it('returns null on missing or corrupt data', () => {
    expect(loadCache('/nope', 'diary')).toBeNull()
    localStorage.setItem('weekly-review:cache:diary:/bad', '{not json')
    expect(loadCache('/bad', 'diary')).toBeNull()
  })
})
