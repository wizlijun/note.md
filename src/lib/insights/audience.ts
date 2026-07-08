export interface AudienceStats {
  total_ms: number
  unique_readers: number
  days: Record<string, number>
}

/** Inclusive day range → epoch-ms [start-of-from, end-of-to] in UTC. */
export function dayRangeToEpoch(fromDay: string, toDay: string): { from: number; to: number } {
  return {
    from: Date.parse(fromDay + 'T00:00:00.000Z'),
    to: Date.parse(toDay + 'T23:59:59.999Z'),
  }
}

/**
 * Fetch audience aggregates for one shared slug. Authenticated with the share
 * API key (the same key used to publish). Fail-soft: returns null on any error.
 */
export async function fetchAudienceStats(
  baseUrl: string,
  apiKey: string,
  slug: string,
  fromDay: string,
  toDay: string,
): Promise<AudienceStats | null> {
  try {
    const base = baseUrl.replace(/\/+$/, '')
    const { from, to } = dayRangeToEpoch(fromDay, toDay)
    const url = `${base}/a/stats?slug=${encodeURIComponent(slug)}&from=${from}&to=${to}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
    if (!res.ok) return null
    return (await res.json()) as AudienceStats
  } catch {
    return null
  }
}

/**
 * Fetch audience aggregates for many slugs in ONE request (the author's share
 * API key authenticates all of them). Returns a `{ slug: stats }` map; slugs
 * with no data map to `{ total_ms: 0, unique_readers: 0, days: {} }`. Fail-soft:
 * returns `{}` on any error.
 */
export async function fetchAudienceStatsBatch(
  baseUrl: string,
  apiKey: string,
  slugs: string[],
  fromDay: string,
  toDay: string,
): Promise<Record<string, AudienceStats>> {
  if (slugs.length === 0) return {}
  try {
    const base = baseUrl.replace(/\/+$/, '')
    const { from, to } = dayRangeToEpoch(fromDay, toDay)
    const res = await fetch(`${base}/a/stats-batch`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ slugs, from, to }),
    })
    if (!res.ok) return {}
    return (await res.json()) as Record<string, AudienceStats>
  } catch {
    return {}
  }
}

/**
 * Fetch audience aggregates for EVERY slug that had a reader in the range, in one
 * request — no slug list required. The server reads per-day rollup DOs over the
 * range (O(days), independent of how many shares exist), so this stays fast as
 * the library grows. Returns a `{ slug: stats }` map. Fail-soft: `{}` on error.
 */
export async function fetchAudienceStatsAll(
  baseUrl: string,
  apiKey: string,
  fromDay: string,
  toDay: string,
): Promise<Record<string, AudienceStats>> {
  try {
    const base = baseUrl.replace(/\/+$/, '')
    const { from, to } = dayRangeToEpoch(fromDay, toDay)
    const res = await fetch(`${base}/a/stats-all?from=${from}&to=${to}`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) return {}
    return (await res.json()) as Record<string, AudienceStats>
  } catch {
    return {}
  }
}
