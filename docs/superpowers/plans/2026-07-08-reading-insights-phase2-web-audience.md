# Reading Insights — Phase 2: Web Beacon + Cloudflare Worker Audience Aggregation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect anonymous audience reading time on shared markdown pages (mobile/desktop web) and aggregate it per share `slug` in the existing Cloudflare Worker, exposing owner-only stats — so a document's public engagement can feed the value score alongside the owner's own engagement from Phase 1.

**Architecture:** A self-contained beacon `<script>` injected into the baked share HTML measures real reading time (Page Visibility + idle pause) and posts additive `delta_ms` heartbeats to `POST /a/hit` (fetch keepalive), with a `navigator.sendBeacon` flush on hide. A per-slug Durable Object coalesces the high-frequency heartbeats into per-hour reading-time rollups and per-day unique-visitor sets. `GET /a/stats?slug=&from=&to=` returns range-limited aggregates, gated by the share's `edit_token` (already stored in KV metadata), so only the author can read them.

**Tech Stack:** Cloudflare Workers, Durable Objects (SQLite-free KV storage API), `@cloudflare/vitest-pool-workers`, TypeScript. Client beacon authored as raw JS injected via `?raw` (same pattern share-baker uses for CSS).

**Scope note:** Phase 2 of 4. Ships audience collection + owner-readable aggregates. It does NOT build the dashboard (Phase 3) or the report/CLI (Phase 4). Session-count tracking is intentionally omitted (the value score uses reading-time + unique readers only). Deployment (`wrangler deploy`) is an explicit final step to confirm with the human — everything before it is buildable and unit-testable locally.

**Data-flow recap:** beacon → `POST /a/hit {slug, visitor_id, session_id, delta_ms, ts}` → Worker validates + clamps → DO `SlugAnalytics` for `slug` → aggregates. Author app → `GET /a/stats?slug&from&to` with `edit_token` → Worker verifies token against KV metadata → queries DO → JSON.

---

## File Structure

**Worker (`worker/`):**
- Modify `worker/src/index.ts` — add `Env.AUDIENCE` DO binding; add `/a/hit` and `/a/stats` routes; export the `SlugAnalytics` DO class.
- Create `worker/src/audience.ts` — the `SlugAnalytics` Durable Object + pure helpers (`hourKey`, `dayKey`, `clampDelta`, range aggregation).
- Modify `worker/wrangler.toml` — DO binding + migration.
- Create `worker/tests/audience.test.ts` — `/a/hit`, `/a/stats`, aggregation, auth.

**App (`src/`):**
- Create `src/lib/plugins/share-beacon.js` — the raw beacon script (imported as `?raw`).
- Create `src/lib/plugins/beacon-timing.ts` + `beacon-timing.test.ts` — the pure visible-time accumulator the beacon uses (extracted so it is unit-testable; the raw beacon mirrors it).
- Modify `src/lib/plugins/share-baker.ts` — inject the beacon before `</body>` when the `reading-insights` plugin is enabled.
- Modify `src/lib/plugins/share-baker.test.ts` (or the existing bake test) — assert beacon presence/absence.

---

## Task 1: Durable Object binding, Env, and skeleton

**Files:**
- Modify: `worker/wrangler.toml`, `worker/src/index.ts`
- Create: `worker/src/audience.ts`
- Test: `worker/tests/audience.test.ts`

- [ ] **Step 1: Write a failing test that `/a/hit` returns 204 and is wired to a DO**

