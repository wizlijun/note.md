import { describe, it, expect } from 'vitest'
import { addDays, dateRange, extendEarlier, extendLater } from './dates'

describe('daily/dates', () => {
  it('addDays crosses month/year boundaries', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-07-23', 0)).toBe('2026-07-23')
  })
  it('dateRange is inclusive, descending (newest first)', () => {
    expect(dateRange('2026-07-23', 3)).toEqual(['2026-07-23', '2026-07-22', '2026-07-21'])
  })
  it('extendEarlier appends older dates after the current tail', () => {
    const cur = ['2026-07-23', '2026-07-22']
    expect(extendEarlier(cur, 2)).toEqual(['2026-07-21', '2026-07-20'])
  })
  it('extendLater prepends newer dates before the current head', () => {
    const cur = ['2026-07-22', '2026-07-21']
    expect(extendLater(cur, 2)).toEqual(['2026-07-24', '2026-07-23'])
  })
})
