import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

const SLUG = '2026-07-08-foo-x7k'

function hit(body: Record<string, unknown>) {
  return SELF.fetch('http://x/a/hit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /a/hit', () => {
  it('accepts a valid beacon and returns 204', async () => {
    const r = await hit({ slug: SLUG, visitor_id: 'v1', session_id: 's1', delta_ms: 5000, ts: Date.now() })
    expect(r.status).toBe(204)
  })

  it('rejects a bad slug with 400', async () => {
    const r = await hit({ slug: 'BAD SLUG', visitor_id: 'v1', session_id: 's1', delta_ms: 5000, ts: Date.now() })
    expect(r.status).toBe(400)
  })
})

describe('aggregation (via DO, no error paths)', () => {
  it('accepts multiple hits and clamps an absurd delta without erroring', async () => {
    const slug = '2026-07-08-agg-a'
    const ts = Date.UTC(2026, 6, 8, 10, 0, 0)
    expect((await hit({ slug, visitor_id: 'v1', session_id: 's1', delta_ms: 10000, ts })).status).toBe(204)
    expect((await hit({ slug, visitor_id: 'v1', session_id: 's1', delta_ms: 5000, ts })).status).toBe(204)
    expect((await hit({ slug, visitor_id: 'v2', session_id: 's2', delta_ms: 999999999, ts })).status).toBe(204)
  })
})

const API_KEY = 'test-key' // matches miniflare SHARE_API_KEY binding

async function stats(slug: string, key: string, from?: number, to?: number) {
  const u = new URL('http://x/a/stats')
  u.searchParams.set('slug', slug)
  if (from != null) u.searchParams.set('from', String(from))
  if (to != null) u.searchParams.set('to', String(to))
  return SELF.fetch(u, { headers: { 'Authorization': `Bearer ${key}` } })
}

async function statsBatch(slugs: string[], key: string, from?: number, to?: number) {
  return SELF.fetch('http://x/a/stats-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ slugs, from, to }),
  })
}

async function statsAll(key: string, from?: number, to?: number) {
  const u = new URL('http://x/a/stats-all')
  if (from != null) u.searchParams.set('from', String(from))
  if (to != null) u.searchParams.set('to', String(to))
  return SELF.fetch(u, { headers: { 'Authorization': `Bearer ${key}` } })
}

describe('GET /a/stats', () => {
  it('rejects a wrong API key with 401', async () => {
    const r = await stats('2026-07-08-stat-a', 'wrong-key')
    expect(r.status).toBe(401)
  })

  it('returns range-limited ms and unique reader count (API-key auth)', async () => {
    const slug = '2026-07-08-stat-b'
    const d8 = Date.UTC(2026, 6, 8, 10, 0)
    const d9 = Date.UTC(2026, 6, 9, 10, 0)
    await hit({ slug, visitor_id: 'v1', session_id: 's1', delta_ms: 10000, ts: d8 })
    await hit({ slug, visitor_id: 'v2', session_id: 's2', delta_ms: 5000, ts: d8 })
    await hit({ slug, visitor_id: 'v1', session_id: 's3', delta_ms: 4000, ts: d9 })

    const all = await (await stats(slug, API_KEY)).json() as any
    expect(all.total_ms).toBe(19000)
    expect(all.unique_readers).toBe(2)
    expect(all.days['2026-07-08']).toBe(15000)
    expect(all.days['2026-07-09']).toBe(4000)

    const only8 = await (await stats(slug, API_KEY, Date.UTC(2026, 6, 8, 0, 0), Date.UTC(2026, 6, 8, 23, 59))).json() as any
    expect(only8.total_ms).toBe(15000)
    expect(only8.unique_readers).toBe(2)
    expect(only8.days['2026-07-09']).toBeUndefined()
  })
})

