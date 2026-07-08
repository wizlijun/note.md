import { mergeDeviceAnalytics, aggregateRange } from './merge'
import { valueScore, type ValueWeights } from './value'
import { type AudienceStats } from './audience'
import { emptyCounters, type DayCounters, type DeviceAnalytics } from './model'

export interface ShareResolution {
  path: string | null
  label: string
  slug: string | null
  editToken: string | null
}

export interface AssembleDeps {
  readDevices: () => Promise<DeviceAnalytics[]>
  resolveShare: (docKey: string) => ShareResolution
  /** Fetch audience stats for a shared slug (fail-soft → null). Receives the
   *  per-doc edit token + range + baseUrl the assembly already has in hand. */
  fetchAudience: (slug: string, editToken: string, from: string, to: string, baseUrl: string) => Promise<AudienceStats | null>
  /** docKeys of every shared doc — lets audience-only shares (read online but not
   *  opened by the owner in range) still surface. */
  listSharedDocKeys: () => string[]
  baseUrl: string
  weights: ValueWeights
}

export interface InsightRow {
  docKey: string
  label: string
  path: string | null
  read_ms: number; edit_ms: number; edit_sessions: number; mark_ops: number; net_chars: number
  aud_read_ms: number; unique_readers: number
  shared: boolean
  value: number
}

function makeRow(docKey: string, c: DayCounters, share: ShareResolution, aud: AudienceStats | null, weights: ValueWeights): InsightRow {
  const aud_read_ms = aud?.total_ms ?? 0
  const unique_readers = aud?.unique_readers ?? 0
  const value = valueScore(
    { read_ms: c.read_ms, edit_ms: c.edit_ms, edit_sessions: c.edit_sessions, mark_ops: c.mark_ops, aud_read_ms, unique_readers },
    weights,
  )
  return {
    docKey, label: share.label, path: share.path,
    read_ms: c.read_ms, edit_ms: c.edit_ms, edit_sessions: c.edit_sessions, mark_ops: c.mark_ops, net_chars: c.net_chars,
    aud_read_ms, unique_readers, shared: !!share.slug, value,
  }
}

export async function assembleRows(deps: AssembleDeps, fromDay: string, toDay: string): Promise<InsightRow[]> {
  const devices = await deps.readDevices()
  const merged = mergeDeviceAnalytics(devices)
  const owner = aggregateRange(merged, fromDay, toDay)
  const ownerKeys = new Set(Object.keys(owner))

  // Docs the owner read/edited in range (audience joined for shared ones).
  const ownerRows = await Promise.all(Object.entries(owner).map(async ([docKey, c]) => {
    const share = deps.resolveShare(docKey)
    let aud: AudienceStats | null = null
    if (share.slug && share.editToken) {
      aud = await deps.fetchAudience(share.slug, share.editToken, fromDay, toDay, deps.baseUrl)
    }
    return makeRow(docKey, c, share, aud, deps.weights)
  }))

  // Shared docs with audience engagement in range but NO owner activity — so a
  // doc read online (but not opened by the owner in range) still appears.
  const extraKeys = deps.listSharedDocKeys().filter((k) => !ownerKeys.has(k))
  const extraRows = (await Promise.all(extraKeys.map(async (docKey) => {
    const share = deps.resolveShare(docKey)
    if (!share.slug || !share.editToken) return null
    const aud = await deps.fetchAudience(share.slug, share.editToken, fromDay, toDay, deps.baseUrl)
    if (!aud || (aud.total_ms <= 0 && aud.unique_readers <= 0)) return null
    return makeRow(docKey, emptyCounters(0), share, aud, deps.weights)
  }))).filter((r): r is InsightRow => r !== null)

  return [...ownerRows, ...extraRows].sort((a, b) => b.value - a.value)
}
