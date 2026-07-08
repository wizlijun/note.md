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

/** Fetch audience aggregates for one shared slug. Fail-soft: returns null on any error. */
export async function fetchAudienceStats(
  baseUrl: string,
  editToken: string,
  slug: string,
  fromDay: string,
  toDay: string,
): Promise<AudienceStats | null> {
  try {
    const base = baseUrl.replace(/\/+$/, '')
    const { from, to } = dayRangeToEpoch(fromDay, toDay)
    const url = `${base}/a/stats?slug=${encodeURIComponent(slug)}&from=${from}&to=${to}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${editToken}` } })
    if (!res.ok) return null
    return (await res.json()) as AudienceStats
  } catch {
    return null
  }
}