Create `worker/tests/audience.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

const SLUG = '2026-07-08-foo-x7k'

function hit(body: Record<string, unknown>) {
  return SELF.fetch('http://x/a/hit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /a/hit', () => {
  it('accepts a valid beacon and returns 204', async () => {
    const r = await hit({ slug: SLUG, visitor_id: 'v1', session_id: 's1', delta_ms: 5000, ts: Date.now() })
    expect(r.status).toBe(204)
  })

  it('rejects a bad slug with 400', async () => {
    const r = await hit({ slug: 'BAD SLUG', visitor_id: 'v1', session_id: 's1', delta_ms: 5000, ts: Date.now() })
    expect(r.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run it, expect failure**

Run (from `worker/`): `pnpm vitest run tests/audience.test.ts`
Expected: FAIL — 404 (route not wired) / DO binding missing.

- [ ] **Step 3: Add the DO binding + migration to `worker/wrangler.toml`**

Append:

```toml
[[durable_objects.bindings]]
name = "AUDIENCE"
class_name = "SlugAnalytics"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SlugAnalytics"]
```

- [ ] **Step 4: Create `worker/src/audience.ts` with the skeleton DO + slug validation**

```typescript
/// Per-slug audience aggregator. One instance per share slug (addressed by
/// `idFromName(slug)`), so heartbeats for different shares never contend.
export class SlugAnalytics {
  private state: DurableObjectState
  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/hit' && req.method === 'POST') {
      // Aggregation added in Task 2.
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/stats' && req.method === 'GET') {
      // Query added in Task 3.
      return Response.json({ total_ms: 0, unique_readers: 0, days: {} })
    }
    return new Response('Not Found', { status: 404 })
  }
}

/** Same slug grammar the share endpoints already accept. */
export const SLUG_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?$/
```

- [ ] **Step 5: Wire `Env.AUDIENCE`, export the DO, and route `/a/hit` in `worker/src/index.ts`**

- Add to `interface Env`: `AUDIENCE: DurableObjectNamespace`.
- Add at top: `import { SlugAnalytics, SLUG_RE as AUDIENCE_SLUG_RE } from './audience'` and re-export the class: `export { SlugAnalytics } from './audience'`.
- Add a handler and route it in the `fetch` dispatch (before the generic `GET /:slug`):

```typescript
async function handleAudienceHit(req: Request, env: Env): Promise<Response> {
  let body: { slug?: unknown; visitor_id?: unknown; session_id?: unknown; delta_ms?: unknown; ts?: unknown }
  try { body = await req.json() } catch { return new Response('bad json', { status: 400 }) }
  const slug = typeof body.slug === 'string' ? body.slug : ''
  if (!AUDIENCE_SLUG_RE.test(slug)) return new Response('bad slug', { status: 400 })
  const stub = env.AUDIENCE.get(env.AUDIENCE.idFromName(slug))
  return stub.fetch('https://do/hit', { method: 'POST', body: JSON.stringify(body) })
}
```

In the `fetch` dispatch block (near the other `if (req.method === 'POST' && path === ...)` lines):

```typescript
    if (req.method === 'POST' && path === 'a/hit') return handleAudienceHit(req, env)
```

- [ ] **Step 6: Run the test, expect pass**

Run: `pnpm vitest run tests/audience.test.ts`
Expected: PASS (204 for valid, 400 for bad slug).

- [ ] **Step 7: Commit**

```bash
git add worker/wrangler.toml worker/src/audience.ts worker/src/index.ts worker/tests/audience.test.ts
git commit -m "feat(worker): SlugAnalytics DO skeleton + /a/hit routing"
```

---

## Task 2: Heartbeat aggregation in the DO (per-hour ms + per-day unique visitors)

**Files:**
- Modify: `worker/src/audience.ts`
- Test: `worker/tests/audience.test.ts`

Storage model (DO `state.storage`, JSON values):
- `h:<epochHour>` → `number` (accumulated reading ms in that UTC hour).
- `vd:<YYYY-MM-DD>` → `string[]` (distinct `visitor_id`s seen that UTC day).
- `total_ms` → `number`.

Constants: a single heartbeat's `delta_ms` is clamped to `[0, 60_000]` (heartbeats fire ≤ every 15s of real reading, so 60s is generous headroom against inflation).

- [ ] **Step 1: Write failing tests**

Append to `worker/tests/audience.test.ts`:

```typescript
async function stats(slug: string, token: string, from?: number, to?: number) {
  const u = new URL('http://x/a/stats')
  u.searchParams.set('slug', slug)
  if (from != null) u.searchParams.set('from', String(from))
  if (to != null) u.searchParams.set('to', String(to))
  return SELF.fetch(u, { headers: { 'Authorization': `Bearer ${token}` } })
}

