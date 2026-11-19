import { describe, expect, it } from 'vitest'
import {
  emptyHomeAppsData, normalizeHomeAppsData, recordUsage, pinApp, unpinApp,
  movePin, reconcileInstalled, refreshRanking, shortcutSlots,
} from './model'

const day = (offset = 0, hour = 12) => new Date(2026, 10, 19 + offset, hour).getTime()

describe('home shortcut positions', () => {
  it('keeps explicit slots, fills recommendations once and preserves holes', () => {
    const base = emptyHomeAppsData()
    const pinned = pinApp(base, 'a', 3)
    expect(pinned.pins.filter(Boolean)).toEqual(['a'])
    expect(base.pins.every((id) => id === null)).toBe(true)
    const data = { ...pinned, snapshot: { day: '2026-11-19', ids: ['a', 'b', 'b', 'c'] } }
    expect(shortcutSlots(data, ['a', 'b', 'c'])).toEqual(['b', 'c', null, 'a', null, null, null, null])
    expect(shortcutSlots(data, ['c'])).toEqual(['c', null, null, 'a', null, null, null, null])
  })

  it('rejects invalid slots, duplicate pins and occupied new pins', () => {
    const pinned = pinApp(emptyHomeAppsData(), 'a', 3)
    for (const slot of [-1, 8, 1.5, NaN]) expect(() => pinApp(pinned, 'b', slot)).toThrow(RangeError)
    expect(() => pinApp(pinned, '', 0)).toThrow()
    expect(() => pinApp(pinned, 'a', 2)).toThrow()
    expect(() => pinApp(pinned, 'b', 3)).toThrow()
    let full = emptyHomeAppsData()
    for (let slot = 0; slot < 8; slot++) full = pinApp(full, String(slot), slot)
    expect(() => pinApp(full, 'ninth', 0)).toThrow()
    expect(full.pins).toHaveLength(8)
  })

  it('swaps pins atomically and unpins without moving other fixed positions', () => {
    const base = pinApp(pinApp(emptyHomeAppsData(), 'a', 1), 'b', 5)
    const moved = movePin(base, 'a', 5)
    expect(moved.pins).toEqual([null, 'b', null, null, null, 'a', null, null])
    expect(unpinApp(moved, 'a').pins).toEqual([null, 'b', null, null, null, null, null, null])
    expect(base.pins[1]).toBe('a')
    expect(() => movePin(base, 'unknown', 0)).toThrow()
  })

  it('moves an auto item using the actual visible source even after eligibility filtering', () => {
    const data = pinApp(emptyHomeAppsData(), 'fixed', 3)
    data.snapshot = { day: '2026-11-19', ids: ['disabled', 'auto'] }
    expect(shortcutSlots(data, ['auto'])).toEqual(['auto', null, null, 'fixed', null, null, null, null])
    const moved = movePin(data, 'auto', 3, 0)
    expect(moved.pins).toEqual(['fixed', null, null, 'auto', null, null, null, null])
    expect(() => movePin(data, 'auto', 0, 3)).toThrow()
    expect(() => movePin(data, 'unknown', 3, 0)).toThrow()
  })

  it('retains disabled fixed apps and removes only uninstalled identities', () => {
    let data = pinApp(pinApp(emptyHomeAppsData(), 'disabled', 4), 'gone', 7)
    data = recordUsage(recordUsage(data, 'disabled', day()), 'gone', day())
    data = refreshRanking(data, ['gone'], day())
    const reconciled = reconcileInstalled(data, ['disabled'])
    expect(reconciled.pins).toEqual([null, null, null, null, 'disabled', null, null, null])
    expect(Object.keys(reconciled.usage)).toEqual(['disabled'])
    expect(reconciled.snapshot.ids).toEqual([])
    expect(data.pins[7]).toBe('gone')
  })
})

