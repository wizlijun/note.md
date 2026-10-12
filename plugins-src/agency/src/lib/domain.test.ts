import { describe, expect, it } from 'vitest'
import { collaborationReview, defaultObservationRange, localRecentDates, localYesterday, supportedProviders, supportsAgency, validateObservationRange } from './domain'
import { practicalBatchFixture, practicalEpisode, signal } from './fixtures.test-support'

describe('Agency collaboration review', () => {
  it('defaults a batch to the seven local calendar days ending yesterday', () => {
    expect(defaultObservationRange(new Date(2026, 0, 3, 0, 15))).toEqual({ start: '2025-12-27', end: '2026-01-02' })
  })
  it('validates inclusive ranges up to 31 days and rejects impossible, reversed or missing dates', () => {
    expect(validateObservationRange('2026-09-01', '2026-09-01')).toEqual({ days: 1, error: null })
    expect(validateObservationRange('2026-08-31', '2026-09-30')).toEqual({ days: 31, error: null })
    expect(validateObservationRange('2028-02-28', '2028-03-01')).toEqual({ days: 3, error: null })
    expect(validateObservationRange('2026-08-31', '2026-10-01').error).toContain('31 天')
    expect(validateObservationRange('2026-09-02', '2026-09-01').error).toContain('不能早于')
    expect(validateObservationRange('2026-02-29', '2026-03-01').error).toContain('有效')
    expect(validateObservationRange('', '2026-09-01').error).toContain('有效')
  })
  it('excludes reviewed episodes from every column and chooses the first remaining evidence-backed experiment', () => {
    const batch = practicalBatchFixture()
    batch.episodes.push(practicalEpisode('second'), practicalEpisode('third'))
    batch.reviews['episode-1'] = { excluded: true, note: '不属于本次观察' }
    const value = collaborationReview(batch)
    expect(value).toMatchObject({ included: 2, excluded: 1 })
    for (const column of value.columns) expect(column.items.map(item => item.episode.id)).toEqual(['second', 'third'])
    expect(value.experiment?.episode.id).toBe('second')
    batch.reviews['episode-1'].excluded = false
    expect(collaborationReview(batch).experiment?.episode.id).toBe('episode-1')
  })
  it('keeps practical findings unknown without valid evidence and never derives them from three-dimensional signals', () => {
    const batch = practicalBatchFixture()
    const item = batch.episodes[0]
    item.efficacy = signal('observed'); item.optimism = signal('observed'); item.imagination = signal('observed')
    item.practical = {
      progress: { note: '没有依据', evidence_indices: [] },
      friction: { note: '越界引用', evidence_indices: [99] },
      expansion: null,
      experiment: { action: '无依据行动', check: '无依据检验', evidence_indices: [-1] },
    }
    batch.suggestion = '旧版批次建议不能替代有来源的小实验'
    const value = collaborationReview(batch)
    expect(value.columns.every(column => column.items.length === 0)).toBe(true)
    expect(value.experiment).toBeNull()
  })
  it('preserves only legacy goal status and existing friction without inventing expansion or a modern explanation', () => {
    const batch = practicalBatchFixture()
    delete batch.rule_version
    batch.episodes[0].outcome = 'assistant_reported'
    batch.episodes[0].friction = '旧版记录：用户重复催问。'
    const value = collaborationReview(batch)
    expect(value.legacy).toBe(true)
    expect(value.columns[0].items[0]).toMatchObject({ legacy: true, episode: { outcome: 'assistant_reported' } })
    expect(value.columns[1].items[0].note).toBe('旧版记录：用户重复催问。')
    expect(value.columns[2].items).toEqual([])
    expect(value.experiment).toBeNull()
  })
  it('uses local calendar yesterday across month and year boundaries', () => {
    expect(localYesterday(new Date(2026, 0, 1, 0, 15))).toBe('2025-12-31')
    expect(localYesterday(new Date(2026, 8, 1, 23, 45))).toBe('2026-08-31')
  })
  it('lists seven local dates including today in descending order across a year boundary', () => {
    expect(localRecentDates(new Date(2026, 0, 2, 0, 15))).toEqual([
      '2026-01-02', '2026-01-01', '2025-12-31', '2025-12-30', '2025-12-29', '2025-12-28', '2025-12-27',
    ])
  })
  it('does not expose unknown harness IDs as supported providers', () => {
    expect(supportedProviders([{ id: 'notemd.codex-agent', name: 'Codex' }, { id: 'other-agent', name: 'Other' }])).toHaveLength(1)
  })
  it('requires all Agency capabilities and a ready harness before generation', () => {
    const ready = { id: 'notemd.codex-agent', name: 'Codex', harness: { ok: true, capabilities: { terminal_result: true, input_only_isolation: true, tasks: ['agency-observe-v1'] } } }
    expect(supportsAgency(ready)).toBe(true)
    expect(supportsAgency({ ...ready, harness: { ok: true } })).toBe(false)
    expect(supportsAgency({ ...ready, harness: { ...ready.harness, ok: false } })).toBe(false)
    for (const capabilities of [
      { ...ready.harness.capabilities, terminal_result: false },
      { ...ready.harness.capabilities, input_only_isolation: false },
      { ...ready.harness.capabilities, tasks: ['memory-inference'] },
    ]) expect(supportsAgency({ ...ready, harness: { ok: true, capabilities } })).toBe(false)
  })
})