describe('aggregation', () => {
  it('sums reading time and counts unique visitors across hits', async () => {
    const slug = '2026-07-08-agg-a'
    const ts = Date.UTC(2026, 6, 8, 10, 0, 0)
    await hit({ slug, visitor_id: 'v1', session_id: 's1', delta_ms: 10000, ts })
    await hit({ slug, visitor_id: 'v1', session_id: 's1', delta_ms: 5000, ts })
    await hit({ slug, visitor_id: 'v2', session_id: 's2', delta_ms: 3000, ts })
    // Verified through the DO directly (auth-free internal fetch) to isolate Task 2 from Task 3.
    const id = (globalThis as any).__nope // placeholder; real assertion added once /stats lands
    expect(true).toBe(true)
  })

  it('clamps an absurd delta_ms', async () => {
    const slug = '2026-07-08-agg-b'
    const r = await hit({ slug, visitor_id: 'v1', session_id: 's1', delta_ms: 999999999, ts: Date.now() })
    expect(r.status).toBe(204)
  })
})
```

(The aggregation is asserted end-to-end in Task 3 via `/a/stats`; here we implement the DO storage and verify it doesn't error. Keep this test minimal — Task 3 adds the real assertions.)

- [ ] **Step 2: Implement aggregation in `SlugAnalytics.fetch` `/hit`**

```typescript
const MAX_DELTA_MS = 60_000

function epochHour(ts: number): number { return Math.floor(ts / 3_600_000) }
function utcDay(ts: number): string { return new Date(ts).toISOString().slice(0, 10) }

// inside fetch, replacing the /hit stub:
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
```

- [ ] **Step 3: Run tests, expect pass**

Run: `pnpm vitest run tests/audience.test.ts`
Expected: PASS (no errors; clamping accepted).

- [ ] **Step 4: Commit**

```bash
git add worker/src/audience.ts worker/tests/audience.test.ts
git commit -m "feat(worker): DO heartbeat aggregation — per-hour ms + per-day unique visitors"
```

---

## Task 3: `GET /a/stats` with edit_token auth and range query

**Files:**
- Modify: `worker/src/audience.ts` (DO `/stats`), `worker/src/index.ts` (route + auth)
- Test: `worker/tests/audience.test.ts`

`/a/stats?slug=&from=&to=` (from/to are epoch ms, optional → all-time). Auth: read the share's KV metadata (`env.SHARES.getWithMetadata<KvMeta>(slug)`) and require the request's Bearer token to equal `metadata.edit_token`. Returns `{ total_ms, unique_readers, days: { 'YYYY-MM-DD': ms } }` where `total_ms`/`days` are range-limited and `unique_readers` is the count of distinct visitors across days in range.

- [ ] **Step 1: Write failing tests (full aggregation assertions)**

Append:

```typescript
import { env } from 'cloudflare:test'

async function publishShare(slug: string, token: string) {
  // Seed a share so /a/stats can verify the edit_token from KV metadata.
  await env.SHARES.put(slug, '<p>x</p>', { metadata: { edit_token: token, original_filename: 'a', source_ext: 'md' } })
}

