import { describe, expect, it } from 'vitest'
import { localDateTimeValue, resolvePauseTime, tomorrowAtNine } from './reminder-time'

const now = new Date('2026-01-01T00:00:00Z')

describe('reminder local time', () => {
  it('converts an explicit local minute to a UTC instant and back', () => {
    const result = resolvePauseTime('2026-10-27T09:00', now, 'Asia/Taipei')
    expect(result).toEqual({ ok: true, iso: '2026-10-27T01:00:00Z' })
    expect(localDateTimeValue('2026-10-27T01:00:00Z', 'Asia/Taipei')).toBe('2026-10-27T09:00')
  })

  it.each(['', '2026-02-30T09:00', '2026-13-01T09:00', '2026-01-01T24:30', '2026-01-01T09:70'])('rejects malformed calendar input %s', (value) => {
    expect(resolvePauseTime(value, now, 'Asia/Taipei')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('requires a strictly future instant', () => {
    expect(resolvePauseTime('2026-01-01T08:00', now, 'Asia/Taipei')).toEqual({ ok: false, reason: 'past' })
    expect(resolvePauseTime('2025-12-31T23:00', now, 'Asia/Taipei')).toEqual({ ok: false, reason: 'past' })
  })

  it.each([
    ['America/New_York', '2026-03-08T02:30', 'nonexistent'],
    ['America/New_York', '2026-11-01T01:30', 'ambiguous'],
    ['Australia/Lord_Howe', '2026-04-05T01:45', 'ambiguous'],
    ['Australia/Lord_Howe', '2026-10-04T02:15', 'nonexistent'],
  ] as const)('rejects %s wall time %s as %s', (zone, value, reason) => {
    expect(resolvePauseTime(value, now, zone)).toEqual({ ok: false, reason })
  })

  it('computes tomorrow at nine across a calendar boundary and a DST change', () => {
    expect(tomorrowAtNine(new Date('2026-12-31T15:30:00Z'), 'Asia/Taipei')).toEqual({ ok: true, iso: '2027-01-01T01:00:00Z' })
    expect(tomorrowAtNine(new Date('2026-03-07T17:00:00Z'), 'America/New_York')).toEqual({ ok: true, iso: '2026-03-08T13:00:00Z' })
  })
})
