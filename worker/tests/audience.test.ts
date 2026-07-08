import { describe, it, expect } from 'vitest'
import { SELF, env } from 'cloudflare:test'

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

async function stats(slug: string, token: string, from?: number, to?: number) {
  const u = new URL('http://x/a/stats')
  u.searchParams.set('slug', slug)
  if (from != null) u.searchParams.set('from', String(from))
  if (to != null) u.searchParams.set('to', String(to))
  return SELF.fetch(u, { headers: { 'Authorization': `Bearer ${token}` } })
}

async function publishShare(slug: string, token: string) {
  await env.SHARES.put(slug, '<p>x</p>', { metadata: { edit_token: token, original_filename: 'a', source_ext: 'md' } })
}

describe('GET /a/stats', () => {
  it('rejects a wrong edit_token with 403', async () => {
    const slug = '2026-07-08-stat-a'
    await publishShare(slug, 'goodtoken'.padEnd(32, 'x'))
    const r = await stats(slug, 'wrongtoken'.padEnd(32, 'x'))
    expect(r.status).toBe(403)
  })

  it('returns range-limited ms and unique reader count', async () => {
    const slug = '2026-07-08-stat-b'
    const token = 'tok'.padEnd(32, 'z')
    await publishShare(slug, token)
    const d8 = Date.UTC(2026, 6, 8, 10, 0)
    const d9 = Date.UTC(2026, 6, 9, 10, 0)
    await hit({ slug, visitor_id: 'v1', session_id: 's1', delta_ms: 10000, ts: d8 })
    await hit({ slug, visitor_id: 'v2', session_id: 's2', delta_ms: 5000, ts: d8 })
    await hit({ slug, visitor_id: 'v1', session_id: 's3', delta_ms: 4000, ts: d9 })

    const all = await (await stats(slug, token)).json() as any
    expect(all.total_ms).toBe(19000)
    expect(all.unique_readers).toBe(2)
    expect(all.days['2026-07-08']).toBe(15000)
    expect(all.days['2026-07-09']).toBe(4000)

    const only8 = await (await stats(slug, token, Date.UTC(2026, 6, 8, 0, 0), Date.UTC(2026, 6, 8, 23, 59))).json() as any
    expect(only8.total_ms).toBe(15000)
    expect(only8.unique_readers).toBe(2)
    expect(only8.days['2026-07-09']).toBeUndefined()
  })
})
