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
