import { describe, it, expect } from 'vitest'
import { valueScore, DEFAULT_WEIGHTS, presetRange, type ValueInputs } from './value'

const base: ValueInputs = { read_ms: 0, edit_ms: 0, edit_sessions: 0, mark_ops: 0, aud_read_ms: 0, unique_readers: 0 }

describe('valueScore', () => {
  it('is 0 for all-zero inputs', () => {
    expect(valueScore(base, DEFAULT_WEIGHTS)).toBe(0)
  })
  it('increases with reading time (log-damped, monotonic)', () => {
    const a = valueScore({ ...base, read_ms: 60_000 }, DEFAULT_WEIGHTS)
    const b = valueScore({ ...base, read_ms: 600_000 }, DEFAULT_WEIGHTS)
    expect(b).toBeGreaterThan(a)
    expect(a).toBeGreaterThan(0)
  })
  it('weights owner reading and audience reading equally (same per-minute)', () => {
    const owner = valueScore({ ...base, read_ms: 600_000 }, DEFAULT_WEIGHTS)
    const audience = valueScore({ ...base, aud_read_ms: 600_000 }, DEFAULT_WEIGHTS)
    expect(audience).toBe(owner)
  })
  it('treats unique-reader count as a minor signal, below equal reading time', () => {
    const readTime = valueScore({ ...base, read_ms: 600_000 }, DEFAULT_WEIGHTS)
    const readers = valueScore({ ...base, unique_readers: 10 }, DEFAULT_WEIGHTS)
    expect(readers).toBeGreaterThan(0)
    expect(readers).toBeLessThan(readTime)
  })
  it('a rich doc still outranks a read-only one', () => {
    const readOnly = valueScore({ ...base, read_ms: 600_000 }, DEFAULT_WEIGHTS)
    const rich = valueScore({ ...base, read_ms: 600_000, edit_ms: 300_000, mark_ops: 5, unique_readers: 10 }, DEFAULT_WEIGHTS)
    expect(rich).toBeGreaterThan(readOnly)
  })
})

describe('presetRange', () => {
  const now = Date.UTC(2026, 6, 8, 7, 0)
  const tz = 480
  it('today → single day', () => {
    expect(presetRange('today', now, tz)).toEqual({ from: '2026-07-08', to: '2026-07-08' })
  })
  it('yesterday → single prior day', () => {
    expect(presetRange('yesterday', now, tz)).toEqual({ from: '2026-07-07', to: '2026-07-07' })
  })
  it('7d → inclusive last 7 days ending today', () => {
    expect(presetRange('7d', now, tz)).toEqual({ from: '2026-07-02', to: '2026-07-08' })
  })
  it('30d → inclusive last 30 days', () => {
    expect(presetRange('30d', now, tz)).toEqual({ from: '2026-06-09', to: '2026-07-08' })
  })
  it('month → first of month to today', () => {
    expect(presetRange('month', now, tz)).toEqual({ from: '2026-07-01', to: '2026-07-08' })
  })
})
