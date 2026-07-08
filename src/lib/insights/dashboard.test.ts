import { describe, it, expect } from 'vitest'
import { assembleRows, type AssembleDeps } from './dashboard.svelte'
import { emptyCounters, type DeviceAnalytics } from './model'
import { DEFAULT_WEIGHTS } from './value'

function deps(over: Partial<AssembleDeps> = {}): AssembleDeps {
  return {
    readDevices: async (): Promise<DeviceAnalytics[]> => [{
      deviceId: 'D1', deviceName: 'Mac',
      docs: {
        'rel:a.md': { '2026-07-08': { ...emptyCounters(0), read_ms: 120_000, edit_ms: 60_000, mark_ops: 3, edit_sessions: 2, net_chars: 40 } },
        'abs:/tmp/b.md': { '2026-07-08': { ...emptyCounters(0), read_ms: 30_000 } },
      },
    }],
    resolveShare: (docKey) => docKey === 'rel:a.md'
      ? { path: '/v/a.md', label: 'a.md', slug: '2026-07-08-a-x', editToken: 'tok' }
      : { path: '/tmp/b.md', label: 'b.md', slug: null, editToken: null },
    fetchAudience: async (slug) => slug === '2026-07-08-a-x'
      ? { total_ms: 90_000, unique_readers: 4, days: {} } : null,
    baseUrl: 'https://w/',
    weights: DEFAULT_WEIGHTS,
    ...over,
  }
}

describe('assembleRows', () => {
  it('merges owner data, joins audience for shared docs, sorts by value desc', async () => {
    const rows = await assembleRows(deps(), '2026-07-08', '2026-07-08')
    expect(rows.map((r) => r.docKey)).toEqual(['rel:a.md', 'abs:/tmp/b.md'])
    const a = rows[0]
    expect(a.read_ms).toBe(120_000)
    expect(a.aud_read_ms).toBe(90_000)
    expect(a.unique_readers).toBe(4)
    expect(a.shared).toBe(true)
    expect(a.value).toBeGreaterThan(rows[1].value)
    expect(rows[1].aud_read_ms).toBe(0)
    expect(rows[1].shared).toBe(false)
  })

  it('omits docs with no activity in the range', async () => {
    const rows = await assembleRows(deps(), '2026-07-01', '2026-07-02')
    expect(rows).toHaveLength(0)
  })
})
