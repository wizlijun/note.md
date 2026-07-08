/// Per-slug audience aggregator. One instance per share slug (addressed by
/// `idFromName(slug)`), so heartbeats for different shares never contend.

const MAX_DELTA_MS = 60_000

function epochHour(ts: number): number { return Math.floor(ts / 3_600_000) }
function utcDay(ts: number): string { return new Date(ts).toISOString().slice(0, 10) }

export class SlugAnalytics {
  private state: DurableObjectState
  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/hit' && req.method === 'POST') {
      const body = await req.json() as { visitor_id?: string; delta_ms?: number; ts?: number }
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
    return new Response('Not Found', { status: 404 })
  }
}

/** Same slug grammar the share endpoints already accept. */
export const SLUG_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?$/
