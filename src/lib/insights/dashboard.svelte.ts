import { mergeDeviceAnalytics, aggregateRange } from './merge'
import { valueScore, type ValueWeights } from './value'
import { type AudienceStats } from './audience'
import { emptyCounters, type DayCounters, type DeviceAnalytics } from './model'

export interface ShareResolution {
  path: string | null
  label: string
  slug: string | null
}

export interface AssembleDeps {
  readDevices: () => Promise<DeviceAnalytics[]>
  resolveShare: (docKey: string) => ShareResolution
  /** Fetch audience stats for MANY slugs in one request (fail-soft → {}). */
  fetchAudienceBatch: (slugs: string[], from: string, to: string) => Promise<Record<string, AudienceStats>>
  /** docKeys of every shared doc — lets audience-only shares (read online but not
   *  opened by the owner in range) still surface. */
  listSharedDocKeys: () => string[]
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
  const ownerKeys = Object.keys(owner)
  const extraKeys = deps.listSharedDocKeys().filter((k) => !(k in owner))

  // Resolve shares for every candidate doc, then fetch ALL their audience stats
  // in a single batch request.
  const allKeys = [...ownerKeys, ...extraKeys]
  const shareByKey = new Map(allKeys.map((k) => [k, deps.resolveShare(k)]))
  const slugs = [...new Set(allKeys.map((k) => shareByKey.get(k)!.slug).filter((s): s is string => !!s))]
  const audMap = await deps.fetchAudienceBatch(slugs, fromDay, toDay)

  const ownerRows = ownerKeys.map((docKey) => {
    const share = shareByKey.get(docKey)!
    const aud = share.slug ? audMap[share.slug] ?? null : null
    return makeRow(docKey, owner[docKey], share, aud, deps.weights)
  })

  // Shared docs read online but with no owner activity in range.
  const extraRows = extraKeys.flatMap((docKey) => {
    const share = shareByKey.get(docKey)!
    if (!share.slug) return []
    const aud = audMap[share.slug] ?? null
    if (!aud || (aud.total_ms <= 0 && aud.unique_readers <= 0)) return []
    return [makeRow(docKey, emptyCounters(0), share, aud, deps.weights)]
  })

  return [...ownerRows, ...extraRows].sort((a, b) => b.value - a.value)
}
