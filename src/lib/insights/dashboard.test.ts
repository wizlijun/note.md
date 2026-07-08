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
    listSharedDocKeys: () => ['rel:a.md'],
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

  it('omits docs with no owner activity AND no audience in the range', async () => {
    // a.md's audience fetcher returns data regardless of range in this fixture,
    // so restrict listSharedDocKeys to nothing to isolate the owner-empty case.
    const rows = await assembleRows(deps({ listSharedDocKeys: () => [] }), '2026-07-01', '2026-07-02')
    expect(rows).toHaveLength(0)
  })

  it('surfaces a shared doc read online even with no owner activity in range', async () => {
    // 'rel:c.md' has NO owner counters, but is shared and has audience reads.
    const rows = await assembleRows(deps({
      resolveShare: (docKey) => docKey === 'rel:c.md'
        ? { path: '/v/c.md', label: 'c.md', slug: '2026-07-08-c-x', editToken: 'tokc' }
        : { path: null, label: docKey, slug: null, editToken: null },
      fetchAudience: async (slug) => slug === '2026-07-08-c-x'
        ? { total_ms: 45_000, unique_readers: 2, days: {} } : null,
      listSharedDocKeys: () => ['rel:c.md'],
    }), '2026-07-01', '2026-07-02')  // range with no owner activity

    expect(rows).toHaveLength(1)
    expect(rows[0].docKey).toBe('rel:c.md')
    expect(rows[0].read_ms).toBe(0)          // owner never read it
    expect(rows[0].aud_read_ms).toBe(45_000) // but the audience did
    expect(rows[0].unique_readers).toBe(2)
    expect(rows[0].shared).toBe(true)
  })

  it('does not add an audience-only row when the share has no reads', async () => {
    const rows = await assembleRows(deps({
      readDevices: async () => [{ deviceId: 'D1', deviceName: 'Mac', docs: {} }],
      resolveShare: () => ({ path: '/v/c.md', label: 'c.md', slug: '2026-07-08-c-x', editToken: 'tokc' }),
      fetchAudience: async () => ({ total_ms: 0, unique_readers: 0, days: {} }),
      listSharedDocKeys: () => ['rel:c.md'],
    }), '2026-07-08', '2026-07-08')
    expect(rows).toHaveLength(0)
  })
})
