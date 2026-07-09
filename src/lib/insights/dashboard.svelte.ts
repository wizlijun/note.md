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
  /** Fetch audience stats for EVERY slug read in the range — no slug list needed
   *  (server queries per-day rollups by date). Fail-soft → {}. */
  fetchAudienceAll: (from: string, to: string) => Promise<Record<string, AudienceStats>>
  /** docKeys of every shared doc — used to map audience slugs back to local
   *  paths so online-only reads surface under the right document. */
  listSharedDocKeys: () => string[]
  /** Resolve a server-provided `src` (vault-relative or absolute md path) to a
   *  local docKey/path/label, so audience-only shares surface under the right md
   *  even when this device has no local share record for them. */
  resolveSrc: (src: string) => { docKey: string; path: string | null; label: string }
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

  // Resolve shares for owner docs + every known shared doc, so we can map audience
  // slugs back to their local path. Fetch ALL audience data by date in one request.
  const knownKeys = [...new Set([...ownerKeys, ...deps.listSharedDocKeys()])]
  const shareByKey = new Map(knownKeys.map((k) => [k, deps.resolveShare(k)]))
  const bySlug = new Map<string, { docKey: string; share: ShareResolution }>()
  for (const [docKey, share] of shareByKey) if (share.slug) bySlug.set(share.slug, { docKey, share })
  const audMap = await deps.fetchAudienceAll(fromDay, toDay)

  const ownerRows = ownerKeys.map((docKey) => {
    const share = shareByKey.get(docKey)!
    const aud = share.slug ? audMap[share.slug] ?? null : null
    return makeRow(docKey, owner[docKey], share, aud, deps.weights)
  })

  // Every slug read online but with no owner activity in range — surfaced under
  // its known docKey/path when we have a local record, else resolved from the
  // server-provided `src`, else (legacy shares) under the slug itself.
  const ownerSlugs = new Set(ownerKeys.map((k) => shareByKey.get(k)!.slug).filter(Boolean))
  const extraRows = Object.entries(audMap).flatMap(([slug, aud]) => {
    if (ownerSlugs.has(slug)) return []
    if (!aud || (aud.total_ms <= 0 && aud.unique_readers <= 0)) return []
    const hit = bySlug.get(slug)
      ?? (aud.src
        ? (() => { const r = deps.resolveSrc(aud.src!); return { docKey: r.docKey, share: { path: r.path, label: r.label, slug } } })()
        : { docKey: slug, share: { path: null, label: slug, slug } })
    return [makeRow(hit.docKey, emptyCounters(0), hit.share, aud, deps.weights)]
  })

  return [...ownerRows, ...extraRows].sort((a, b) => b.value - a.value)
}
