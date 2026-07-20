/// Per-slug audience aggregator. One instance per share slug (addressed by
/// `idFromName(slug)`), so heartbeats for different shares never contend.

const MAX_DELTA_MS = 60_000
/** Longest single audience reading interval we accept (matches the beacon cap). */
const MAX_SESSION_ACTIVE_MS = 30 * 60_000
/** Per-day cap on stored discrete intervals (bounds one slug's storage). */
const MAX_SESSIONS_PER_DAY = 500
/** Keep discrete intervals for this many days; older ones are pruned (the
 *  long-term hourly/daily aggregates in `h:`/`vd:` are untouched). */
const SESSION_RETENTION_DAYS = 30

function epochHour(ts: number): number { return Math.floor(ts / 3_600_000) }
function utcDay(ts: number): string { return new Date(ts).toISOString().slice(0, 10) }

/** One anonymous audience reading interval (no visitor identity is stored). */
interface AudienceSession { id: string; start: number; end: number; ms: number }

/** The bindings a SlugAnalytics DO needs (subset of the Worker's Env). */
interface AudienceBindings {
  AUDIENCE_DAY: DurableObjectNamespace
}

export class SlugAnalytics {
  private state: DurableObjectState
  private env: AudienceBindings
  constructor(state: DurableObjectState, env: AudienceBindings) {
    this.state = state
    this.env = env
  }

  /** Fold this hit into the per-DAY rollup DO so date-range "all shares"
   *  queries read O(days) DOs instead of fanning out to every slug. The bump is
   *  additive (delta + one visitor), so it stays a tiny write. */
  private async bumpDay(slug: string, day: string, delta: number, visitor: string): Promise<void> {
    if (!slug || !SLUG_RE.test(slug)) return
    try {
      const dayDo = this.env.AUDIENCE_DAY.get(this.env.AUDIENCE_DAY.idFromName(`day:${day}`))
      await dayDo.fetch('https://day/bump', {
        method: 'POST',
        body: JSON.stringify({ slug, delta_ms: delta, visitor }),
      })
    } catch {
      // Best-effort — a missed bump just means /a/stats-all under-counts this
      // slug for that day until the next hit.
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/hit' && req.method === 'POST') {
      const body = await req.json() as { visitor_id?: string; delta_ms?: number; ts?: number; slug?: string }
      const ts = typeof body.ts === 'number' && isFinite(body.ts) ? body.ts : Date.now()
      const delta = Math.max(0, Math.min(MAX_DELTA_MS, Number(body.delta_ms) || 0))
      const visitor = typeof body.visitor_id === 'string' ? body.visitor_id.slice(0, 64) : ''
      await this.state.blockConcurrencyWhile(async () => {
        const hKey = `h:${epochHour(ts)}`
        const prev = (await this.state.storage.get<number>(hKey)) ?? 0
        await this.state.storage.put(hKey, prev + delta)
        const total = (await this.state.storage.get<number>('total_ms')) ?? 0
        await this.state.storage.put('total_ms', total + delta)
        if (visitor) {
          const vKey = `vd:${utcDay(ts)}`
          const seen = (await this.state.storage.get<string[]>(vKey)) ?? []
          if (!seen.includes(visitor)) {
            seen.push(visitor)
            await this.state.storage.put(vKey, seen)
          }
        }
      })
      await this.bumpDay(typeof body.slug === 'string' ? body.slug : '', utcDay(ts), delta, visitor)
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/stats' && req.method === 'GET') {
      const from = Number(url.searchParams.get('from')) || -Infinity
      const to = Number(url.searchParams.get('to')) || Infinity
      const hours = await this.state.storage.list<number>({ prefix: 'h:' })
      const days: Record<string, number> = {}
      let total = 0
      for (const [k, ms] of hours) {
        const hour = Number(k.slice(2))
        const tsStart = hour * 3_600_000
        if (tsStart < from || tsStart > to) continue
        total += ms
        const day = new Date(tsStart).toISOString().slice(0, 10)
        days[day] = (days[day] ?? 0) + ms
      }
      const visitorDays = await this.state.storage.list<string[]>({ prefix: 'vd:' })
      const uniques = new Set<string>()
      for (const [k, ids] of visitorDays) {
        const day = k.slice(3)
        const dayStart = Date.parse(day + 'T00:00:00Z')
        const dayEnd = dayStart + 86_400_000 - 1
        if (dayEnd < from || dayStart > to) continue
        for (const id of ids) uniques.add(id)
      }
      return Response.json({ total_ms: total, unique_readers: uniques.size, days })
    }
    if (url.pathname === '/session' && req.method === 'POST') {
      // Finalize one anonymous reading interval. Upsert by session_id so a
      // hidden→visible→hidden page finalizes idempotently (latest wins).
      const body = await req.json() as { session_id?: string; start_ts?: number; end_ts?: number; active_ms?: number }
      const start = Number(body.start_ts)
      const end = Number(body.end_ts)
      const id = typeof body.session_id === 'string' ? body.session_id.slice(0, 64) : ''
      if (!id || !isFinite(start) || !isFinite(end) || end < start) return new Response(null, { status: 204 })
      const ms = Math.max(0, Math.min(MAX_SESSION_ACTIVE_MS, Number(body.active_ms) || 0))
      await this.state.blockConcurrencyWhile(async () => {
        const day = utcDay(start)
        const key = `s:${day}`
        const list = (await this.state.storage.get<AudienceSession[]>(key)) ?? []
        const entry: AudienceSession = { id, start, end, ms }
        const idx = list.findIndex((s) => s.id === id)
        if (idx >= 0) list[idx] = entry
        else if (list.length < MAX_SESSIONS_PER_DAY) list.push(entry)
        else {
          // Day is full: drop this interval but count it so stats can be honest.
          const dropKey = `s_dropped:${day}`
          await this.state.storage.put(dropKey, ((await this.state.storage.get<number>(dropKey)) ?? 0) + 1)
          return
        }
        await this.state.storage.put(key, list)
        // Prune intervals older than the retention window.
        const cutoff = utcDay(start - SESSION_RETENTION_DAYS * 86_400_000)
        const all = await this.state.storage.list<AudienceSession[]>({ prefix: 's:' })
        for (const k of all.keys()) if (k.slice(2) < cutoff) await this.state.storage.delete(k)
      })
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/sessions' && req.method === 'GET') {
      const from = Number(url.searchParams.get('from')) || -Infinity
      const to = Number(url.searchParams.get('to')) || Infinity
      const stored = await this.state.storage.list<AudienceSession[]>({ prefix: 's:' })
      const out: Array<{ start: number; end: number; ms: number }> = []
      for (const [, list] of stored) {
        for (const s of list) {
          if (s.start < from || s.start > to) continue
          out.push({ start: s.start, end: s.end, ms: s.ms })
        }
      }
      out.sort((a, b) => a.start - b.start)
      return Response.json({ sessions: out })
    }
    if (url.pathname === '/export' && req.method === 'GET') {
      // Per-day rollup of THIS slug's own storage, for one-time backfill into the
      // per-day DOs.
      const hours = await this.state.storage.list<number>({ prefix: 'h:' })
      const out: Record<string, { ms: number; visitors: string[] }> = {}
      for (const [k, ms] of hours) {
        const day = new Date(Number(k.slice(2)) * 3_600_000).toISOString().slice(0, 10)
        ;(out[day] ??= { ms: 0, visitors: [] }).ms += ms
      }
      const vds = await this.state.storage.list<string[]>({ prefix: 'vd:' })
      for (const [k, v] of vds) (out[k.slice(3)] ??= { ms: 0, visitors: [] }).visitors = v
      return Response.json(out)
    }
    return new Response('Not Found', { status: 404 })
  }
}