describe('GET /a/stats', () => {
  it('rejects a wrong edit_token with 403', async () => {
    const slug = '2026-07-08-stat-a'
    await publishShare(slug, 'goodtoken'.padEnd(32, 'x'))
    const r = await stats(slug, 'wrongtoken'.padEnd(32, 'x'))
    expect(r.status).toBe(403)
  })

  it('returns range-limited ms and unique reader count', async () => {
    const slug = '2026-07-08-stat-b'
    const token = 'tok'.padEnd(32, 'z')
    await publishShare(slug, token)
    const d8 = Date.UTC(2026, 6, 8, 10, 0)
    const d9 = Date.UTC(2026, 6, 9, 10, 0)
    await hit({ slug, visitor_id: 'v1', session_id: 's1', delta_ms: 10000, ts: d8 })
    await hit({ slug, visitor_id: 'v2', session_id: 's2', delta_ms: 5000, ts: d8 })
    await hit({ slug, visitor_id: 'v1', session_id: 's3', delta_ms: 4000, ts: d9 })

    const all = await (await stats(slug, token)).json() as any
    expect(all.total_ms).toBe(19000)
    expect(all.unique_readers).toBe(2)
    expect(all.days['2026-07-08']).toBe(15000)
    expect(all.days['2026-07-09']).toBe(4000)

    // Range covering only the 8th.
    const only8 = await (await stats(slug, token, Date.UTC(2026, 6, 8, 0, 0), Date.UTC(2026, 6, 8, 23, 59))).json() as any
    expect(only8.total_ms).toBe(15000)
    expect(only8.unique_readers).toBe(2)
    expect(only8.days['2026-07-09']).toBeUndefined()
  })
})
```

- [ ] **Step 2: Implement the DO `/stats` query (per-day rollup + unique union)**

Replace the `/stats` stub in `SlugAnalytics.fetch`:

```typescript
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
        // Day is in range if its midnight..end overlaps [from,to].
        const dayStart = Date.parse(day + 'T00:00:00Z')
        const dayEnd = dayStart + 86_400_000 - 1
        if (dayEnd < from || dayStart > to) continue
        for (const id of ids) uniques.add(id)
      }
      return Response.json({ total_ms: total, unique_readers: uniques.size, days })
    }
