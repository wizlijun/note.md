import { mergeDeviceAnalytics, aggregateRange } from './merge'
import { valueScore, type ValueWeights } from './value'
import { type AudienceStats } from './audience'
import type { DeviceAnalytics } from './model'

export interface ShareResolution {
  path: string | null
  label: string
  slug: string | null
  editToken: string | null
}

export interface AssembleDeps {
  readDevices: () => Promise<DeviceAnalytics[]>
  resolveShare: (docKey: string) => ShareResolution
  /** Fetch audience stats for a shared slug. Slug is already resolved; fail-soft returns null. */
  fetchAudience: (slug: string) => Promise<AudienceStats | null>
  baseUrl: string
  weights: ValueWeights
}

export interface InsightRow {
  docKey: string
  label: string
  path: string | null
  read_ms: number
  edit_ms: number
  edit_sessions: number
  mark_ops: number
  net_chars: number
  aud_read_ms: number
  unique_readers: number
  shared: boolean
  value: number
}

export async function assembleRows(deps: AssembleDeps, fromDay: string, toDay: string): Promise<InsightRow[]> {
  const devices = await deps.readDevices()
  const merged = mergeDeviceAnalytics(devices)
  const owner = aggregateRange(merged, fromDay, toDay)

  const rows = await Promise.all(Object.entries(owner).map(async ([docKey, c]) => {
    const share = deps.resolveShare(docKey)
    let aud: AudienceStats | null = null
    if (share.slug) {
      aud = await deps.fetchAudience(share.slug)
    }
    const aud_read_ms = aud?.total_ms ?? 0
    const unique_readers = aud?.unique_readers ?? 0
    const value = valueScore(
      { read_ms: c.read_ms, edit_ms: c.edit_ms, edit_sessions: c.edit_sessions, mark_ops: c.mark_ops, aud_read_ms, unique_readers },
      deps.weights,
    )
    return {
      docKey,
      label: share.label,
      path: share.path,
      read_ms: c.read_ms,
      edit_ms: c.edit_ms,
      edit_sessions: c.edit_sessions,
      mark_ops: c.mark_ops,
      net_chars: c.net_chars,
      aud_read_ms,
      unique_readers,
      shared: !!share.slug,
      value,
    } satisfies InsightRow
  }))

  return rows.sort((a, b) => b.value - a.value)
}