describe('CORS', () => {
  it('answers the preflight with permissive CORS headers', async () => {
    const r = await SELF.fetch('http://x/a/stats-batch', {
      method: 'OPTIONS',
      headers: { 'Origin': 'tauri://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    })
    expect(r.status).toBe(204)
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(r.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('authorization')
  })

  it('includes Allow-Origin on the actual response', async () => {
    const r = await stats('2026-07-08-cors-x', API_KEY)
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*')
    await r.text() // drain the DO-backed body so isolated storage cleans up
  })
})

describe('POST /a/stats-batch', () => {
  it('rejects a wrong API key with 401', async () => {
    const r = await statsBatch(['2026-07-08-b1-x'], 'wrong-key')
    expect(r.status).toBe(401)
  })

  it('returns a slug→stats map for many slugs in one request', async () => {
    const s1 = '2026-07-08-batch-a'
    const s2 = '2026-07-08-batch-b'
    const ts = Date.UTC(2026, 6, 8, 12, 0)
    await hit({ slug: s1, visitor_id: 'v1', session_id: 'x1', delta_ms: 7000, ts })
    await hit({ slug: s1, visitor_id: 'v2', session_id: 'x2', delta_ms: 3000, ts })
    await hit({ slug: s2, visitor_id: 'v1', session_id: 'x3', delta_ms: 2000, ts })

    const map = await (await statsBatch([s1, s2, s1 /* dup ignored */], API_KEY)).json() as any
    expect(map[s1].total_ms).toBe(10000)
    expect(map[s1].unique_readers).toBe(2)
    expect(map[s2].total_ms).toBe(2000)
    expect(map[s2].unique_readers).toBe(1)
  })

  it('honors the from/to range', async () => {
    const slug = '2026-07-08-batch-c'
    await hit({ slug, visitor_id: 'v1', session_id: 'y1', delta_ms: 8000, ts: Date.UTC(2026, 6, 8, 10, 0) })
    await hit({ slug, visitor_id: 'v1', session_id: 'y2', delta_ms: 4000, ts: Date.UTC(2026, 6, 10, 10, 0) })
    const map = await (await statsBatch([slug], API_KEY, Date.UTC(2026, 6, 8, 0, 0), Date.UTC(2026, 6, 8, 23, 59))).json() as any
    expect(map[slug].total_ms).toBe(8000)
  })
})

describe('GET /a/stats-all (date-range, no slug list)', () => {
  it('rejects a wrong API key with 401', async () => {
    expect((await statsAll('wrong-key')).status).toBe(401)
  })

  it('returns every slug that had a hit in the range, merged (via per-day rollup)', async () => {
    const d = Date.UTC(2026, 6, 8, 9, 0)
    await hit({ slug: '2026-07-08-all-a', visitor_id: 'v1', session_id: 's1', delta_ms: 6000, ts: d })
    await hit({ slug: '2026-07-08-all-a', visitor_id: 'v2', session_id: 's2', delta_ms: 4000, ts: d })
    await hit({ slug: '2026-07-08-all-b', visitor_id: 'v1', session_id: 's3', delta_ms: 2000, ts: d })

    const map = await (await statsAll(API_KEY, Date.UTC(2026, 6, 8, 0, 0), Date.UTC(2026, 6, 8, 23, 59))).json() as any
    expect(map['2026-07-08-all-a'].total_ms).toBe(10000)
    expect(map['2026-07-08-all-a'].unique_readers).toBe(2)
    expect(map['2026-07-08-all-a'].days['2026-07-08']).toBe(10000)
    expect(map['2026-07-08-all-b'].total_ms).toBe(2000)
    expect(map['2026-07-08-all-b'].unique_readers).toBe(1)
  })

  it('excludes days outside the range', async () => {
    await hit({ slug: '2026-07-20-all-c', visitor_id: 'v9', session_id: 'sx', delta_ms: 5000, ts: Date.UTC(2026, 6, 20, 9, 0) })
    const map = await (await statsAll(API_KEY, Date.UTC(2026, 6, 8, 0, 0), Date.UTC(2026, 6, 8, 23, 59))).json() as any
    expect(map['2026-07-20-all-c']).toBeUndefined()
  })
})

async function publish(slug: string, src: string) {
  return SELF.fetch('http://x/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      slug, edit_token: 'a'.repeat(32), html: '<p>hi</p>',
      metadata: { original_filename: 'foo.md', source_ext: 'md', src },
    }),
  })
}

describe('stats carry the source md (src) recorded at publish', () => {
  it('stats-all attaches each slug\'s src from KV metadata', async () => {
    await publish('2026-07-08-src-a', 'notes/foo.md')
    await publish('2026-07-08-src-b', '/outside/bar.md')
    const d = Date.UTC(2026, 6, 8, 9, 0)
    await hit({ slug: '2026-07-08-src-a', visitor_id: 'v1', session_id: 's1', delta_ms: 3000, ts: d })
    await hit({ slug: '2026-07-08-src-b', visitor_id: 'v2', session_id: 's2', delta_ms: 2000, ts: d })

    const map = await (await statsAll(API_KEY, Date.UTC(2026, 6, 8, 0, 0), Date.UTC(2026, 6, 8, 23, 59))).json() as any
    expect(map['2026-07-08-src-a'].src).toBe('notes/foo.md')
    expect(map['2026-07-08-src-b'].src).toBe('/outside/bar.md')
  })

  it('single /a/stats and /a/stats-batch also return src', async () => {
    await publish('2026-07-08-src-c', 'deep/c.md')
    await hit({ slug: '2026-07-08-src-c', visitor_id: 'v1', session_id: 's1', delta_ms: 1000, ts: Date.UTC(2026, 6, 8, 9, 0) })

    const single = await (await stats('2026-07-08-src-c', API_KEY)).json() as any
    expect(single.src).toBe('deep/c.md')

    const batch = await (await statsBatch(['2026-07-08-src-c'], API_KEY)).json() as any
    expect(batch['2026-07-08-src-c'].src).toBe('deep/c.md')
  })
})
