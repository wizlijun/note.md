# Reading Insights — Phase 3: Dashboard + Value Score — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the user a panel to see, per markdown file over a chosen date range, their own engagement (read/edit time, edit sessions, mark ops — merged across their devices) plus the audience engagement of shared docs (reading time, unique readers), combined into a transparent, sortable "value" score.

**Architecture:** A pure value-score + date-preset module; an audience stats client that calls the deployed Worker's `GET /a/stats` per share slug (authenticated with the share's own `edit_token`); a data-assembly layer that reads the git-synced per-day analytics files (reusing Phase 1's store + merge/aggregate), joins them with audience stats via existing share records (path↔slug↔edit_token), and produces sortable rows; and an `InsightsPanel.svelte` mounted as a gated tab in the existing Settings dialog.

**Tech Stack:** TypeScript, Svelte 5 runes, Vitest + happy-dom. Reuses Phase 1 `src/lib/insights/{model,merge,store}` and `src/lib/share/records`.

**Scope note:** Phase 3 of 4. Ships the viewing dashboard + value score. It does NOT build the daily-report markdown generator or CLI (Phase 4). No new backend. Audience data is read-only here (collected/deployed in Phase 2).

**Gating:** every surface is shown only when `isPluginEnabled('reading-insights') && sotvaultStore.vaultRoot !== null` (same rule as Phase 1).

---

## File Structure

**New:**
- `src/lib/insights/value.ts` + `value.test.ts` — pure value score + date-range presets.
- `src/lib/insights/audience.ts` + `audience.test.ts` — `GET /a/stats` client (per slug, edit_token auth), keyed by docKey.
- `src/lib/insights/dashboard.svelte.ts` + `dashboard.test.ts` — assemble sortable rows (owner merge/aggregate + audience join + value).
- `src/components/InsightsPanel.svelte` — the UI (date presets + sortable table + per-row device breakdown).

**Modified:**
- `src/lib/insights/tracker.svelte.ts` — export `flushNow()` so the panel persists unflushed session data before reading.
- `src/lib/insights/store.svelte.ts` — export a standalone `readMergedAnalytics(fs, vaultRoot, deviceId, deviceName)` OR reuse `createAnalyticsStore(...).readAllDevices()` from the panel (Task 3 decides — no store change if reuse suffices).
- `src/components/SettingsDialog.svelte` — add a gated "Insights" tab rendering `InsightsPanel`.
- `src/lib/i18n/{en,zh,ja}.ts` — panel strings.

---

## Task 1: Value score + date-range presets (pure)

**Files:** Create `src/lib/insights/value.ts`, `src/lib/insights/value.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import { valueScore, DEFAULT_WEIGHTS, presetRange, type ValueInputs } from './value'

const base: ValueInputs = { read_ms: 0, edit_ms: 0, edit_sessions: 0, mark_ops: 0, aud_read_ms: 0, unique_readers: 0 }

describe('valueScore', () => {
  it('is 0 for all-zero inputs', () => {
    expect(valueScore(base, DEFAULT_WEIGHTS)).toBe(0)
  })
  it('increases with reading time (log-damped, monotonic)', () => {
    const a = valueScore({ ...base, read_ms: 60_000 }, DEFAULT_WEIGHTS)
    const b = valueScore({ ...base, read_ms: 600_000 }, DEFAULT_WEIGHTS)
    expect(b).toBeGreaterThan(a)
    expect(a).toBeGreaterThan(0)
  })
  it('weights unique readers and edits above raw read time', () => {
    const readOnly = valueScore({ ...base, read_ms: 600_000 }, DEFAULT_WEIGHTS)
    const readers = valueScore({ ...base, unique_readers: 10 }, DEFAULT_WEIGHTS)
    expect(readers).toBeGreaterThan(0)
    // sanity: a doc with edits + readers scores higher than one with only reading
    const rich = valueScore({ ...base, read_ms: 600_000, edit_ms: 300_000, mark_ops: 5, unique_readers: 10 }, DEFAULT_WEIGHTS)
    expect(rich).toBeGreaterThan(readOnly)
  })
})

describe('presetRange', () => {
  // Anchor "now" = 2026-07-08 15:00 local (tz offset +480 → same UTC day for these).
  const now = Date.UTC(2026, 6, 8, 7, 0)
  const tz = 480
  it('today → single day', () => {
    expect(presetRange('today', now, tz)).toEqual({ from: '2026-07-08', to: '2026-07-08' })
  })
  it('yesterday → single prior day', () => {
    expect(presetRange('yesterday', now, tz)).toEqual({ from: '2026-07-07', to: '2026-07-07' })
  })
  it('7d → inclusive last 7 days ending today', () => {
    expect(presetRange('7d', now, tz)).toEqual({ from: '2026-07-02', to: '2026-07-08' })
  })
  it('30d → inclusive last 30 days', () => {
    expect(presetRange('30d', now, tz)).toEqual({ from: '2026-06-09', to: '2026-07-08' })
  })
  it('month → first of month to today', () => {
    expect(presetRange('month', now, tz)).toEqual({ from: '2026-07-01', to: '2026-07-08' })
  })
})
```

- [ ] **Step 2: Run, expect fail.** `pnpm vitest run src/lib/insights/value.test.ts`

- [ ] **Step 3: Implement `src/lib/insights/value.ts`**

```typescript
import { dayKey } from './model'

export interface ValueInputs {
  read_ms: number
  edit_ms: number
  edit_sessions: number
  mark_ops: number
  aud_read_ms: number
  unique_readers: number
}

export interface ValueWeights {
  read: number; edit: number; sessions: number; marks: number; audRead: number; readers: number
}

/** Reasonable defaults; edits + unique readers weigh above raw reading. Tunable later. */
export const DEFAULT_WEIGHTS: ValueWeights = {
  read: 1, edit: 1.5, sessions: 0.5, marks: 0.3, audRead: 1, readers: 2,
}

const log1p = (x: number) => Math.log1p(Math.max(0, x))
const min = (ms: number) => ms / 60_000

/** Transparent, log-damped composite so no single dimension dominates. */
export function valueScore(i: ValueInputs, w: ValueWeights): number {
  return (
    w.read * log1p(min(i.read_ms)) +
    w.edit * log1p(min(i.edit_ms)) +
    w.sessions * i.edit_sessions +
    w.marks * i.mark_ops +
    w.audRead * log1p(min(i.aud_read_ms)) +
    w.readers * log1p(i.unique_readers)
  )
}

export type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'month'

function addDays(day: string, delta: number): string {
  const ms = Date.parse(day + 'T00:00:00Z') + delta * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

/** Resolve a preset to an inclusive [from, to] day-key range in the device's tz. */
export function presetRange(preset: Preset, now: number, tzOffsetMinutes: number): { from: string; to: string } {
  const today = dayKey(now, tzOffsetMinutes)
  switch (preset) {
    case 'today': return { from: today, to: today }
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y } }
    case '7d': return { from: addDays(today, -6), to: today }
    case '30d': return { from: addDays(today, -29), to: today }
    case 'month': return { from: today.slice(0, 8) + '01', to: today }
  }
}
```

- [ ] **Step 4: Run, expect pass.** **Step 5: Commit** `feat(insights): value score + date-range presets`.

---

## Task 2: Audience stats client (`GET /a/stats`)

**Files:** Create `src/lib/insights/audience.ts`, `src/lib/insights/audience.test.ts`

Fetches audience aggregates for a slug from `<baseUrl>/a/stats?slug=&from=&to=` with `Authorization: Bearer <edit_token>`. `from`/`to` are epoch-ms derived from the day range. Returns `{ total_ms, unique_readers, days }` or null on any error (fail-soft — audience is optional).

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAudienceStats, dayRangeToEpoch } from './audience'

