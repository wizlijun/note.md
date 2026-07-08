import { describe, it, expect } from 'vitest'
import { mergeDeviceAnalytics, aggregateRange } from './merge'
import { emptyCounters, type DeviceAnalytics } from './model'

function dev(id: string, docs: DeviceAnalytics['docs']): DeviceAnalytics {
  return { deviceId: id, deviceName: id, docs }
}

describe('mergeDeviceAnalytics', () => {
  it('sums the same doc/day across devices', () => {
    const a = dev('A', { 'rel:a.md': { '2026-07-08': { ...emptyCounters(10), read_ms: 100 } } })
    const b = dev('B', { 'rel:a.md': { '2026-07-08': { ...emptyCounters(20), read_ms: 50 } } })
    const merged = mergeDeviceAnalytics([a, b])
    expect(merged['rel:a.md']['2026-07-08'].read_ms).toBe(150)
  })

  it('keeps distinct days and distinct docs side by side', () => {
    const a = dev('A', {
      'rel:a.md': { '2026-07-08': { ...emptyCounters(0), read_ms: 100 } },
      'rel:b.md': { '2026-07-08': { ...emptyCounters(0), read_ms: 5 } },
    })
    const b = dev('B', { 'rel:a.md': { '2026-07-07': { ...emptyCounters(0), read_ms: 200 } } })
    const merged = mergeDeviceAnalytics([a, b])
    expect(merged['rel:a.md']['2026-07-08'].read_ms).toBe(100)
    expect(merged['rel:a.md']['2026-07-07'].read_ms).toBe(200)
    expect(merged['rel:b.md']['2026-07-08'].read_ms).toBe(5)
  })
})

describe('aggregateRange', () => {
  it('sums counters per doc across the inclusive day range', () => {
    const a = dev('A', { 'rel:a.md': {
      '2026-07-06': { ...emptyCounters(0), read_ms: 10 },
      '2026-07-08': { ...emptyCounters(0), read_ms: 20 },
      '2026-07-10': { ...emptyCounters(0), read_ms: 40 }, // outside range
    } })
    const out = aggregateRange(mergeDeviceAnalytics([a]), '2026-07-06', '2026-07-08')
    expect(out['rel:a.md'].read_ms).toBe(30)
  })

  it('omits docs with no activity in the range', () => {
    const a = dev('A', { 'rel:a.md': { '2026-07-10': { ...emptyCounters(0), read_ms: 40 } } })
    const out = aggregateRange(mergeDeviceAnalytics([a]), '2026-07-06', '2026-07-08')
    expect(out['rel:a.md']).toBeUndefined()
  })
})
