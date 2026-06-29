import { describe, it, expect } from 'vitest'
import {
  isUnder,
  toSyncedEntry,
  resolveEntry,
  resolveLocalRecents,
  mergeRecents,
  formatRecentLabel,
  type DeviceRecents,
  type ResolvedRecent,
} from './recent-merge'

describe('isUnder', () => {
  it('true for path inside root, false otherwise', () => {
    expect(isUnder('/v/notes/a.md', '/v')).toBe(true)
    expect(isUnder('/v', '/v')).toBe(true)
    expect(isUnder('/vault2/a.md', '/v')).toBe(false)
  })
})

describe('toSyncedEntry', () => {
  it('uses rel for vault-internal paths', () => {
    expect(toSyncedEntry('/v/notes/a.md', 100, '/v')).toEqual({ rel: 'notes/a.md', lastOpened: 100 })
  })
  it('uses abs for vault-external paths', () => {
    expect(toSyncedEntry('/other/a.md', 100, '/v')).toEqual({ abs: '/other/a.md', lastOpened: 100 })
  })
  it('uses abs when no vault configured', () => {
    expect(toSyncedEntry('/x/a.md', 100, null)).toEqual({ abs: '/x/a.md', lastOpened: 100 })
  })
})

describe('resolveEntry', () => {
  it('resolves rel against the local vault root', () => {
    expect(resolveEntry({ rel: 'notes/a.md', lastOpened: 5 }, '/local')).toEqual({ path: '/local/notes/a.md', lastOpened: 5 })
  })
  it('drops rel entry when no vault root', () => {
    expect(resolveEntry({ rel: 'notes/a.md', lastOpened: 5 }, null)).toBeNull()
  })
  it('passes abs through unchanged', () => {
    expect(resolveEntry({ abs: '/x/a.md', lastOpened: 5 }, '/local')).toEqual({ path: '/x/a.md', lastOpened: 5 })
  })
})

describe('resolveLocalRecents', () => {
  it('preserves most-recent-first order with strictly-decreasing timestamps when none are tracked', () => {
    const r = resolveLocalRecents(['/a', '/b', '/c'], {}, 1000)
    expect(r.map((x) => x.path)).toEqual(['/a', '/b', '/c'])
    expect(r[0].lastOpened).toBeGreaterThan(r[1].lastOpened)
    expect(r[1].lastOpened).toBeGreaterThan(r[2].lastOpened)
  })

  it('does not let a real timestamp drift below later wall-clock legacy entries', () => {
    // /a opened at t=100 (real). Menu refreshed much later (nowAnchor=10000).
    // /b and /c have no stored timestamp. /a must stay first; legacy entries
    // slot just below it — they must NOT jump above /a using the current clock.
    const r = resolveLocalRecents(['/a', '/b', '/c'], { '/a': 100 }, 10000)
    expect(r.map((x) => x.path)).toEqual(['/a', '/b', '/c'])
    expect(r[0].lastOpened).toBe(100)
    expect(r[1].lastOpened).toBeLessThan(100)
    expect(r[2].lastOpened).toBeLessThan(r[1].lastOpened)
  })

  it('honours real timestamps that already match list order', () => {
    const r = resolveLocalRecents(['/a', '/b'], { '/a': 200, '/b': 100 }, 10000)
    expect(r).toEqual([{ path: '/a', lastOpened: 200 }, { path: '/b', lastOpened: 100 }])
  })

  it('clamps an out-of-order real timestamp so list order always wins', () => {
    // /b has a (stale/larger) timestamp than /a but sits lower in the list.
    const r = resolveLocalRecents(['/a', '/b'], { '/a': 100, '/b': 999 }, 10000)
    expect(r.map((x) => x.path)).toEqual(['/a', '/b'])
    expect(r[0].lastOpened).toBe(100)
    expect(r[1].lastOpened).toBeLessThan(100)
  })
})

describe('mergeRecents', () => {
  const local: ResolvedRecent[] = [{ path: '/v/a.md', lastOpened: 50 }]
  it('unions local + device files, dedups by path keeping max lastOpened, sorts desc', () => {
    const devices: DeviceRecents[] = [
      { deviceId: 'd2', deviceName: 'D2', entries: [
        { rel: 'a.md', lastOpened: 80 },     // same file, newer → /v/a.md ts 80
        { rel: 'b.md', lastOpened: 70 },
      ] },
    ]
    expect(mergeRecents(local, devices, '/v', [], 10)).toEqual(['/v/a.md', '/v/b.md'])
  })
  it('filters tombstoned paths', () => {
    const devices: DeviceRecents[] = [
      { deviceId: 'd2', deviceName: 'D2', entries: [{ abs: '/x/gone.md', lastOpened: 99 }] },
    ]
    expect(mergeRecents(local, devices, '/v', ['/x/gone.md'], 10)).toEqual(['/v/a.md'])
  })
  it('caps at limit', () => {
    const many: ResolvedRecent[] = Array.from({ length: 15 }, (_, i) => ({ path: `/v/${i}.md`, lastOpened: i }))
    expect(mergeRecents(many, [], '/v', [], 10)).toHaveLength(10)
  })
})

describe('formatRecentLabel', () => {
  it('abbreviates home and shows filename — dir', () => {
    expect(formatRecentLabel('/Users/b/docs/a.md', '/Users/b')).toBe('a.md — ~/docs')
  })
  it('shows raw dir when not under home', () => {
    expect(formatRecentLabel('/srv/a.md', '/Users/b')).toBe('a.md — /srv')
  })
  it('handles no home', () => {
    expect(formatRecentLabel('/srv/a.md', null)).toBe('a.md — /srv')
  })
})
