import { mergeDeviceAnalytics, aggregateRange } from './merge'
import { valueScore, type ValueWeights } from './value'
import { type AudienceStats } from './audience'
import { emptyCounters, sumCounters, type DayCounters, type DeviceAnalytics } from './model'

export interface ShareResolution {
  path: string | null
  label: string
  slug: string | null
  /** Canonical share URL from the local record, or null when there is none. */
  url: string | null
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
  /** Reconstruct the public share URL for a slug when no local record exists
   *  (audience-only shares). Returns null when the base URL is unknown. */
  resolveSlugUrl: (slug: string) => string | null
  weights: ValueWeights
}

export interface InsightRow {
  docKey: string
  label: string
  path: string | null
  read_ms: number; edit_ms: number; edit_sessions: number; mark_ops: number; net_chars: number
  aud_read_ms: number; unique_readers: number
  shared: boolean
  /** Every distinct share URL that maps to this md file; [] when not shared. */
  urls: string[]
  value: number
}

/** One (docKey, counters, audience, slug/url) datum before same-md merging. */
interface Contribution {
  docKey: string
  label: string
  path: string | null
  counters: DayCounters
  slug: string | null
  url: string | null
  aud: AudienceStats | null
}

/** Merge every contribution sharing a docKey into one row: sum counters +
 *  audience, union URLs, recompute value. The md file is the row identity. */
function mergeContributions(cs: Contribution[], weights: ValueWeights): InsightRow {
  const first = cs[0]
  const c = cs.reduce((acc, x) => sumCounters(acc, x.counters), emptyCounters(0))
  const aud_read_ms = cs.reduce((n, x) => n + (x.aud?.total_ms ?? 0), 0)
  const unique_readers = cs.reduce((n, x) => n + (x.aud?.unique_readers ?? 0), 0)
  const urls = [...new Set(cs.map((x) => x.url).filter((u): u is string => !!u))]
  const value = valueScore(
    { read_ms: c.read_ms, edit_ms: c.edit_ms, edit_sessions: c.edit_sessions, mark_ops: c.mark_ops, aud_read_ms, unique_readers },
    weights,
  )
  return {
    docKey: first.docKey, label: first.label, path: first.path,
    read_ms: c.read_ms, edit_ms: c.edit_ms, edit_sessions: c.edit_sessions, mark_ops: c.mark_ops, net_chars: c.net_chars,
    aud_read_ms, unique_readers, shared: cs.some((x) => !!x.slug), urls, value,
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

  const ownerContribs: Contribution[] = ownerKeys.map((docKey) => {
    const share = shareByKey.get(docKey)!
    return {
      docKey, label: share.label, path: share.path, counters: owner[docKey],
      slug: share.slug, url: share.url, aud: share.slug ? audMap[share.slug] ?? null : null,
    }
  })

  // Every slug read online but with no owner activity in range — surfaced under
  // its known docKey/path when we have a local record, else resolved from the
  // server-provided `src`, else (legacy shares) under the slug itself. URLs come
  // from the local record when present, else reconstructed from the slug.
  const ownerSlugs = new Set(ownerKeys.map((k) => shareByKey.get(k)!.slug).filter(Boolean))
  const extraContribs: Contribution[] = Object.entries(audMap).flatMap(([slug, aud]) => {
    if (ownerSlugs.has(slug)) return []
    if (!aud || (aud.total_ms <= 0 && aud.unique_readers <= 0)) return []
    const hit = bySlug.get(slug)?.share
      ? { docKey: bySlug.get(slug)!.docKey, share: bySlug.get(slug)!.share }
      : aud.src
        ? (() => { const r = deps.resolveSrc(aud.src!); return { docKey: r.docKey, share: { path: r.path, label: r.label, slug, url: deps.resolveSlugUrl(slug) } } })()
        : { docKey: slug, share: { path: null, label: slug, slug, url: deps.resolveSlugUrl(slug) } }
    return [{
      docKey: hit.docKey, label: hit.share.label, path: hit.share.path, counters: emptyCounters(0),
      slug, url: hit.share.url, aud,
    }]
  })

  // Group every contribution by docKey so a single md with multiple slugs/URLs
  // collapses to one row instead of duplicating.
  const groups = new Map<string, Contribution[]>()
  for (const c of [...ownerContribs, ...extraContribs]) {
    const arr = groups.get(c.docKey)
    if (arr) arr.push(c)
    else groups.set(c.docKey, [c])
  }
  return [...groups.values()]
    .map((cs) => mergeContributions(cs, deps.weights))
    // Reading Insights only surfaces vault-resident docs. Every shared file is
    // homed into the vault (rel: key), so drop device-local abs: files and
    // legacy slug-only rows. Old non-vault data is ignored, never migrated.
    .filter((r) => r.docKey.startsWith('rel:'))
    .sort((a, b) => b.value - a.value)
}
