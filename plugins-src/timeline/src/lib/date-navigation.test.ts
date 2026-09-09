import { describe, expect, it } from 'vitest'
import { shiftTimelineDate, timelineDateTarget } from './date-navigation'

describe('timeline date navigation', () => {
  it.each([
    ['2026-12-31', 1, '2027-01-01'],
    ['2027-01-01', -1, '2026-12-31'],
    ['2024-03-01', -1, '2024-02-29'],
    ['2026-03-08', 1, '2026-03-09'],
  ] as const)('shifts %s by %i calendar days', (date, days, expected) => {
    expect(shiftTimelineDate(date, days)).toBe(expected)
  })

  it.each(['2026-02-29', '2026-13-01', '2026-9-1', '', '../2026-09-09'])('rejects invalid date %s', (date) => {
    expect(shiftTimelineDate(date, 0)).toBeNull()
    expect(timelineDateTarget('/vault/diary/2026-09-09.timeline.md', date)).toBeNull()
  })

  it('preserves flat folders and the current archive convention across years', () => {
    expect(timelineDateTarget('/vault/diary/2026-12-31.timeline.md', '2027-01-01')).toBe('2027-01-01.timeline.md')
    expect(timelineDateTarget('/vault/diary/2026/2026-12-31.timeline.md', '2027-01-01')).toBe('../2027/2027-01-01.timeline.md')
    expect(timelineDateTarget('C:\\vault\\diary\\2027\\2027-01-01.timeline.md', '2026-12-31')).toBe('../2026/2026-12-31.timeline.md')
    expect(timelineDateTarget('/vault/personal/diary/2026-09-09.timeline.md', '2026-09-10')).toBe('2026-09-10.timeline.md')
    expect(timelineDateTarget('/vault/2025/2026-09-09.timeline.md', '2026-09-10')).toBe('2026-09-10.timeline.md')
    expect(timelineDateTarget('/vault/diary/undated.md', '2026-09-10')).toBeNull()
  })
})