afterEach(() => vi.restoreAllMocks())

describe('dayRangeToEpoch', () => {
  it('spans from start-of-from-day to end-of-to-day (UTC)', () => {
    const { from, to } = dayRangeToEpoch('2026-07-08', '2026-07-08')
    expect(from).toBe(Date.UTC(2026, 6, 8, 0, 0, 0, 0))
    expect(to).toBe(Date.UTC(2026, 6, 8, 23, 59, 59, 999))
  })
})

describe('fetchAudienceStats', () => {
  it('calls /a/stats with slug, range, and bearer token', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ total_ms: 5000, unique_readers: 2, days: { '2026-07-08': 5000 } }), { status: 200 }),
    )
    const out = await fetchAudienceStats('https://w.example/', 'tok', '2026-07-08-foo-x7k', '2026-07-08', '2026-07-08')
    expect(out).toEqual({ total_ms: 5000, unique_readers: 2, days: { '2026-07-08': 5000 } })
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toContain('https://w.example/a/stats?slug=2026-07-08-foo-x7k')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' })
  })
  it('returns null on a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 403 }))
    expect(await fetchAudienceStats('https://w/', 't', '2026-07-08-foo-x7k', '2026-07-08', '2026-07-08')).toBeNull()
  })
  it('returns null on a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    expect(await fetchAudienceStats('https://w/', 't', '2026-07-08-foo-x7k', '2026-07-08', '2026-07-08')).toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement `src/lib/insights/audience.ts`**

```typescript
export interface AudienceStats {
  total_ms: number
  unique_readers: number
  days: Record<string, number>
}

/** Inclusive day range → epoch-ms [start-of-from, end-of-to] in UTC. */
export function dayRangeToEpoch(fromDay: string, toDay: string): { from: number; to: number } {
  return {
    from: Date.parse(fromDay + 'T00:00:00.000Z'),
    to: Date.parse(toDay + 'T23:59:59.999Z'),
  }
}

/** Fetch audience aggregates for one shared slug. Fail-soft: returns null on any error. */
export async function fetchAudienceStats(
  baseUrl: string,
  editToken: string,
  slug: string,
  fromDay: string,
  toDay: string,
): Promise<AudienceStats | null> {
  try {
    const base = baseUrl.replace(/\/+$/, '')
    const { from, to } = dayRangeToEpoch(fromDay, toDay)
    const url = `${base}/a/stats?slug=${encodeURIComponent(slug)}&from=${from}&to=${to}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${editToken}` } })
    if (!res.ok) return null
    return (await res.json()) as AudienceStats
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run, expect pass.** **Step 5: Commit** `feat(insights): audience /a/stats client (fail-soft)`.

---

## Task 3: Dashboard data assembly

**Files:** Create `src/lib/insights/dashboard.svelte.ts`, `src/lib/insights/dashboard.test.ts`

Assembles sortable rows for a date range: owner counters (merged across devices, aggregated over range) joined with audience stats per shared doc, plus the value score. Dependencies are injected so it is unit-testable without Tauri/network.

Row shape:
```typescript
export interface InsightRow {
  docKey: string
  label: string          // filename for display
  path: string | null    // absolute path (resolved), or null
  read_ms: number; edit_ms: number; edit_sessions: number; mark_ops: number; net_chars: number
  aud_read_ms: number; unique_readers: number
  shared: boolean
  value: number
}
```

- [ ] **Step 1: Write failing tests** (inject a fake owner-reader, a fake share-record resolver, and a fake audience fetcher)

```typescript
import { describe, it, expect } from 'vitest'
import { assembleRows, type AssembleDeps } from './dashboard.svelte'
import { emptyCounters, type DeviceAnalytics } from './model'
import { DEFAULT_WEIGHTS } from './value'

function deps(over: Partial<AssembleDeps> = {}): AssembleDeps {
  return {
    readDevices: async (): Promise<DeviceAnalytics[]> => [{
      deviceId: 'D1', deviceName: 'Mac',
      docs: {
        'rel:a.md': { '2026-07-08': { ...emptyCounters(0), read_ms: 120_000, edit_ms: 60_000, mark_ops: 3, edit_sessions: 2, net_chars: 40 } },
        'abs:/tmp/b.md': { '2026-07-08': { ...emptyCounters(0), read_ms: 30_000 } },
      },
    }],
    resolveShare: (docKey) => docKey === 'rel:a.md'
      ? { path: '/v/a.md', label: 'a.md', slug: '2026-07-08-a-x', editToken: 'tok' }
      : { path: '/tmp/b.md', label: 'b.md', slug: null, editToken: null },
    fetchAudience: async (slug) => slug === '2026-07-08-a-x'
      ? { total_ms: 90_000, unique_readers: 4, days: {} } : null,
    baseUrl: 'https://w/',
    weights: DEFAULT_WEIGHTS,
    ...over,
  }
}

describe('assembleRows', () => {
  it('merges owner data, joins audience for shared docs, sorts by value desc', async () => {
    const rows = await assembleRows(deps(), '2026-07-08', '2026-07-08')
    expect(rows.map((r) => r.docKey)).toEqual(['rel:a.md', 'abs:/tmp/b.md']) // a.md richer → first
    const a = rows[0]
    expect(a.read_ms).toBe(120_000)
    expect(a.aud_read_ms).toBe(90_000)
    expect(a.unique_readers).toBe(4)
    expect(a.shared).toBe(true)
    expect(a.value).toBeGreaterThan(rows[1].value)
    // b.md unshared → no audience
    expect(rows[1].aud_read_ms).toBe(0)
    expect(rows[1].shared).toBe(false)
  })

  it('omits docs with no activity in the range', async () => {
    const rows = await assembleRows(deps(), '2026-07-01', '2026-07-02')
    expect(rows).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement `src/lib/insights/dashboard.svelte.ts`**

```typescript
import { mergeDeviceAnalytics, aggregateRange } from './merge'
import { valueScore, type ValueWeights } from './value'
import { fetchAudienceStats, type AudienceStats } from './audience'
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
  fetchAudience: (slug: string, editToken: string, from: string, to: string, baseUrl: string) => Promise<AudienceStats | null>
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

export async function assembleRows(deps: AssembleDeps, fromDay: string, toDay: string): Promise<InsightRow[]> {
  const devices = await deps.readDevices()
  const merged = mergeDeviceAnalytics(devices)
  const owner = aggregateRange(merged, fromDay, toDay)

  const rows = await Promise.all(Object.entries(owner).map(async ([docKey, c]) => {
    const share = deps.resolveShare(docKey)
    let aud: AudienceStats | null = null
    if (share.slug && share.editToken) {
      aud = await deps.fetchAudience(share.slug, share.editToken, fromDay, toDay, deps.baseUrl)
    }
    const aud_read_ms = aud?.total_ms ?? 0
    const unique_readers = aud?.unique_readers ?? 0
    const value = valueScore(
      { read_ms: c.read_ms, edit_ms: c.edit_ms, edit_sessions: c.edit_sessions, mark_ops: c.mark_ops, aud_read_ms, unique_readers },
      deps.weights,
    )
    return {
      docKey, label: share.label, path: share.path,
      read_ms: c.read_ms, edit_ms: c.edit_ms, edit_sessions: c.edit_sessions, mark_ops: c.mark_ops, net_chars: c.net_chars,
      aud_read_ms, unique_readers, shared: !!share.slug, value,
    } satisfies InsightRow
  }))

  return rows.sort((a, b) => b.value - a.value)
}
```

- [ ] **Step 4: Run, expect pass.** **Step 5: Commit** `feat(insights): dashboard row assembly (owner+audience join, value sort)`.

---

## Task 4: `InsightsPanel.svelte`

**Files:** Create `src/components/InsightsPanel.svelte`; modify `src/lib/insights/tracker.svelte.ts` (export `flushNow`).

- [ ] **Step 1: Add `flushNow` to the tracker**

In `tracker.svelte.ts` add an export that flushes the live store if the tracker is installed (so the panel reflects the current session):

```typescript
export async function flushNow(): Promise<void> {
  if (tracker) await tracker.store.flush()
}
```

- [ ] **Step 2: Build the panel**

`src/components/InsightsPanel.svelte` (Svelte 5 runes). Responsibilities:
- On mount / when shown: `await flushNow()`, then build the real `AssembleDeps` and call `assembleRows` for the selected range.
- Real deps:
  - `readDevices`: create a read-only store `createAnalyticsStore({ fs: <plugin-fs adapter>, vaultRoot: () => sotvaultStore.vaultRoot, deviceId: getDeviceId(), deviceName: '', tzOffsetMinutes: localTzOffsetMinutes() })` and call `.readAllDevices()`. (Reuse the same `fs` adapter object shape the tracker builds; export it from tracker or duplicate the 5-line adapter.)
  - `resolveShare(docKey)`: strip the `rel:`/`abs:` prefix; for `rel:` prepend `sotvaultStore.vaultRoot + '/'`; `label` = basename; look up `getRecord(absPath)` (from `../lib/share/records`) → `{ slug, edit_token }` (null if unshared).
  - `fetchAudience`: `fetchAudienceStats(baseUrl, editToken, slug, from, to)`.
  - `baseUrl`: `getPluginScopedKey('share.baseUrl')` (empty → audience skipped, rows still show owner data).
  - `weights`: `DEFAULT_WEIGHTS` (Phase 3 keeps defaults; a settings-driven override is a later nicety).
- UI:
  - A preset row: buttons Today / Yesterday / 7d / 30d / Month (i18n) that set the range via `presetRange(preset, Date.now(), localTzOffsetMinutes())`, plus two `<input type="date">` for a custom from/to.
  - A table: columns Doc, Read, Edit, Sessions, Marks, Aud. time, Readers, Value. Format ms as `Xm Ys` / `Xh Ym`. Rows sortable by clicking a column header (default: Value desc). Clicking a row toggles a detail sub-row showing per-device breakdown (read from the same merged devices — group the doc's counters by deviceId).
  - Empty state when no rows in range.
  - Loading state while assembling.
- Keep it presentational; all data logic lives in the Task 1–3 modules. Reuse existing table/list styles from the codebase where possible (e.g. the spreadsheet or folder-view styles) — match the app's visual language.

- [ ] **Step 3: i18n** — add `insights.*` keys (title, presets, column headers, empty state) to `src/lib/i18n/{en,zh,ja}.ts`.

- [ ] **Step 4: Typecheck** `pnpm check` → 0 errors. **Step 5: Commit** `feat(insights): reading-insights dashboard panel`.

---

## Task 5: Mount the panel as a gated Settings tab

**Files:** Modify `src/components/SettingsDialog.svelte`, i18n.

- [ ] **Step 1:** In `SettingsDialog.svelte`, import `InsightsPanel`, `isPluginEnabled`, `sotvaultStore`. Add a tab button in the `.tab-strip`, gated:

```svelte
{#if isPluginEnabled('reading-insights') && sotvaultStore.vaultRoot !== null}
  <button class:active={selectedTab === 'insights'} onclick={() => selectedTab = 'insights'}>{t('settings.tab.insights')}</button>
{/if}
```

And in the content area (next to the other `{#if selectedTab === ...}` blocks):

```svelte
{#if selectedTab === 'insights'}
  <InsightsPanel />
{/if}
```

- [ ] **Step 2:** Add `settings.tab.insights` to `src/lib/i18n/{en,zh,ja}.ts` (e.g. "Insights" / "阅读洞察" / "インサイト").

- [ ] **Step 3: Verify** `pnpm check && pnpm test` → green. **Step 4: Commit** `feat(insights): add gated Insights tab to Settings`.

---

## Task 6: Verification

- [ ] **Step 1:** `pnpm check && pnpm test` (repo) → all green.
- [ ] **Step 2: Manual (human):** open Settings (⌘,) with the plugin enabled + a vault set → an "Insights" tab appears. Pick a range → the table lists docs you read/edited, sorted by value. For a shared doc that has audience hits (from Phase 2), the Aud. time / Readers columns populate. Toggle a row → per-device breakdown. With no vault or plugin disabled → the tab is absent.

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** date presets today/yesterday/7d/30d/month + custom range (Tasks 1, 4); per-md rows merging owner devices + audience, source-attributed (Task 3); sortable columns + per-device detail (Task 4); value score, log-damped + tunable defaults (Task 1); gated everywhere (Tasks 4, 5). Deferred by design: report md + CLI (Phase 4); weight-editing UI (defaults only here).
- **Type consistency:** `AudienceStats` (Task 2) is consumed by `AssembleDeps.fetchAudience` and `assembleRows` (Task 3); `ValueInputs`/`ValueWeights`/`DEFAULT_WEIGHTS` (Task 1) used in Task 3; `InsightRow` (Task 3) is the panel's row type (Task 4). `readAllDevices()` from Phase 1's store returns `DeviceAnalytics[]` — matches `AssembleDeps.readDevices`.
- **Fail-soft audience:** if `share.baseUrl` is unset or `/a/stats` errors, `fetchAudience` returns null and rows show owner-only data (never blocks the panel).
- **Freshness:** the panel calls `flushNow()` before reading so the current session's unflushed accruals are on disk before `readAllDevices()`.
```
