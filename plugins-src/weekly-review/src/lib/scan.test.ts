import { describe, it, expect } from 'vitest'
import { WEEKLY_DIR, parseReviewName, buildIndex } from './scan'

describe('parseReviewName', () => {
  it('parses a padded ISO-week filename', () => {
    expect(parseReviewName('2026-W30-weekly-review.md')).toEqual({ year: 2026, week: 30 })
  })
  it('tolerates an unpadded week number', () => {
    expect(parseReviewName('2026-W3-weekly-review.md')).toEqual({ year: 2026, week: 3 })
  })
  it('rejects non-matching names', () => {
    expect(parseReviewName('2026-07-20-diary.md')).toBeNull()
    expect(parseReviewName('notes.md')).toBeNull()
    expect(parseReviewName('2026-W30-weekly-review.txt')).toBeNull()
  })
})

describe('buildIndex', () => {
  it('maps year→week→relative path and lists only years with data', () => {
    const idx = buildIndex([
      { name: '2026-W30-weekly-review.md', is_dir: false },
      { name: '2026-W3-weekly-review.md', is_dir: false },
      { name: '2025-W52-weekly-review.md', is_dir: false },
      { name: 'random.md', is_dir: false },
      { name: 'subdir', is_dir: true },
    ])
    expect(idx.years).toEqual([2025, 2026])
    expect(idx.byYear.get(2026)!.get(30)).toBe('weekly-review/2026-W30-weekly-review.md')
    expect(idx.byYear.get(2026)!.get(3)).toBe('weekly-review/2026-W3-weekly-review.md')
    expect(idx.byYear.get(2025)!.get(52)).toBe('weekly-review/2025-W52-weekly-review.md')
    expect(idx.byYear.has(9999)).toBe(false)
  })
})
