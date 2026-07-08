import { describe, it, expect } from 'vitest'
import { assembleRows, type AssembleDeps } from './dashboard.svelte'
import { emptyCounters, type DeviceAnalytics } from './model'
import type { AudienceStats } from './audience'
import { DEFAULT_WEIGHTS } from './value'

/** Build a batch fetcher from a plain slug→stats map. */
function batch(map: Record<string, AudienceStats>): AssembleDeps['fetchAudienceBatch'] {
  return async (slugs) => Object.fromEntries(slugs.filter((s) => s in map).map((s) => [s, map[s]]))
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
    fetchAudienceBatch: batch({ '2026-07-08-a-x': { total_ms: 90_000, unique_readers: 4, days: {} } }),
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

  it('fetches all slugs in a SINGLE batch call', async () => {
    let calls = 0
    await assembleRows(deps({
      fetchAudienceBatch: async (slugs) => { calls++; expect(slugs).toEqual(['2026-07-08-a-x']); return {} },
    }), '2026-07-08', '2026-07-08')
    expect(calls).toBe(1)
  })

  it('omits docs with no owner activity AND no audience in the range', async () => {
    const rows = await assembleRows(deps({ listSharedDocKeys: () => [] }), '2026-07-01', '2026-07-02')
    expect(rows).toHaveLength(0)
  })

  it('surfaces a shared doc read online even with no owner activity in range', async () => {
    const rows = await assembleRows(deps({
      resolveShare: (docKey) => docKey === 'rel:c.md'
        ? { path: '/v/c.md', label: 'c.md', slug: '2026-07-08-c-x' }
        : { path: null, label: docKey, slug: null },
      fetchAudienceBatch: batch({ '2026-07-08-c-x': { total_ms: 45_000, unique_readers: 2, days: {} } }),
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
      fetchAudienceBatch: batch({ '2026-07-08-c-x': { total_ms: 0, unique_readers: 0, days: {} } }),
      listSharedDocKeys: () => ['rel:c.md'],
    }), '2026-07-08', '2026-07-08')
    expect(rows).toHaveLength(0)
  })
})
