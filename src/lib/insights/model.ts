/** Per-document, per-day owner engagement counters. */
export interface DayCounters {
  read_ms: number
  edit_ms: number
  open_count: number
  edit_sessions: number
  net_chars: number
  mark_ops: number
  first_seen_at: number
  last_active_at: number
}

/** docKey -> "YYYY-MM-DD" -> counters. */
export type DocDays = Record<string, Record<string, DayCounters>>

/** One device's synced analytics file. */
export interface DeviceAnalytics {
  deviceId: string
  deviceName: string
  docs: DocDays
}

/**
 * Local calendar day (YYYY-MM-DD) for an epoch-ms timestamp, given the device's
 * timezone offset in minutes east of UTC (e.g. UTC+8 → 480). Buckets are the
 * device's LOCAL day so "yesterday" in the report layer lines up with the
 * user's wall clock.
 */
export function dayKey(ms: number, tzOffsetMinutes: number): string {
  const shifted = new Date(ms + tzOffsetMinutes * 60_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** The device's current timezone offset in minutes east of UTC. */
export function localTzOffsetMinutes(now = new Date()): number {
  // Date#getTimezoneOffset is minutes WEST of UTC; negate for east-of-UTC.
  return -now.getTimezoneOffset()
}

function stripTrailingSlash(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p
}

/**
 * Stable cross-device key for a document. Files under the vault get a
 * vault-relative `rel:` key (identical on every device); everything else gets an
 * absolute `abs:` key (device-local, will not collide across devices).
 */
export function docKeyFor(absPath: string, vaultRoot: string | null): string {
  if (vaultRoot) {
    const root = stripTrailingSlash(vaultRoot)
    if (absPath === root) return `abs:${absPath}`
    if (absPath.startsWith(root + '/')) return `rel:${absPath.slice(root.length + 1)}`
  }
  return `abs:${absPath}`
}

export function emptyCounters(nowMs: number): DayCounters {
  return {
    read_ms: 0,
    edit_ms: 0,
    open_count: 0,
    edit_sessions: 0,
    net_chars: 0,
    mark_ops: 0,
    first_seen_at: nowMs,
    last_active_at: nowMs,
  }
}

/** Combine two counter sets: sum totals, min first_seen_at, max last_active_at. */
export function sumCounters(a: DayCounters, b: DayCounters): DayCounters {
  return {
    read_ms: a.read_ms + b.read_ms,
    edit_ms: a.edit_ms + b.edit_ms,
    open_count: a.open_count + b.open_count,
    edit_sessions: a.edit_sessions + b.edit_sessions,
    net_chars: a.net_chars + b.net_chars,
    mark_ops: a.mark_ops + b.mark_ops,
    first_seen_at: Math.min(a.first_seen_at, b.first_seen_at),
    last_active_at: Math.max(a.last_active_at, b.last_active_at),
  }
}
