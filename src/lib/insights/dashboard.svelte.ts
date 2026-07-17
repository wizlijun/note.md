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
  /** Resolve a server-provided `src` (a vault-relative md path) to a local
   *  docKey/path/label, so an online-read share surfaces under the right md on
   *  EVERY terminal — independent of this device's local share records. */
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
  const audMap = await deps.fetchAudienceAll(fromDay, toDay)

  // Owner contributions: this device's own reading/editing, keyed by the doc's
  // vault docKey. We resolve the share only for its label/url/badge — never to
  // attach audience — so which rows appear never depends on this device's local
  // share records (`share_db.json` is per-device and not vault-synced).
  const ownerContribs: Contribution[] = ownerKeys.map((docKey) => {
    const share = deps.resolveShare(docKey)
    return {
      docKey, label: share.label, path: share.path, counters: owner[docKey],
      slug: share.slug, url: share.url, aud: null,
    }
  })

  // Audience contributions: EVERY slug the site reported with reads, attributed
  // IDENTICALLY on every terminal sharing this site's key — via the server-recorded
  // vault-relative `src` when present (folds into the owner's md), else surfaced as
  // its own slug row. Never via local records, so all terminals show the same set.
  const audContribs: Contribution[] = Object.entries(audMap).flatMap(([slug, aud]) => {
    if (!aud || (aud.total_ms <= 0 && aud.unique_readers <= 0)) return []
    // `src` is always a vault-relative path (enforced at publish time); an absolute
    // one is legacy/out-of-vault and can't map to a vault md → stands as a slug row.
    if (aud.src && !aud.src.startsWith('/')) {
      const r = deps.resolveSrc(aud.src)
      return [{ docKey: r.docKey, label: r.label, path: r.path, counters: emptyCounters(0), slug, url: deps.resolveSlugUrl(slug), aud }]
    }
    return [{ docKey: slug, label: slug, path: null, counters: emptyCounters(0), slug, url: deps.resolveSlugUrl(slug), aud }]
  })

  // Group every contribution by docKey so a single md with multiple slugs/URLs
  // collapses to one row instead of duplicating.
  const groups = new Map<string, Contribution[]>()
  for (const c of [...ownerContribs, ...audContribs]) {
    const arr = groups.get(c.docKey)
    if (arr) arr.push(c)
    else groups.set(c.docKey, [c])
  }
  return [...groups.values()]
    .map((cs) => mergeContributions(cs, deps.weights))
    // Drop only device-local files OUTSIDE the vault (abs:). Vault docs (rel:) and
    // every audience slug row survive — the site's full share stats, identical on
    // every terminal.
    .filter((r) => !r.docKey.startsWith('abs:'))
    .sort((a, b) => b.value - a.value)
}
