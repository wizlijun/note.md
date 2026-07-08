import { describe, it, expect } from 'vitest'
import { renderDailyReport, reportFilename } from './report'
import type { InsightRow } from './dashboard.svelte'

function row(over: Partial<InsightRow>): InsightRow {
  return {
    docKey: 'rel:a.md', label: 'a.md', path: '/v/a.md',
    read_ms: 0, edit_ms: 0, edit_sessions: 0, mark_ops: 0, net_chars: 0,
    aud_read_ms: 0, unique_readers: 0, shared: false, value: 0, ...over,
  }
}

describe('reportFilename', () => {
  it('single day → daily-stat', () => {
    expect(reportFilename('2026-07-08', '2026-07-08')).toBe('stat/2026-07-08-daily-stat.md')
  })
  it('range → from_to-stat', () => {
    expect(reportFilename('2026-07-01', '2026-07-07')).toBe('stat/2026-07-01_2026-07-07-stat.md')
  })
})

describe('renderDailyReport', () => {
  const rows = [
    row({ label: 'a.md', read_ms: 120_000, edit_ms: 60_000, edit_sessions: 2, mark_ops: 3, aud_read_ms: 90_000, unique_readers: 4, shared: true, value: 8.2 }),
    row({ docKey: 'abs:/tmp/b.md', label: 'b.md', path: '/tmp/b.md', read_ms: 30_000, value: 1.1 }),
  ]
  it('has a heading with the range and a totals row', () => {
    const { markdown } = renderDailyReport(rows, '2026-07-08', '2026-07-08')
    expect(markdown).toContain('# 阅读数据')
    expect(markdown).toContain('2026-07-08')
    expect(markdown).toContain('| a.md')
    expect(markdown).toContain('| b.md |')
    expect(markdown).toContain('合计')
  })
  it('summary reports doc count and total engagement time', () => {
    const { markdown } = renderDailyReport(rows, '2026-07-08', '2026-07-08')
    expect(markdown).toContain('2 篇')
    expect(markdown).toMatch(/3m ?30s/)
  })
  it('mentions audience when any doc was read by others', () => {
    const { markdown } = renderDailyReport(rows, '2026-07-08', '2026-07-08')
    expect(markdown).toContain('读者')
  })
  it('returns the matching filename', () => {
    const { filename } = renderDailyReport(rows, '2026-07-08', '2026-07-08')
    expect(filename).toBe('stat/2026-07-08-daily-stat.md')
  })
  it('renders an empty-state note when no rows', () => {
    const { markdown } = renderDailyReport([], '2026-07-08', '2026-07-08')
    expect(markdown).toContain('没有')
  })
})
