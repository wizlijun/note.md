import { describe, it, expect, beforeEach } from 'vitest'
import { loadCache, saveCache } from './cache'

beforeEach(() => localStorage.clear())

describe('cache', () => {
  it('round-trips entry names keyed by vault root', () => {
    saveCache('/Users/x/vault', ['2026-W30-weekly-review.md'])
    expect(loadCache('/Users/x/vault')).toEqual(['2026-W30-weekly-review.md'])
  })
  it('is isolated per vault root', () => {
    saveCache('/vault/a', ['a.md'])
    expect(loadCache('/vault/b')).toBeNull()
  })
  it('returns null on missing or corrupt data', () => {
    expect(loadCache('/nope')).toBeNull()
    localStorage.setItem('weekly-review:cache:/bad', '{not json')
    expect(loadCache('/bad')).toBeNull()
  })
})
