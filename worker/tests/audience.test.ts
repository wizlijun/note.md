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
