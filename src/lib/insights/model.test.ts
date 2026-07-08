import { describe, it, expect } from 'vitest'
import { dayKey, docKeyFor, emptyCounters, sumCounters, type DayCounters } from './model'

describe('dayKey', () => {
  it('formats a local calendar day as YYYY-MM-DD using the given tz offset', () => {
    const ms = Date.UTC(2026, 6, 8, 7, 30)
    expect(dayKey(ms, 8 * 60)).toBe('2026-07-08')
  })

  it('rolls to the next local day when the tz offset pushes past midnight', () => {
    const ms = Date.UTC(2026, 6, 8, 17, 0)
    expect(dayKey(ms, 8 * 60)).toBe('2026-07-09')
  })

  it('rolls to the previous local day for negative offsets', () => {
    const ms = Date.UTC(2026, 6, 8, 2, 0)
    expect(dayKey(ms, -5 * 60)).toBe('2026-07-07')
  })
})

describe('docKeyFor', () => {
  it('returns a vault-relative key for files under the vault', () => {
    expect(docKeyFor('/Users/x/vault/notes/a.md', '/Users/x/vault')).toBe('rel:notes/a.md')
  })

  it('handles a trailing slash on the vault root', () => {
    expect(docKeyFor('/Users/x/vault/a.md', '/Users/x/vault/')).toBe('rel:a.md')
  })

  it('returns an absolute key for files outside the vault (or when no vault)', () => {
    expect(docKeyFor('/tmp/a.md', '/Users/x/vault')).toBe('abs:/tmp/a.md')
    expect(docKeyFor('/tmp/a.md', null)).toBe('abs:/tmp/a.md')
  })
})

describe('sumCounters', () => {
  it('adds numeric fields, keeps min first_seen_at and max last_active_at', () => {
    const a: DayCounters = { ...emptyCounters(100), read_ms: 10, mark_ops: 1, first_seen_at: 100, last_active_at: 200 }
    const b: DayCounters = { ...emptyCounters(50), read_ms: 5, mark_ops: 2, first_seen_at: 50, last_active_at: 300 }
    const s = sumCounters(a, b)
    expect(s.read_ms).toBe(15)
    expect(s.mark_ops).toBe(3)
    expect(s.first_seen_at).toBe(50)
    expect(s.last_active_at).toBe(300)
  })
})