/**
 * One DO per UTC day (addressed by `idFromName('day:YYYY-MM-DD')`) holding that
 * day's per-slug rollup: `m:<slug>` = ms, `v:<slug>` = visitor set. Because
 * queries are by DATE, a range query reads just the day DOs in the range
 * (O(days)) and merges — independent of how many shares exist, so it stays fast
 * as the number of shares grows.
 */
export class DayRollup {
  private state: DurableObjectState
  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/bump' && req.method === 'POST') {
      const body = (await req.json()) as { slug?: string; delta_ms?: number; visitor?: string }
      const slug = typeof body.slug === 'string' ? body.slug : ''
      if (!SLUG_RE.test(slug)) return new Response(null, { status: 204 })
      const delta = Math.max(0, Math.min(MAX_DELTA_MS, Number(body.delta_ms) || 0))
      const visitor = typeof body.visitor === 'string' ? body.visitor.slice(0, 64) : ''
      await this.state.blockConcurrencyWhile(async () => {
        const mKey = `m:${slug}`
        const prev = (await this.state.storage.get<number>(mKey)) ?? 0
        await this.state.storage.put(mKey, prev + delta)
        if (visitor) {
          const vKey = `v:${slug}`
          const seen = (await this.state.storage.get<string[]>(vKey)) ?? []
          if (!seen.includes(visitor)) {
            seen.push(visitor)
            await this.state.storage.put(vKey, seen)
          }
        }
      })
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/set' && req.method === 'POST') {
      // Overwrite a slug's daily rollup (idempotent — used by backfill).
      const body = (await req.json()) as { slug?: string; ms?: number; visitors?: string[] }
      const slug = typeof body.slug === 'string' ? body.slug : ''
      if (SLUG_RE.test(slug)) {
        await this.state.storage.put(`m:${slug}`, Number(body.ms) || 0)
        await this.state.storage.put(`v:${slug}`, Array.isArray(body.visitors) ? body.visitors.slice(0, 100_000) : [])
      }
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/day' && req.method === 'GET') {
      const ms = await this.state.storage.list<number>({ prefix: 'm:', limit: 10_000 })
      const vs = await this.state.storage.list<string[]>({ prefix: 'v:', limit: 10_000 })
      const out: Record<string, { ms: number; visitors: string[] }> = {}
      for (const [k, v] of ms) out[k.slice(2)] = { ms: v, visitors: [] }
      for (const [k, v] of vs) (out[k.slice(2)] ??= { ms: 0, visitors: [] }).visitors = v
      return Response.json(out)
    }
    return new Response('Not Found', { status: 404 })
  }
}

/** Same slug grammar the share endpoints already accept. */
export const SLUG_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?$/
