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
      ? { path: '/v/a.md', label: 'a.md', slug: '2026-07-08-a-x', url: 'https://w/2026-07-08-a-x' }
      : { path: '/tmp/b.md', label: 'b.md', slug: null, url: null },
    // Default audience carries a vault-relative `src`, so it joins the owner's md.
    fetchAudienceAll: all({ '2026-07-08-a-x': { total_ms: 90_000, unique_readers: 4, days: {}, src: 'a.md' } }),
    resolveSrc: (src) => src.startsWith('/')
      ? { docKey: `abs:${src}`, path: src, label: src.split('/').pop()! }
      : { docKey: `rel:${src}`, path: `/v/${src}`, label: src.split('/').pop()! },
    resolveSlugUrl: (slug) => `https://w/${slug}`,
    weights: DEFAULT_WEIGHTS,
    ...over,
  }
}

describe('assembleRows', () => {
  it('merges owner data, joins audience via src, and excludes non-vault (abs:) docs', async () => {
    const rows = await assembleRows(deps(), '2026-07-08', '2026-07-08')
    // abs:/tmp/b.md lives outside the vault → dropped; the audience slug carries
    // src 'a.md' so it folds into the owner's rel:a.md row.
    expect(rows.map((r) => r.docKey)).toEqual(['rel:a.md'])
    const a = rows[0]
    expect(a.read_ms).toBe(120_000)
    expect(a.aud_read_ms).toBe(90_000)
    expect(a.unique_readers).toBe(4)
    expect(a.shared).toBe(true)
    expect(a.urls).toEqual(['https://w/2026-07-08-a-x'])
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

  it('surfaces a shared doc read online (via src) even with no owner activity', async () => {
    const rows = await assembleRows(deps({
      readDevices: async () => [{ deviceId: 'D1', deviceName: 'Mac', docs: {} }],
      fetchAudienceAll: all({ '2026-07-08-c-x': { total_ms: 45_000, unique_readers: 2, days: {}, src: 'c.md' } }),
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
      fetchAudienceAll: all({ '2026-07-08-c-x': { total_ms: 0, unique_readers: 0, days: {}, src: 'c.md' } }),
    }), '2026-07-08', '2026-07-08')
    expect(rows).toHaveLength(0)
  })

  it('surfaces a slug-only share (no src, no local record) as its own row', async () => {
    // The site reported reads for this slug; even though nothing maps it to a
    // vault md, it still shows — identically on every terminal.
    const rows = await assembleRows(deps({
      readDevices: async () => [{ deviceId: 'D1', deviceName: 'Mac', docs: {} }],
      fetchAudienceAll: all({ '2026-07-08-orphan-z': { total_ms: 12_000, unique_readers: 1, days: {} } }),
    }), '2026-07-08', '2026-07-08')
    expect(rows).toHaveLength(1)
    expect(rows[0].docKey).toBe('2026-07-08-orphan-z')
    expect(rows[0].label).toBe('2026-07-08-orphan-z')
    expect(rows[0].path).toBeNull()
    expect(rows[0].aud_read_ms).toBe(12_000)
    expect(rows[0].unique_readers).toBe(1)
    expect(rows[0].shared).toBe(true)
    expect(rows[0].urls).toEqual(['https://w/2026-07-08-orphan-z'])
  })

  it('does not depend on this device\'s local share records (same result with or without them)', async () => {
    // A no-src audience slug must surface the same way whether or not resolveShare
    // knows it — this is the fix for "different terminals, different stats".
    const audience = all({ '2026-07-08-p-x': { total_ms: 7_000, unique_readers: 3, days: {} } })
    const withRecord = await assembleRows(deps({
      readDevices: async () => [{ deviceId: 'D1', deviceName: 'Mac', docs: {} }],
      fetchAudienceAll: audience,
      resolveShare: () => ({ path: '/v/p.md', label: 'p.md', slug: '2026-07-08-p-x', url: 'https://w/2026-07-08-p-x' }),
    }), '2026-07-08', '2026-07-08')
    const withoutRecord = await assembleRows(deps({
      readDevices: async () => [{ deviceId: 'D1', deviceName: 'Mac', docs: {} }],
      fetchAudienceAll: audience,
      resolveShare: () => ({ path: null, label: 'x', slug: null, url: null }),
    }), '2026-07-08', '2026-07-08')
    expect(withoutRecord).toEqual(withRecord)
    expect(withRecord.map((r) => r.docKey)).toEqual(['2026-07-08-p-x'])
  })

  it('merges multiple slugs for the same md (via src) into one row and aggregates urls', async () => {
    const rows = await assembleRows(deps({
      readDevices: async () => [{ deviceId: 'D1', deviceName: 'Mac', docs: {} }],
      fetchAudienceAll: all({
        '2026-07-08-deep-a': { total_ms: 10_000, unique_readers: 2, days: {}, src: 'notes/deep.md' },
        '2026-07-08-deep-b': { total_ms: 5_000, unique_readers: 1, days: {}, src: 'notes/deep.md' },
      }),
    }), '2026-07-08', '2026-07-08')
    expect(rows).toHaveLength(1)
    expect(rows[0].docKey).toBe('rel:notes/deep.md')
    expect(rows[0].label).toBe('deep.md')
    expect(rows[0].aud_read_ms).toBe(15_000)
    expect(rows[0].unique_readers).toBe(3)
    expect([...rows[0].urls].sort()).toEqual(['https://w/2026-07-08-deep-a', 'https://w/2026-07-08-deep-b'])
  })

  it('folds a vault-relative src into its md, and surfaces an outside-vault (absolute src) share as a slug row', async () => {
    const rows = await assembleRows(deps({
      readDevices: async () => [{ deviceId: 'D1', deviceName: 'Mac', docs: {} }],
      fetchAudienceAll: all({
        '2026-07-08-vault-z': { total_ms: 12_000, unique_readers: 1, days: {}, src: 'notes/deep.md' },
        '2026-07-08-outside-z': { total_ms: 5_000, unique_readers: 1, days: {}, src: '/elsewhere/x.md' },
      }),
    }), '2026-07-08', '2026-07-08')
    // Vault-relative src → rel: key under the vault. Absolute src (outside the
    // vault) can't map to a vault md, so it still shows as its own slug row.
    expect(rows.map((r) => r.docKey).sort()).toEqual(['2026-07-08-outside-z', 'rel:notes/deep.md'])
    const vault = rows.find((r) => r.docKey === 'rel:notes/deep.md')!
    expect(vault.path).toBe('/v/notes/deep.md')
    expect(vault.label).toBe('deep.md')
    const outside = rows.find((r) => r.docKey === '2026-07-08-outside-z')!
    expect(outside.path).toBeNull()
    expect(outside.unique_readers).toBe(1)
  })
})
