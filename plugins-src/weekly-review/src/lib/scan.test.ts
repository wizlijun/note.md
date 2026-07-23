import { describe, it, expect } from 'vitest'
import {
  WEEKLY_DIR,
  parseReviewName,
  buildIndex,
  DIARY_DIR,
  DAILYNOTE_DIR,
  parseDiaryName,
  parseDailyNoteName,
  buildDayIndex,
} from './scan'

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

describe('parseDiaryName', () => {
  it('parses a diary filename to a date key', () => {
    expect(parseDiaryName('2026-06-16-diary-memory-product-travel.md')).toBe('2026-06-16')
  })
  it('parses a diary with no slug', () => {
    expect(parseDiaryName('2026-07-01-diary.md')).toBe('2026-07-01')
  })
  it('rejects non-diary names', () => {
    expect(parseDiaryName('2026-06-16-weekly.md')).toBeNull()
    expect(parseDiaryName('2026-W30-weekly-review.md')).toBeNull()
    expect(parseDiaryName('notes.md')).toBeNull()
  })
})

describe('parseDailyNoteName', () => {
  it('parses a dailynote filename to a date key', () => {
    expect(parseDailyNoteName('2026-07-20.note.md')).toBe('2026-07-20')
  })
  it('rejects non-matching', () => {
    expect(parseDailyNoteName('2026-07-20.md')).toBeNull()
    expect(parseDailyNoteName('2026-07-20-diary.md')).toBeNull()
  })
})

describe('buildDayIndex', () => {
  it('maps date→path with a dir prefix, first-wins on duplicate dates, skips dirs/junk', () => {
    const idx = buildDayIndex(
      [
        { name: '2026-06-16-diary-a.md', is_dir: false },
        { name: '2026-06-16-diary-b.md', is_dir: false }, // dup date → first wins
        { name: '2026-06-17-diary-c.md', is_dir: false },
        { name: 'junk.md', is_dir: false },
        { name: 'sub', is_dir: true },
      ],
      'diary',
      parseDiaryName,
    )
    expect(idx.get('2026-06-16')).toBe('diary/2026-06-16-diary-a.md')
    expect(idx.get('2026-06-17')).toBe('diary/2026-06-17-diary-c.md')
    expect(idx.size).toBe(2)
  })
  it('works for nested dailynote prefix', () => {
    const idx = buildDayIndex(
      [{ name: '2026-07-20.note.md', is_dir: false }],
      'dailynote/2026',
      parseDailyNoteName,
    )
    expect(idx.get('2026-07-20')).toBe('dailynote/2026/2026-07-20.note.md')
  })
})