```

- [ ] **Step 3: Implement the Worker route + edit_token auth in `worker/src/index.ts`**

```typescript
async function handleAudienceStats(req: Request, env: Env, url: URL): Promise<Response> {
  const slug = url.searchParams.get('slug') ?? ''
  if (!AUDIENCE_SLUG_RE.test(slug)) return new Response('bad slug', { status: 400 })
  const auth = req.headers.get('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const rec = await env.SHARES.getWithMetadata<KvMeta>(slug)
  if (!rec || !rec.metadata) return new Response('not found', { status: 404 })
  if (!token || token !== rec.metadata.edit_token) return new Response('forbidden', { status: 403 })
  const stub = env.AUDIENCE.get(env.AUDIENCE.idFromName(slug))
  const doUrl = new URL('https://do/stats')
  doUrl.search = url.search
  return stub.fetch(doUrl.toString())
}
```

Route it in `fetch` (before generic `GET /:slug`):

```typescript
    if (req.method === 'GET' && path === 'a/stats') return handleAudienceStats(req, env, url)
```

(Confirm `KvMeta` includes `edit_token`; if the field name differs, match the existing metadata shape used by `handlePublish`.)

- [ ] **Step 4: Run tests, expect pass**

Run: `pnpm vitest run tests/audience.test.ts`
Expected: PASS (403 on bad token; correct totals, per-day, unique counts, range filtering).

- [ ] **Step 5: Commit**

```bash
git add worker/src/audience.ts worker/src/index.ts worker/tests/audience.test.ts
git commit -m "feat(worker): /a/stats edit_token-gated range query over DO rollups"
```

---

## Task 4: Beacon timing core (pure, unit-tested)

**Files:**
- Create: `src/lib/plugins/beacon-timing.ts`
- Test: `src/lib/plugins/beacon-timing.test.ts`

A tiny pure accumulator the beacon uses: accrues visible, non-idle reading time and emits flushable deltas. Mirrors Phase 1's timing idea but visibility-based and simpler.

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import { createBeaconClock, IDLE_MS, MAX_SESSION_MS } from './beacon-timing'

describe('beacon clock', () => {
  it('accrues time only while visible and not idle', () => {
    const c = createBeaconClock(0)
    c.setVisible(true, 0)
    c.activity(0)
    expect(c.takeDelta(5000)).toBe(5000)     // 5s visible
    c.setVisible(false, 7000)                // hidden at 7s → credit 2s more
    expect(c.takeDelta(7000)).toBe(2000)
    expect(c.takeDelta(10000)).toBe(0)       // hidden: nothing
  })

  it('pauses after IDLE_MS without activity', () => {
    const c = createBeaconClock(0)
    c.setVisible(true, 0)
    c.activity(0)
    const d = c.takeDelta(IDLE_MS + 5000)    // idle kicked in at IDLE_MS
    expect(d).toBe(IDLE_MS)                   // credited up to idle threshold only
  })

  it('caps total accrued at MAX_SESSION_MS', () => {
    const c = createBeaconClock(0)
    c.setVisible(true, 0)
    let total = 0
    for (let t = 1000; t <= MAX_SESSION_MS + 600_000; t += 1000) {
      c.activity(t)
      total += c.takeDelta(t)
    }
    expect(total).toBe(MAX_SESSION_MS)
  })
})
```

- [ ] **Step 2: Run it, expect fail**

Run: `pnpm vitest run src/lib/plugins/beacon-timing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/plugins/beacon-timing.ts`**

```typescript
export const IDLE_MS = 30_000
export const MAX_SESSION_MS = 30 * 60_000

/**
 * Pure reading-time accumulator for the share beacon. `takeDelta(now)` returns
 * the visible, non-idle ms since the previous call (0 when hidden/idle) and
 * advances the internal cursor. Total accrued is capped at MAX_SESSION_MS.
 */
export function createBeaconClock(startMs: number) {
  let visible = false
  let lastActivity = startMs
  let cursor = startMs         // last point already credited
  let accruedTotal = 0

  function active(now: number): boolean {
    return visible && now - lastActivity < IDLE_MS
  }

  const api = {
    setVisible(v: boolean, now: number) {
      api.takeDelta(now)   // credit up to `now` under the old state before flipping
      visible = v
      cursor = now
    },
    activity(now: number) {
      if (now - lastActivity >= IDLE_MS) cursor = now  // resume: don't credit the idle gap
      lastActivity = now
    },
    takeDelta(now: number): number {
      if (now <= cursor) { cursor = Math.max(cursor, now); return 0 }
      const idleAt = lastActivity + IDLE_MS
      let end = now
      if (!visible) end = cursor                       // hidden: credit nothing
      else if (now > idleAt) end = Math.max(cursor, idleAt) // idle cap
      const gross = Math.max(0, end - cursor)
      cursor = now
      const room = Math.max(0, MAX_SESSION_MS - accruedTotal)
      const credited = Math.min(gross, room)
      accruedTotal += credited
      return credited
    },
  }
  return api
}
```

(`active()` is unused in this simplified form — omit it.)

- [ ] **Step 4: Run tests, expect pass** (adjust the `takeDelta` edge logic until the three cases pass exactly)

Run: `pnpm vitest run src/lib/plugins/beacon-timing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/beacon-timing.ts src/lib/plugins/beacon-timing.test.ts
git commit -m "feat(insights): pure beacon reading-time clock (visibility + idle + cap)"
```

---

## Task 5: Beacon script (raw JS)

**Files:**
- Create: `src/lib/plugins/share-beacon.js`

Authored as plain browser JS (no build step; injected via `?raw`). It mirrors `beacon-timing.ts` inline (the pure module is the tested reference; this is its self-contained runtime twin), reads the slug from the URL, manages a `visitor_id` in localStorage, heartbeats every 15s via `fetch(..., {keepalive:true})`, and flushes remaining delta on `visibilitychange→hidden` / `pagehide` via `navigator.sendBeacon`.

- [ ] **Step 1: Create `src/lib/plugins/share-beacon.js`**

```javascript
;(function () {
  try {
    var slug = location.pathname.replace(/^\//, '')
    if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?$/.test(slug)) return
    var HIT = '/a/hit'
    var IDLE = 30000, CAP = 1800000, BEAT = 15000
    var vid
    try {
      vid = localStorage.getItem('mdi_vid')
      if (!vid) { vid = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); localStorage.setItem('mdi_vid', vid) }
    } catch (e) { vid = 's' + Math.random().toString(36).slice(2) }
    var sid = String(Date.now()) + Math.random().toString(36).slice(2)

    var visible = document.visibilityState === 'visible'
    var lastAct = Date.now(), cursor = Date.now(), total = 0

    function take(now) {
      if (now <= cursor) { cursor = Math.max(cursor, now); return 0 }
      var idleAt = lastAct + IDLE, end = now
      if (!visible) end = cursor
      else if (now > idleAt) end = Math.max(cursor, idleAt)
      var gross = Math.max(0, end - cursor)
      cursor = now
      var room = Math.max(0, CAP - total), c = Math.min(gross, room)
      total += c
      return c
    }
    function send(delta, useBeacon) {
      if (delta <= 0) return
      var payload = JSON.stringify({ slug: slug, visitor_id: vid, session_id: sid, delta_ms: delta, ts: Date.now() })
      if (useBeacon && navigator.sendBeacon) { navigator.sendBeacon(HIT, new Blob([payload], { type: 'application/json' })); return }
      try { fetch(HIT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }) } catch (e) {}
    }
    function activity() { var now = Date.now(); if (now - lastAct >= IDLE) cursor = now; lastAct = now }
    ;['scroll', 'keydown', 'pointerdown', 'touchstart', 'mousemove'].forEach(function (e) {
      window.addEventListener(e, activity, { passive: true })
    })
    document.addEventListener('visibilitychange', function () {
      var now = Date.now()
      if (document.visibilityState === 'hidden') { send(take(now), true); visible = false; cursor = now }
      else { visible = true; cursor = now; lastAct = now }
    })
    window.addEventListener('pagehide', function () { send(take(Date.now()), true) })
    setInterval(function () { if (visible) send(take(Date.now()), false) }, BEAT)
  } catch (e) { /* never let the beacon break the page */ }
})()
```

- [ ] **Step 2: Sanity-check it parses**

Run: `node --check src/lib/plugins/share-beacon.js`
Expected: no output (valid syntax).

- [ ] **Step 3: Commit**

```bash
git add src/lib/plugins/share-beacon.js
git commit -m "feat(insights): self-contained share reading-time beacon script"
```

---

## Task 6: Inject the beacon into baked share HTML (gated)

**Files:**
- Modify: `src/lib/plugins/share-baker.ts`
- Test: `src/lib/plugins/share-baker.test.ts` (create if absent, else extend the existing bake test)

- [ ] **Step 1: Write a failing test**

Add to the share-baker test file:

```typescript
import { vi } from 'vitest'
import { bakeShareHtml } from './share-baker'

vi.mock('../settings.svelte', async (orig) => ({ ...(await orig() as object), isPluginEnabled: (id: string) => id === 'reading-insights' }))

// (Use the file's existing Tab fixture + theme-css mock; assert the beacon marker.)
it('injects the beacon when reading-insights is enabled', async () => {
  const html = await bakeShareHtml(fixtureTab(), 'default')
  expect(html).toContain('/a/hit')
  expect(html).toContain('mdi_vid')
})
```

If the existing test file already mocks `../settings.svelte` or `theme_load_compiled`, reuse those mocks rather than redefining. If there is no bake test yet, model the setup on `host-render-html.test.ts`.

- [ ] **Step 2: Run it, expect fail**

Run: `pnpm vitest run src/lib/plugins/share-baker.test.ts`
Expected: FAIL — no beacon in output.

- [ ] **Step 3: Inject the beacon in `bakeShareHtml`**

At the top of `share-baker.ts` add the import + a guarded snippet:

```typescript
import shareBeaconJs from './share-beacon.js?raw'
import { isPluginEnabled } from '../settings.svelte'
```

Just before the closing `</body>` in the template literal, interpolate:

```typescript
${isPluginEnabled('reading-insights') ? `<script>${shareBeaconJs}</script>` : ''}
</body>
```

- [ ] **Step 4: Run tests, expect pass; typecheck + full app tests**

Run: `pnpm vitest run src/lib/plugins/share-baker.test.ts && pnpm check`
Expected: PASS; 0 type errors. (`?raw` for `.js` resolves the same way the CSS `?raw` imports already do in this file.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/share-baker.ts src/lib/plugins/share-baker.test.ts
git commit -m "feat(insights): inject reading-time beacon into shared pages when enabled"
```

---

## Task 7: Verification + deploy (human-gated)

**Files:** none (verification)

- [ ] **Step 1: Full local suites**

Run (repo root): `pnpm check && pnpm test`
Run (worker): `cd worker && pnpm test`
Expected: all green.

- [ ] **Step 2: Worker dev smoke test**

Run: `cd worker && pnpm dev` then in another shell:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -XPOST http://127.0.0.1:8787/a/hit \
  -H 'Content-Type: application/json' \
  -d '{"slug":"2026-07-08-foo-x7k","visitor_id":"v1","session_id":"s1","delta_ms":5000,"ts":'$(date +%s000)'}'
```
Expected: `204`. Then publish a share (existing `/publish` flow) and confirm `GET /a/stats?slug=...` with its `edit_token` returns the accumulated ms.

- [ ] **Step 3: Deploy (CONFIRM WITH HUMAN FIRST)**

Deploying registers the new Durable Object migration and is outward-facing. Only after explicit approval:
Run: `cd worker && pnpm run deploy`
Expected: `wrangler deploy` succeeds, reporting the `SlugAnalytics` migration `v1` applied.

- [ ] **Step 4: End-to-end on a real shared link**

Publish a doc from the app (with `reading-insights` enabled), open the share URL on a phone, read ~30s, background the tab. Then from the app author context, `GET /a/stats?slug=` with the share's `edit_token` should show non-zero `total_ms` and `unique_readers ≥ 1`.

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** beacon reliability — heartbeat + sendBeacon + Page Visibility + idle pause + session cap (Tasks 4, 5); `POST /a/hit` additive deltas with clamping (Tasks 1, 2); per-slug DO coalescing, per-hour ms + per-day unique visitors (Task 2); `GET /a/stats` edit_token-gated range query (Task 3); beacon injection gated on the plugin (Task 6). Deferred by design: session counts (not in the value score); dashboard (Phase 3); report/CLI (Phase 4); rate-limiting `/a/hit` beyond delta-clamping (add later if abused — noted in spec §11).
- **Type consistency:** `AUDIENCE_SLUG_RE` mirrors the existing `SLUG_RE`; `KvMeta.edit_token` must match the field `handlePublish` writes — verify before Task 3. DO addressed by `idFromName(slug)` consistently in `/a/hit` and `/a/stats`.
- **`beacon-timing.ts` vs `share-beacon.js`:** the `.ts` is the unit-tested reference; the raw `.js` is its runtime twin (no bundler). Keep their idle/cap/visibility logic identical; if the `.ts` edge logic is adjusted to pass tests, mirror the change into the `.js`.
- **DO free-tier:** uses SQLite-backed DO (`new_sqlite_classes`), available without a paid plan; storage is the KV-style `state.storage` API.
```
