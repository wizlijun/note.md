import { describe, it, expect } from 'vitest'
import { assembleRows, type AssembleDeps } from './dashboard.svelte'
import { emptyCounters, type DeviceAnalytics } from './model'
import type { AudienceStats } from './audience'
import { DEFAULT_WEIGHTS } from './value'

/** Build an all-audience fetcher from a plain slug→stats map. */
function all(map: Record<string, AudienceStats>): AssembleDeps['fetchAudienceAll'] {
  return async () => map
}

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
      ? { path: '/v/a.md', label: 'a.md', slug: '2026-07-08-a-x' }
      : { path: '/tmp/b.md', label: 'b.md', slug: null },
    fetchAudienceAll: all({ '2026-07-08-a-x': { total_ms: 90_000, unique_readers: 4, days: {} } }),
    listSharedDocKeys: () => ['rel:a.md'],
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

  it('fetches all audience data in a SINGLE request (no slug list)', async () => {
    let calls = 0
    await assembleRows(deps({
      fetchAudienceAll: async () => { calls++; return {} },
    }), '2026-07-08', '2026-07-08')
    expect(calls).toBe(1)
  })

  it('omits docs with no owner activity AND no audience in the range', async () => {
    // The server date-filters, so an out-of-range query yields no audience.
    const rows = await assembleRows(deps({ fetchAudienceAll: all({}) }), '2026-07-01', '2026-07-02')
    expect(rows).toHaveLength(0)
  })

  it('surfaces a shared doc read online even with no owner activity in range', async () => {
    const rows = await assembleRows(deps({
      resolveShare: (docKey) => docKey === 'rel:c.md'
        ? { path: '/v/c.md', label: 'c.md', slug: '2026-07-08-c-x' }
        : { path: null, label: docKey, slug: null },
      fetchAudienceAll: all({ '2026-07-08-c-x': { total_ms: 45_000, unique_readers: 2, days: {} } }),
      listSharedDocKeys: () => ['rel:c.md'],
    }), '2026-07-01', '2026-07-02')

    expect(rows).toHaveLength(1)
    expect(rows[0].docKey).toBe('rel:c.md')
    expect(rows[0].read_ms).toBe(0)
    expect(rows[0].aud_read_ms).toBe(45_000)
    expect(rows[0].unique_readers).toBe(2)
    expect(rows[0].shared).toBe(true)
  })

  it('does not add an audience-only row when the share has no reads', async () => {
    const rows = await assembleRows(deps({
      readDevices: async () => [{ deviceId: 'D1', deviceName: 'Mac', docs: {} }],
      resolveShare: () => ({ path: '/v/c.md', label: 'c.md', slug: '2026-07-08-c-x' }),
      fetchAudienceAll: all({ '2026-07-08-c-x': { total_ms: 0, unique_readers: 0, days: {} } }),
      listSharedDocKeys: () => ['rel:c.md'],
    }), '2026-07-08', '2026-07-08')
    expect(rows).toHaveLength(0)
  })

  it('surfaces an audience-only slug with NO local record under the slug itself', async () => {
    const rows = await assembleRows(deps({
      readDevices: async () => [{ deviceId: 'D1', deviceName: 'Mac', docs: {} }],
      listSharedDocKeys: () => [],
      fetchAudienceAll: all({ '2026-07-08-orphan-z': { total_ms: 12_000, unique_readers: 1, days: {} } }),
    }), '2026-07-08', '2026-07-08')
    expect(rows).toHaveLength(1)
    expect(rows[0].docKey).toBe('2026-07-08-orphan-z')
    expect(rows[0].label).toBe('2026-07-08-orphan-z')
    expect(rows[0].aud_read_ms).toBe(12_000)
  })
})
