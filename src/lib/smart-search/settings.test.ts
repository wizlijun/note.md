import { describe, expect, it } from 'vitest'
import { DEFAULT_SMART_LOOKUP_SETTINGS, normalizeSmartLookupSettings } from './settings'

describe('smart lookup settings', () => {
  it('uses the low-cost defaults', () => {
    expect(normalizeSmartLookupSettings(undefined)).toEqual(DEFAULT_SMART_LOOKUP_SETTINGS)
    expect(DEFAULT_SMART_LOOKUP_SETTINGS.results.autoDeepOnZero).toBe(false)
    expect(DEFAULT_SMART_LOOKUP_SETTINGS.summary.modelByProvider).toEqual({})
  })

  it('keeps valid fields while independently resetting damaged fields', () => {
    const normalized = normalizeSmartLookupSettings({
      results: { limit: 20, groupBy: 'date', autoDeepOnZero: true, deepTimeoutMs: 500 },
      summary: {
        provider: 'auto', sourceLimit: 6, charLimit: 6_000, style: 'sentence', timeoutMs: 30_000,
        modelByProvider: {
          'notemd.codex-agent': 'model:gpt-fast',
          bad: 'profile:cheap',
          control: 'model:bad\0model',
          oversized: `model:${'x'.repeat(260)}`,
        },
      },
      handoff: { defaultProvider: '../bad\0', includeSelectedRefs: false },
    })

    expect(normalized.results).toEqual({
      limit: 20, groupBy: 'date', autoDeepOnZero: true, deepTimeoutMs: 4_000,
    })
    expect(normalized.summary).toMatchObject({
      provider: 'auto', sourceLimit: 6, charLimit: 6_000, style: 'sentence', timeoutMs: 30_000,
      modelByProvider: { 'notemd.codex-agent': 'model:gpt-fast' },
    })
    expect(normalized.handoff).toEqual({ defaultProvider: 'ask', includeSelectedRefs: false })
  })

  it('accepts every inclusive numeric boundary', () => {
    const min = normalizeSmartLookupSettings({
      results: { deepTimeoutMs: 1_000 },
      summary: { sourceLimit: 1, charLimit: 1_000, timeoutMs: 5_000 },
    })
    const max = normalizeSmartLookupSettings({
      results: { deepTimeoutMs: 5_000 },
      summary: { sourceLimit: 6, charLimit: 6_000, timeoutMs: 30_000 },
    })
    expect(min.summary.charLimit).toBe(1_000)
    expect(max.summary.sourceLimit).toBe(6)
  })

  it('has no planner settings and drops legacy planner values', () => {
    const normalized = normalizeSmartLookupSettings({
      planner: { enabled: true, provider: 'notemd.codex-agent', timeoutMs: 30_000 },
      summary: { provider: 'same_as_planner' },
    })
    expect('planner' in normalized).toBe(false)
    expect('planner' in DEFAULT_SMART_LOOKUP_SETTINGS).toBe(false)
    expect(normalized.summary.provider).toBe('auto')
  })
})
