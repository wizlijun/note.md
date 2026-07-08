import { describe, it, expect } from 'vitest'
import { mergeFiles, aggregate, renderOwnerDigest, resolvePreset } from './insights-report-core.mjs'

const files = [
  { name: '2026-07-08.DEV1.json', json: { deviceId: 'DEV1', deviceName: 'Mac', day: '2026-07-08', docs: { 'rel:a.md': { read_ms: 120000, edit_ms: 60000, edit_sessions: 2, mark_ops: 3, net_chars: 40, open_count: 1, first_seen_at: 0, last_active_at: 0 } } } },
  { name: '2026-07-08.DEV2.json', json: { deviceId: 'DEV2', deviceName: 'iPhone', day: '2026-07-08', docs: { 'rel:a.md': { read_ms: 30000, edit_ms: 0, edit_sessions: 0, mark_ops: 0, net_chars: 0, open_count: 1, first_seen_at: 0, last_active_at: 0 } } } },
  { name: '2026-07-07.DEV1.json', json: { deviceId: 'DEV1', deviceName: 'Mac', day: '2026-07-07', docs: { 'rel:a.md': { read_ms: 999, edit_ms: 0, edit_sessions: 0, mark_ops: 0, net_chars: 0, open_count: 1, first_seen_at: 0, last_active_at: 0 } } } },
]

describe('mergeFiles + aggregate', () => {
  it('sums a doc across devices for the range only', () => {
    const agg = aggregate(mergeFiles(files), '2026-07-08', '2026-07-08')
    expect(agg['rel:a.md'].read_ms).toBe(150000)
  })
})

describe('renderOwnerDigest', () => {
  it('produces a heading, the doc, and a total', () => {
    const agg = aggregate(mergeFiles(files), '2026-07-08', '2026-07-08')
    const md = renderOwnerDigest(agg, '2026-07-08', '2026-07-08')
    expect(md).toContain('# 阅读数据')
    expect(md).toContain('a.md')
    expect(md).toContain('合计')
    expect(md).toContain('2m 30s')
  })
})

describe('resolvePreset', () => {
  it('yesterday resolves to the prior day', () => {
    const now = Date.UTC(2026, 6, 8, 7, 0)
    expect(resolvePreset('yesterday', now, 480)).toEqual({ from: '2026-07-07', to: '2026-07-07' })
  })
})
