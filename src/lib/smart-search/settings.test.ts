import { describe, expect, it } from 'vitest'
import { DEFAULT_SMART_LOOKUP_SETTINGS, normalizeSmartLookupSettings } from './settings'

describe('smart lookup settings', () => {
  it('uses the low-cost defaults', () => {
    expect(normalizeSmartLookupSettings(undefined)).toEqual(DEFAULT_SMART_LOOKUP_SETTINGS)
    expect(DEFAULT_SMART_LOOKUP_SETTINGS.results.autoDeepOnZero).toBe(false)
  })

  it('keeps valid fields while independently resetting damaged fields', () => {
    const normalized = normalizeSmartLookupSettings({
      results: { limit: 20, groupBy: 'date', autoDeepOnZero: true, deepTimeoutMs: 500 },
    })
    expect(normalized.results).toEqual({
      limit: 20, groupBy: 'date', autoDeepOnZero: true, deepTimeoutMs: 4_000,
    })
  })

  it('accepts every inclusive numeric boundary', () => {
    expect(normalizeSmartLookupSettings({ results: { deepTimeoutMs: 1_000 } }).results.deepTimeoutMs).toBe(1_000)
    expect(normalizeSmartLookupSettings({ results: { deepTimeoutMs: 5_000 } }).results.deepTimeoutMs).toBe(5_000)
  })

  it('has no planner settings and drops legacy planner values', () => {
    const normalized = normalizeSmartLookupSettings({
      planner: { enabled: true, provider: 'notemd.codex-agent', timeoutMs: 30_000 },
    })
    expect('planner' in normalized).toBe(false)
    expect('planner' in DEFAULT_SMART_LOOKUP_SETTINGS).toBe(false)
  })

  it('ignores stored summary and handoff groups', () => {
    const normalized = normalizeSmartLookupSettings({
      summary: { enabled: false },
      handoff: { defaultProvider: 'x' },
    })
    expect('summary' in normalized).toBe(false)
    expect('handoff' in normalized).toBe(false)
  })
})
