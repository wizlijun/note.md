import { describe, it, expect } from 'vitest'
import { isoWeek, isoWeekYear, mondayOf, weeksInYear, buildMonthRows } from './isoweek'

describe('isoWeek', () => {
  it('2026-01-01 (Thu) is week 1 of 2026', () => {
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1)
    expect(isoWeekYear(new Date(2026, 0, 1))).toBe(2026)
  })
  it('2026-07-23 is week 30', () => {
    expect(isoWeek(new Date(2026, 6, 23))).toBe(30)
  })
  it('2026-12-28 (Mon) is week 53 — 2026 is a 53-week year', () => {
    expect(isoWeek(new Date(2026, 11, 28))).toBe(53)
    expect(weeksInYear(2026)).toBe(53)
  })
  it('2025 is a 52-week year', () => {
    expect(weeksInYear(2025)).toBe(52)
  })
})

describe('mondayOf', () => {
  it('returns the Monday 00:00 of the week', () => {
    const m = mondayOf(new Date(2026, 6, 23)) // Thu → Mon 2026-07-20
    expect(m.getFullYear()).toBe(2026)
    expect(m.getMonth()).toBe(6)
    expect(m.getDate()).toBe(20)
    expect(m.getHours()).toBe(0)
  })
})

describe('buildMonthRows', () => {
  it('groups July 2026 into ISO-week rows, Monday-first', () => {
    const rows = buildMonthRows(2026, 6) // July
    expect(rows[0].week).toBe(27)
    expect(rows[0].days[0]).toBe(null) // Monday col = June 29, outside July → null
    expect(rows[0].days[2]).toBe(1)    // Wednesday col = July 1
    const w30 = rows.find(r => r.week === 30)!
    expect(w30.days).toEqual([20, 21, 22, 23, 24, 25, 26])
    for (const r of rows) expect(r.days.length).toBe(7)
  })
  it('assigns the ISO week-numbering year on cross-year rows', () => {
    const jan = buildMonthRows(2026, 0)
    expect(jan[0].week).toBe(1)
    expect(jan[0].weekYear).toBe(2026)
  })
})
