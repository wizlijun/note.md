import { describe, it, expect } from 'vitest'
import { historyAppliesTo, relTime } from './applies'

describe('historyAppliesTo', () => {
  it('true when the file is under the vault root', () => {
    expect(historyAppliesTo({ filePath: '/vault/Sync/a.md' }, '/vault')).toBe(true)
  })
  it('false when the file is outside the vault root', () => {
    expect(historyAppliesTo({ filePath: '/other/a.md' }, '/vault')).toBe(false)
  })
  it('false when there is no vault root', () => {
    expect(historyAppliesTo({ filePath: '/vault/a.md' }, null)).toBe(false)
  })
  it('false for an untitled tab (empty path)', () => {
    expect(historyAppliesTo({ filePath: '' }, '/vault')).toBe(false)
  })
  it('false when tab is null', () => {
    expect(historyAppliesTo(null, '/vault')).toBe(false)
  })
})

describe('relTime', () => {
  const now = 1_700_000_000 // seconds
  it('"just now" within a minute', () => {
    expect(relTime(now - 5, now)).toBe('just now')
  })
  it('minutes', () => {
    expect(relTime(now - 120, now)).toBe('2m')
  })
  it('hours', () => {
    expect(relTime(now - 3 * 3600, now)).toBe('3h')
  })
  it('days', () => {
    expect(relTime(now - 2 * 86400, now)).toBe('2d')
  })
})
