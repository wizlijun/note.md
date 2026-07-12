import { describe, it, expect } from 'vitest'
import { historyAppliesTo, formatDateTime } from './applies'

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

describe('formatDateTime', () => {
  it('formats a unix-seconds timestamp as local yyyy-MM-dd HH:mm', () => {
    const ts = Math.floor(new Date(2026, 6, 12, 17, 36, 0).getTime() / 1000)
    expect(formatDateTime(ts)).toBe('2026-07-12 17:36')
  })
  it('zero-pads month, day, hour, minute', () => {
    const ts = Math.floor(new Date(2026, 0, 3, 4, 5, 0).getTime() / 1000)
    expect(formatDateTime(ts)).toBe('2026-01-03 04:05')
  })
})
