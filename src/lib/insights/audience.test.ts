import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAudienceStats, dayRangeToEpoch } from './audience'

afterEach(() => vi.restoreAllMocks())

describe('dayRangeToEpoch', () => {
  it('spans from start-of-from-day to end-of-to-day (UTC)', () => {
    const { from, to } = dayRangeToEpoch('2026-07-08', '2026-07-08')
    expect(from).toBe(Date.UTC(2026, 6, 8, 0, 0, 0, 0))
    expect(to).toBe(Date.UTC(2026, 6, 8, 23, 59, 59, 999))
  })
})

describe('fetchAudienceStats', () => {
  it('calls /a/stats with slug, range, and bearer token', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ total_ms: 5000, unique_readers: 2, days: { '2026-07-08': 5000 } }), { status: 200 }),
    )
    const out = await fetchAudienceStats('https://w.example/', 'tok', '2026-07-08-foo-x7k', '2026-07-08', '2026-07-08')
    expect(out).toEqual({ total_ms: 5000, unique_readers: 2, days: { '2026-07-08': 5000 } })
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toContain('https://w.example/a/stats?slug=2026-07-08-foo-x7k')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' })
  })
  it('returns null on a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 403 }))
    expect(await fetchAudienceStats('https://w/', 't', '2026-07-08-foo-x7k', '2026-07-08', '2026-07-08')).toBeNull()
  })
  it('returns null on a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    expect(await fetchAudienceStats('https://w/', 't', '2026-07-08-foo-x7k', '2026-07-08', '2026-07-08')).toBeNull()
  })
})
