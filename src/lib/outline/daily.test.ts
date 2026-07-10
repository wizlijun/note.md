// src/lib/outline/daily.test.ts
import { describe, it, expect } from 'vitest'
import { parseDateLink, dailyNotePath, todayStr } from './daily'

describe('parseDateLink(规范形式,spec §6:仅三种,其余一律 null)', () => {
  it('day / month / year', () => {
    expect(parseDateLink('2026-07-10')).toEqual({ kind: 'day', year: '2026' })
    expect(parseDateLink('2026-07')).toEqual({ kind: 'month', year: '2026' })
    expect(parseDateLink('2026')).toEqual({ kind: 'year', year: '2026' })
  })
  it('rejects non-canonical date formats', () => {
    expect(parseDateLink('2026/07/10')).toBeNull()
    expect(parseDateLink('26-07-10')).toBeNull()
    expect(parseDateLink('2026-7-1')).toBeNull()
    expect(parseDateLink('2026-13')).toBeNull()      // 月份越界
    expect(parseDateLink('2026-07-32')).toBeNull()   // 日期越界
    expect(parseDateLink('July 10')).toBeNull()
    expect(parseDateLink('20260710')).toBeNull()
  })
})

describe('dailyNotePath', () => {
  it('builds vault/{dailynote}/{yyyy}/{target}.note.md', () => {
    expect(dailyNotePath('/v', 'dailynote', '2026-07-10')).toBe('/v/dailynote/2026/2026-07-10.note.md')
    expect(dailyNotePath('/v', 'dailynote', '2026-07')).toBe('/v/dailynote/2026/2026-07.note.md')
    expect(dailyNotePath('/v', '日记', '2026')).toBe('/v/日记/2026/2026.note.md')
  })
  it('null for non-date targets', () => {
    expect(dailyNotePath('/v', 'dailynote', 'not-a-date')).toBeNull()
  })
})

describe('todayStr', () => {
  it('formats local date as yyyy-MM-dd', () => {
    expect(todayStr(new Date(2026, 6, 10))).toBe('2026-07-10')  // 月份 0-based
    expect(todayStr(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})