describe('usage and daily ranking', () => {
  it('deduplicates within 30 seconds and does not mutate nested input', () => {
    const base = recordUsage(emptyHomeAppsData(), 'a', day())
    expect(recordUsage(base, 'a', day() + 29_999).usage.a.days['2026-11-19']).toBe(1)
    const next = recordUsage(base, 'a', day() + 30_000)
    expect(next.usage.a.days['2026-11-19']).toBe(2)
    expect(base.usage.a.days['2026-11-19']).toBe(1)
    expect(next.usage.a.lastUsed).toBe(day() + 30_000)
  })

  it('freezes same-day snapshot, refreshes next local day and preserves fixed index', () => {
    let data = recordUsage(pinApp(emptyHomeAppsData(), 'fixed', 5), 'b', day())
    data = refreshRanking(data, ['b', 'c', 'fixed'], day())
    data = recordUsage(data, 'c', day() + 60_000)
    expect(refreshRanking(data, ['b', 'c'], day()).snapshot.ids).toEqual(['b'])
    data = refreshRanking(data, ['b', 'c'], day(1))
    expect(data.snapshot.ids).toEqual(['b', 'c'])
    expect(shortcutSlots(data, ['b', 'c'])[5]).toBe('fixed')
    expect(refreshRanking(emptyHomeAppsData(), ['a'], day()).snapshot.ids).toEqual([])
  })

  it('doubles latest seven local calendar days, expires day 30 and ignores future buckets', () => {
    const data = emptyHomeAppsData()
    data.usage = {
      recent: { days: { '2026-11-13': 2 }, lastUsed: day(-6) },
      old: { days: { '2026-11-12': 3 }, lastUsed: day(-7) },
      boundary: { days: { '2026-10-21': 1 }, lastUsed: day(-29) },
      expired: { days: { '2026-10-20': 99 }, lastUsed: day(-30) },
      future: { days: { '2026-11-20': 99 }, lastUsed: day(1) },
    }
    const ranked = refreshRanking(data, Object.keys(data.usage), day())
    expect(ranked.snapshot.ids).toEqual(['recent', 'old', 'boundary'])
    expect(ranked.usage.expired).toBeUndefined()
    expect(ranked.usage.future).toBeUndefined()
  })

  it('breaks score ties by previous order, recent use, then stable id', () => {
    const data = emptyHomeAppsData()
    for (const id of ['z', 'b', 'a', 'y']) data.usage[id] = { days: { '2026-11-18': 1 }, lastUsed: day(-1) }
    data.usage.z.lastUsed += 1_000
    data.snapshot = { day: '2026-11-18', ids: ['y'] }
    expect(refreshRanking(data, ['a', 'b', 'y', 'z'], day()).snapshot.ids).toEqual(['y', 'z', 'a', 'b'])
  })

  it('uses local date rather than UTC and bounds usage to thirty buckets', () => {
    const now = new Date(2026, 10, 19, 0, 1).getTime()
    let data = emptyHomeAppsData()
    for (let offset = -40; offset <= 0; offset++) data = recordUsage(data, 'a', day(offset))
    expect(Object.keys(data.usage.a.days)).toHaveLength(30)
    expect(refreshRanking(data, ['a'], now).snapshot.day).toBe('2026-11-19')
    expect(recordUsage(emptyHomeAppsData(), 'midnight', now).usage.midnight.days['2026-11-19']).toBe(1)
  })

  it('scores calendar days correctly over the autumn daylight-saving boundary', () => {
    const data = emptyHomeAppsData()
    data.usage = {
      recent: { days: { '2026-10-27': 1 }, lastUsed: new Date(2026, 9, 27, 12).getTime() },
      older: { days: { '2026-10-26': 1 }, lastUsed: new Date(2026, 9, 26, 12).getTime() },
    }
    expect(refreshRanking(data, ['older', 'recent'], new Date(2026, 10, 2, 12).getTime()).snapshot.ids).toEqual(['recent', 'older'])
  })
})

describe('stored schema normalization', () => {
  it('normalizes malformed data without duplicating or shifting fixed slots', () => {
    const data = normalizeHomeAppsData({
      version: 1, pins: ['a', 12, 'a', null, 'b', '', 'c', 'd', 'overflow'],
      usage: { a: { days: { '2026-11-19': 2, '2026-02-30': 2, bad: 1, '2026-11-18': -1 }, lastUsed: 5 }, bad: null },
      snapshot: { day: '2026-11-19', ids: ['a', 3, 'a', 'b'] },
    })
    expect(data.pins).toEqual(['a', null, null, null, 'b', null, 'c', 'd'])
    expect(data.usage).toEqual({ a: { days: { '2026-11-19': 2 }, lastUsed: 5 } })
    expect(data.snapshot).toEqual({ day: '2026-11-19', ids: ['a', 'b'] })
    expect(normalizeHomeAppsData({ version: 2, pins: ['a'] })).toEqual(emptyHomeAppsData())
    expect(normalizeHomeAppsData(null)).toEqual(emptyHomeAppsData())
  })
})
