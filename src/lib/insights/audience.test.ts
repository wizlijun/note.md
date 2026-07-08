import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAudienceStats, fetchAudienceStatsBatch, fetchAudienceStatsAll, dayRangeToEpoch } from './audience'

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

describe('fetchAudienceStatsBatch', () => {
  it('POSTs all slugs + range in one request with the API key, returns the map', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ 'slug-a': { total_ms: 5000, unique_readers: 2, days: {} } }), { status: 200 }),
    )
    const out = await fetchAudienceStatsBatch('https://w.example/', 'apikey', ['slug-a', 'slug-b'], '2026-07-08', '2026-07-08')
    expect(out['slug-a'].total_ms).toBe(5000)
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('https://w.example/a/stats-batch')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer apikey' })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.slugs).toEqual(['slug-a', 'slug-b'])
    expect(body.from).toBe(Date.UTC(2026, 6, 8, 0, 0, 0, 0))
  })
  it('returns {} without fetching when there are no slugs', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    expect(await fetchAudienceStatsBatch('https://w/', 'k', [], '2026-07-08', '2026-07-08')).toEqual({})
    expect(spy).not.toHaveBeenCalled()
  })
  it('returns {} on a non-ok response or network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 401 }))
    expect(await fetchAudienceStatsBatch('https://w/', 'k', ['s'], '2026-07-08', '2026-07-08')).toEqual({})
  })
})

describe('fetchAudienceStatsAll', () => {
  it('GETs /a/stats-all with just the range + API key, returns the map', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ 'slug-a': { total_ms: 5000, unique_readers: 2, days: {} } }), { status: 200 }),
    )
    const out = await fetchAudienceStatsAll('https://w.example/', 'apikey', '2026-07-08', '2026-07-08')
    expect(out['slug-a'].total_ms).toBe(5000)
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toContain('https://w.example/a/stats-all?from=')
    expect(String(url)).toContain(`to=${Date.UTC(2026, 6, 8, 23, 59, 59, 999)}`)
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer apikey' })
  })
  it('returns {} on a non-ok response or network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 401 }))
    expect(await fetchAudienceStatsAll('https://w/', 'k', '2026-07-08', '2026-07-08')).toEqual({})
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    expect(await fetchAudienceStatsAll('https://w/', 'k', '2026-07-08', '2026-07-08')).toEqual({})
  })
})
