# Reading Insights — Phase 1: App-Side Collection + Sotvault Storage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect the document owner's engagement (read/edit dwell time, edit sessions, net characters, mark operations) per markdown file, bucketed by local calendar day, and persist it to the git-synced sotvault as one JSON file per device — gated behind a new `reading-insights` builtin plugin that is only selectable once a vault is configured.

**Architecture:** Pure-logic core (day-bucket model, a deterministic timing reducer, cross-device merge) is unit-tested with an injected clock. A thin tracker wires Tauri window focus/blur, the active tab, an idle timer, and a ProseMirror observer plugin (mounted via `view.state.reconfigure`) into the reducer, then flushes accumulated counters to `sotvault/.mdeditor/analytics/<device_id>.json` using the exact per-device-file pattern that `recent-sync.svelte.ts` already uses. Plugin gating adds an `available_when` manifest field plus a `vaultConfigured` flag in the enabled-when evaluation context.

**Tech Stack:** TypeScript, Svelte 5 runes (`$state`), Vitest + happy-dom, ProseMirror (`prosemirror-state`, `prosemirror-transform`, `prosemirror-view`), `@moraya/core` (read-only use of `instance.view`), Tauri plugin-fs / plugin-os / window events.

**Scope note:** This is Phase 1 of 4. It ships working, testable owner-side collection with no UI beyond the plugin toggle. Later phases (own plans): Phase 2 web beacon + Cloudflare Worker aggregation; Phase 3 insights dashboard UI + value score; Phase 4 daily-report generation + CLI. `mark_ops` is fully implemented here (owner side); audience metrics arrive in Phase 2.

---

## File Structure

**New files:**
- `src/lib/insights/model.ts` — types (`DayCounters`, `DeviceAnalytics`), `dayKey`, `docKeyFor`, `emptyCounters`, `sumCounters`.
- `src/lib/insights/model.test.ts`
- `src/lib/insights/timing.ts` — pure timing reducer (`activeNow`, `applyEvent`, `IDLE_MS`).
- `src/lib/insights/timing.test.ts`
- `src/lib/insights/merge.ts` — `mergeDeviceAnalytics`, `aggregateRange` (date-range rollup per doc).
- `src/lib/insights/merge.test.ts`
- `src/lib/insights/observer.ts` — `countMarkSteps`, `analyticsObserverPlugin` (ProseMirror plugin emitting mark-op + doc-size deltas).
- `src/lib/insights/observer.test.ts`
- `src/lib/insights/store.svelte.ts` — in-memory current-doc accumulator + read/write of this device's JSON file in sotvault.
- `src/lib/insights/store.test.ts`
- `src/lib/insights/tracker.svelte.ts` — event wiring (focus/blur, tab, idle tick, editor observer, mode) → reducer → store.
- `src-tauri/plugins/reading-insights/manifest.json` — builtin plugin manifest.

**Modified files:**
- `src/lib/plugins/types.ts` — add `available_when?: string` to `PluginManifest`; add `vaultConfigured: boolean` to `EnabledWhenContext`.
- `src/lib/plugins/enabled-when.test.ts` — cover a bare `vaultConfigured` identifier at context root.
- `src/lib/plugins/enabled-when.ts` — `lookup` already resolves root-level identifiers; add a test only if a gap is found (see Task 8).
- Wherever `EnabledWhenContext` is constructed for the settings UI (discovered in Task 8) — populate `vaultConfigured`.
- `src/components/PluginsSettingsTab.svelte` — gray out / disable the toggle when `available_when` is unmet; wire the vault-first-set auto-enable.
- `src/lib/editor-bridge.ts` — after `coreCreateEditor`, reconfigure the view with the analytics observer plugin and hand the editor to the tracker.
- `src/App.svelte` (or the existing app-mount site discovered in Task 11) — install/uninstall the tracker on mount.

---

## Task 1: Day-bucket model + doc key

**Files:**
- Create: `src/lib/insights/model.ts`
- Test: `src/lib/insights/model.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/insights/model.test.ts
import { describe, it, expect } from 'vitest'
import { dayKey, docKeyFor, emptyCounters, sumCounters, type DayCounters } from './model'

describe('dayKey', () => {
  it('formats a local calendar day as YYYY-MM-DD using the given tz offset', () => {
    // 2026-07-08 07:30 UTC. At UTC+8 that is 2026-07-08 15:30 local → same day.
    const ms = Date.UTC(2026, 6, 8, 7, 30)
    expect(dayKey(ms, 8 * 60)).toBe('2026-07-08')
  })

  it('rolls to the next local day when the tz offset pushes past midnight', () => {
    // 2026-07-08 17:00 UTC. At UTC+8 that is 2026-07-09 01:00 local → next day.
    const ms = Date.UTC(2026, 6, 8, 17, 0)
    expect(dayKey(ms, 8 * 60)).toBe('2026-07-09')
  })

  it('rolls to the previous local day for negative offsets', () => {
    // 2026-07-08 02:00 UTC. At UTC-5 that is 2026-07-07 21:00 local → previous day.
    const ms = Date.UTC(2026, 6, 8, 2, 0)
    expect(dayKey(ms, -5 * 60)).toBe('2026-07-07')
  })
})

describe('docKeyFor', () => {
  it('returns a vault-relative key for files under the vault', () => {
    expect(docKeyFor('/Users/x/vault/notes/a.md', '/Users/x/vault')).toBe('rel:notes/a.md')
  })

  it('handles a trailing slash on the vault root', () => {
    expect(docKeyFor('/Users/x/vault/a.md', '/Users/x/vault/')).toBe('rel:a.md')
  })

  it('returns an absolute key for files outside the vault (or when no vault)', () => {
    expect(docKeyFor('/tmp/a.md', '/Users/x/vault')).toBe('abs:/tmp/a.md')
    expect(docKeyFor('/tmp/a.md', null)).toBe('abs:/tmp/a.md')
  })
})

describe('sumCounters', () => {
  it('adds numeric fields, keeps min first_seen_at and max last_active_at', () => {
    const a: DayCounters = { ...emptyCounters(100), read_ms: 10, mark_ops: 1, first_seen_at: 100, last_active_at: 200 }
    const b: DayCounters = { ...emptyCounters(50), read_ms: 5, mark_ops: 2, first_seen_at: 50, last_active_at: 300 }
    const s = sumCounters(a, b)
    expect(s.read_ms).toBe(15)
    expect(s.mark_ops).toBe(3)
    expect(s.first_seen_at).toBe(50)
    expect(s.last_active_at).toBe(300)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/insights/model.test.ts`
Expected: FAIL — cannot find module `./model`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/insights/model.ts

/** Per-document, per-day owner engagement counters. */
export interface DayCounters {
  read_ms: number
  edit_ms: number
  open_count: number
  edit_sessions: number
  net_chars: number
  mark_ops: number
  first_seen_at: number
  last_active_at: number
}

/** docKey -> "YYYY-MM-DD" -> counters. */
export type DocDays = Record<string, Record<string, DayCounters>>

/** One device's synced analytics file. */
export interface DeviceAnalytics {
  deviceId: string
  deviceName: string
  docs: DocDays
}

/**
 * Local calendar day (YYYY-MM-DD) for an epoch-ms timestamp, given the device's
 * timezone offset in minutes east of UTC (e.g. UTC+8 → 480). Buckets are the
 * device's LOCAL day so "yesterday" in the report layer lines up with the
 * user's wall clock.
 */
export function dayKey(ms: number, tzOffsetMinutes: number): string {
  const shifted = new Date(ms + tzOffsetMinutes * 60_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** The device's current timezone offset in minutes east of UTC. */
export function localTzOffsetMinutes(now = new Date()): number {
  // Date#getTimezoneOffset is minutes WEST of UTC; negate for east-of-UTC.
  return -now.getTimezoneOffset()
}

function stripTrailingSlash(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p
}

/**
 * Stable cross-device key for a document. Files under the vault get a
 * vault-relative `rel:` key (identical on every device); everything else gets an
 * absolute `abs:` key (device-local, will not collide across devices).
 */
export function docKeyFor(absPath: string, vaultRoot: string | null): string {
  if (vaultRoot) {
    const root = stripTrailingSlash(vaultRoot)
    if (absPath === root) return `abs:${absPath}`
    if (absPath.startsWith(root + '/')) return `rel:${absPath.slice(root.length + 1)}`
  }
  return `abs:${absPath}`
}

export function emptyCounters(nowMs: number): DayCounters {
  return {
    read_ms: 0,
    edit_ms: 0,
    open_count: 0,
    edit_sessions: 0,
    net_chars: 0,
    mark_ops: 0,
    first_seen_at: nowMs,
    last_active_at: nowMs,
  }
}

/** Combine two counter sets: sum totals, min first_seen_at, max last_active_at. */
export function sumCounters(a: DayCounters, b: DayCounters): DayCounters {
  return {
    read_ms: a.read_ms + b.read_ms,
    edit_ms: a.edit_ms + b.edit_ms,
    open_count: a.open_count + b.open_count,
    edit_sessions: a.edit_sessions + b.edit_sessions,
    net_chars: a.net_chars + b.net_chars,
    mark_ops: a.mark_ops + b.mark_ops,
    first_seen_at: Math.min(a.first_seen_at, b.first_seen_at),
    last_active_at: Math.max(a.last_active_at, b.last_active_at),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/insights/model.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/insights/model.ts src/lib/insights/model.test.ts
git commit -m "feat(insights): day-bucket model, doc key, counter sum"
```

---

## Task 2: Timing reducer (read/edit dwell, idle pause)

**Files:**
- Create: `src/lib/insights/timing.ts`
- Test: `src/lib/insights/timing.test.ts`

The reducer is pure: given a state, an event, and `now` (ms), it returns the new state plus any `accrued` dwell (which mode, how many ms) to add to the current day bucket. Time only accrues while `appFocused && tabActive && !idle`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/insights/timing.test.ts
import { describe, it, expect } from 'vitest'
import { initTiming, applyEvent, activeNow, IDLE_MS } from './timing'

describe('activeNow', () => {
  it('is true only when focused, tab active, and not idle', () => {
    expect(activeNow({ appFocused: true, tabActive: true, idle: false })).toBe(true)
    expect(activeNow({ appFocused: false, tabActive: true, idle: false })).toBe(false)
    expect(activeNow({ appFocused: true, tabActive: false, idle: false })).toBe(false)
    expect(activeNow({ appFocused: true, tabActive: true, idle: true })).toBe(false)
  })
})

describe('applyEvent', () => {
  it('accrues nothing until the session becomes active', () => {
    let s = initTiming(1000, 'read')
    const r = applyEvent(s, { type: 'focus' }, 1000)
    expect(r.accrued).toBeNull()
    expect(activeNow(r.state.presence)).toBe(false) // tab not active yet
  })

  it('accrues read ms from active-start to blur', () => {
    let s = initTiming(1000, 'read')
    s = applyEvent(s, { type: 'focus' }, 1000).state
    s = applyEvent(s, { type: 'tabActive' }, 1000).state // now active
    const r = applyEvent(s, { type: 'blur' }, 4000)
    expect(r.accrued).toEqual({ mode: 'read', ms: 3000 })
  })

  it('attributes time to the mode that was in effect while active', () => {
    let s = initTiming(0, 'read')
    s = applyEvent(s, { type: 'focus' }, 0).state
    s = applyEvent(s, { type: 'tabActive' }, 0).state
    // Switch to edit mode at t=2000: flush the 2000ms of read first.
    const sw = applyEvent(s, { type: 'mode', mode: 'edit' }, 2000)
    expect(sw.accrued).toEqual({ mode: 'read', ms: 2000 })
    s = sw.state
    const r = applyEvent(s, { type: 'blur' }, 5000)
    expect(r.accrued).toEqual({ mode: 'edit', ms: 3000 })
  })

  it('goes idle on a tick past IDLE_MS with no activity, accruing up to the last activity', () => {
    let s = initTiming(0, 'read')
    s = applyEvent(s, { type: 'focus' }, 0).state
    s = applyEvent(s, { type: 'tabActive' }, 0).state
    s = applyEvent(s, { type: 'activity' }, 0).state // active, lastActivity=0
    // Tick after IDLE_MS with no activity → pause. Accrue only up to lastActivity.
    const r = applyEvent(s, { type: 'tick' }, IDLE_MS + 5000)
    expect(r.state.presence.idle).toBe(true)
    expect(r.accrued).toEqual({ mode: 'read', ms: 0 }) // lastActivity was 0, active start was 0
  })

  it('resumes from idle on activity and accrues from the resume moment', () => {
    let s = initTiming(0, 'read')
    s = applyEvent(s, { type: 'focus' }, 0).state
    s = applyEvent(s, { type: 'tabActive' }, 0).state
    s = applyEvent(s, { type: 'activity' }, 0).state
    s = applyEvent(s, { type: 'tick' }, IDLE_MS + 1000).state // idle now
    s = applyEvent(s, { type: 'activity' }, 20000).state       // resume at 20000
    const r = applyEvent(s, { type: 'blur' }, 23000)
    expect(r.accrued).toEqual({ mode: 'read', ms: 3000 })
  })

  it('checkpoints on tick while active, resetting the active-start to now', () => {
    let s = initTiming(0, 'read')
    s = applyEvent(s, { type: 'focus' }, 0).state
    s = applyEvent(s, { type: 'tabActive' }, 0).state
    s = applyEvent(s, { type: 'activity' }, 0).state
    const t = applyEvent(s, { type: 'tick' }, 5000) // still within IDLE_MS
    expect(t.accrued).toEqual({ mode: 'read', ms: 5000 })
    s = t.state
    const r = applyEvent(s, { type: 'blur' }, 8000)
    expect(r.accrued).toEqual({ mode: 'read', ms: 3000 }) // only since the checkpoint
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/insights/timing.test.ts`
Expected: FAIL — cannot find module `./timing`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/insights/timing.ts

/** No user input for this long → stop counting dwell time. */
export const IDLE_MS = 60_000

export type TimingMode = 'read' | 'edit'

export interface Presence {
  appFocused: boolean
  tabActive: boolean
  idle: boolean
}

export interface TimingState {
  presence: Presence
  mode: TimingMode
  /** Epoch ms when the current active stretch began, or null when paused. */
  activeSince: number | null
  /** Epoch ms of the most recent user activity (for idle detection). */
  lastActivity: number
}

export type TimingEvent =
  | { type: 'focus' }
  | { type: 'blur' }
  | { type: 'tabActive' }
  | { type: 'tabInactive' }
  | { type: 'mode'; mode: TimingMode }
  | { type: 'activity' }
  | { type: 'tick' }

export interface Accrued {
  mode: TimingMode
  ms: number
}

export interface ApplyResult {
  state: TimingState
  accrued: Accrued | null
}

export function activeNow(p: Presence): boolean {
  return p.appFocused && p.tabActive && !p.idle
}

export function initTiming(nowMs: number, mode: TimingMode): TimingState {
  return {
    presence: { appFocused: false, tabActive: false, idle: false },
    mode,
    activeSince: null,
    lastActivity: nowMs,
  }
}

/** Non-negative ms between `activeSince` (if set) and `until`, for the old mode. */
function flush(state: TimingState, until: number): Accrued | null {
  if (state.activeSince == null) return null
  const ms = Math.max(0, until - state.activeSince)
  return { mode: state.mode, ms }
}

export function applyEvent(state: TimingState, ev: TimingEvent, now: number): ApplyResult {
  const wasActive = activeNow(state.presence)
  const presence: Presence = { ...state.presence }
  let mode = state.mode
  let lastActivity = state.lastActivity
  // The moment up to which the OLD active stretch should be credited.
  let flushUntil = now

  switch (ev.type) {
    case 'focus': presence.appFocused = true; break
    case 'blur': presence.appFocused = false; break
    case 'tabActive': presence.tabActive = true; break
    case 'tabInactive': presence.tabActive = false; break
    case 'mode': mode = ev.mode; break
    case 'activity':
      lastActivity = now
      presence.idle = false
      break
    case 'tick':
      if (now - state.lastActivity >= IDLE_MS) {
        presence.idle = true
        // Credit only up to the last real activity, not the idle tick.
        flushUntil = Math.min(now, state.lastActivity)
      }
      break
  }

  const accrued = wasActive ? flush(state, flushUntil) : null
  const isActive = activeNow(presence)

  return {
    state: {
      presence,
      mode,
      activeSince: isActive ? now : null,
      lastActivity,
    },
    accrued,
  }
}
```

Note: for the `mode` event the flush uses the OLD `state.mode` (via `flush`, which reads `state.mode`) and the new state carries the new mode — matching the "attributes time to the mode that was in effect" test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/insights/timing.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/insights/timing.ts src/lib/insights/timing.test.ts
git commit -m "feat(insights): pure read/edit dwell timing reducer with idle pause"
```

---

## Task 3: ProseMirror observer — mark ops + doc-size deltas

**Files:**
- Create: `src/lib/insights/observer.ts`
- Test: `src/lib/insights/observer.test.ts`

`countMarkSteps` inspects a transaction's steps for `AddMarkStep` / `RemoveMarkStep` (every mark toggle, regardless of origin — toolbar, menu, autopair). `analyticsObserverPlugin` is a passive ProseMirror plugin: on each applied transaction that changed the doc, it invokes a callback with `{ markOps, sizeDelta }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/insights/observer.test.ts
import { describe, it, expect } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { schema } from 'prosemirror-schema-basic'
import { countMarkSteps, analyticsObserverPlugin, type ObserverDelta } from './observer'

function docState() {
  return EditorState.create({ schema })
}

describe('countMarkSteps', () => {
  it('counts an addMark step as one mark op', () => {
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('hello world')]),
    ]) })
    const tr = state.tr.addMark(1, 6, schema.marks.strong.create())
    expect(countMarkSteps(tr.steps)).toBe(1)
  })

  it('counts a removeMark step as one mark op', () => {
    const withMark = EditorState.create({ schema, doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('hi', [schema.marks.em.create()])]),
    ]) })
    const tr = withMark.tr.removeMark(1, 3, schema.marks.em)
    expect(countMarkSteps(tr.steps)).toBe(1)
  })

  it('counts zero for a plain text insertion', () => {
    const state = docState()
    const tr = state.tr.insertText('abc', 1)
    expect(countMarkSteps(tr.steps)).toBe(0)
  })
})

describe('analyticsObserverPlugin', () => {
  it('reports mark ops and positive size delta as the doc grows', () => {
    const seen: ObserverDelta[] = []
    let state = EditorState.create({ schema, plugins: [analyticsObserverPlugin((d) => seen.push(d))] })
    // Insert text (size grows by 3).
    let tr = state.tr.insertText('abc', 1)
    state = state.apply(tr)
    // Add a mark over it (size unchanged, one mark op).
    tr = state.tr.addMark(1, 4, schema.marks.strong.create())
    state = state.apply(tr)
    expect(seen).toEqual([
      { markOps: 0, sizeDelta: 3 },
      { markOps: 1, sizeDelta: 0 },
    ])
  })

  it('does not fire for a selection-only transaction', () => {
    const seen: ObserverDelta[] = []
    let state = EditorState.create({ schema, doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('abcd')]),
    ]), plugins: [analyticsObserverPlugin((d) => seen.push(d))] })
    const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve(2)))
    state = state.apply(tr)
    expect(seen).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/insights/observer.test.ts`
Expected: FAIL — cannot find module `./observer`. (`prosemirror-schema-basic` is a transitive dep of the ProseMirror packages already in devDependencies; if the import fails to resolve, add it: `pnpm add -D prosemirror-schema-basic`.)

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/insights/observer.ts
import { Plugin } from 'prosemirror-state'
import { AddMarkStep, RemoveMarkStep, type Step } from 'prosemirror-transform'
import type { Transaction } from 'prosemirror-state'

export interface ObserverDelta {
  markOps: number
  sizeDelta: number
}

/** Number of add/remove-mark steps in a transaction's step list. */
export function countMarkSteps(steps: readonly Step[]): number {
  let n = 0
  for (const s of steps) {
    if (s instanceof AddMarkStep || s instanceof RemoveMarkStep) n++
  }
  return n
}

/**
 * A passive ProseMirror plugin. On every applied transaction that changed the
 * document it calls `onDelta` with the mark-op count and the net change in doc
 * size (content length in PM units, a good proxy for characters). Never mutates
 * state; returns no decorations.
 */
export function analyticsObserverPlugin(onDelta: (d: ObserverDelta) => void): Plugin {
  return new Plugin({
    appendTransaction(transactions: readonly Transaction[], oldState, newState) {
      if (!transactions.some((t) => t.docChanged)) return null
      let markOps = 0
      for (const t of transactions) markOps += countMarkSteps(t.steps)
      const sizeDelta = newState.doc.content.size - oldState.doc.content.size
      onDelta({ markOps, sizeDelta })
      return null
    },
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/insights/observer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/insights/observer.ts src/lib/insights/observer.test.ts
git commit -m "feat(insights): PM observer for mark ops and doc-size deltas"
```

---

## Task 4: Cross-device merge + date-range aggregation

**Files:**
- Create: `src/lib/insights/merge.ts`
- Test: `src/lib/insights/merge.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/insights/merge.test.ts
import { describe, it, expect } from 'vitest'
import { mergeDeviceAnalytics, aggregateRange } from './merge'
import { emptyCounters, type DeviceAnalytics } from './model'

function dev(id: string, docs: DeviceAnalytics['docs']): DeviceAnalytics {
  return { deviceId: id, deviceName: id, docs }
}

describe('mergeDeviceAnalytics', () => {
  it('sums the same doc/day across devices', () => {
    const a = dev('A', { 'rel:a.md': { '2026-07-08': { ...emptyCounters(10), read_ms: 100 } } })
    const b = dev('B', { 'rel:a.md': { '2026-07-08': { ...emptyCounters(20), read_ms: 50 } } })
    const merged = mergeDeviceAnalytics([a, b])
    expect(merged['rel:a.md']['2026-07-08'].read_ms).toBe(150)
  })

  it('keeps distinct days and distinct docs side by side', () => {
    const a = dev('A', {
      'rel:a.md': { '2026-07-08': { ...emptyCounters(0), read_ms: 100 } },
      'rel:b.md': { '2026-07-08': { ...emptyCounters(0), read_ms: 5 } },
    })
    const b = dev('B', { 'rel:a.md': { '2026-07-07': { ...emptyCounters(0), read_ms: 200 } } })
    const merged = mergeDeviceAnalytics([a, b])
    expect(merged['rel:a.md']['2026-07-08'].read_ms).toBe(100)
    expect(merged['rel:a.md']['2026-07-07'].read_ms).toBe(200)
    expect(merged['rel:b.md']['2026-07-08'].read_ms).toBe(5)
  })
})

describe('aggregateRange', () => {
  it('sums counters per doc across the inclusive day range', () => {
    const a = dev('A', { 'rel:a.md': {
      '2026-07-06': { ...emptyCounters(0), read_ms: 10 },
      '2026-07-08': { ...emptyCounters(0), read_ms: 20 },
      '2026-07-10': { ...emptyCounters(0), read_ms: 40 }, // outside range
    } })
    const out = aggregateRange(mergeDeviceAnalytics([a]), '2026-07-06', '2026-07-08')
    expect(out['rel:a.md'].read_ms).toBe(30)
  })

  it('omits docs with no activity in the range', () => {
    const a = dev('A', { 'rel:a.md': { '2026-07-10': { ...emptyCounters(0), read_ms: 40 } } })
    const out = aggregateRange(mergeDeviceAnalytics([a]), '2026-07-06', '2026-07-08')
    expect(out['rel:a.md']).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/insights/merge.test.ts`
Expected: FAIL — cannot find module `./merge`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/insights/merge.ts
import { sumCounters, emptyCounters, type DayCounters, type DeviceAnalytics, type DocDays } from './model'

/** Merge every device's analytics into one docKey → day → summed counters map. */
export function mergeDeviceAnalytics(devices: DeviceAnalytics[]): DocDays {
  const out: DocDays = {}
  for (const dev of devices) {
    for (const [docKey, days] of Object.entries(dev.docs)) {
      const target = (out[docKey] ??= {})
      for (const [day, counters] of Object.entries(days)) {
        target[day] = target[day] ? sumCounters(target[day], counters) : counters
      }
    }
  }
  return out
}

/**
 * Sum each doc's counters over the inclusive [fromDay, toDay] range (day keys
 * are 'YYYY-MM-DD', which sort lexicographically in calendar order). Docs with
 * no in-range activity are omitted.
 */
export function aggregateRange(
  merged: DocDays,
  fromDay: string,
  toDay: string,
): Record<string, DayCounters> {
  const out: Record<string, DayCounters> = {}
  for (const [docKey, days] of Object.entries(merged)) {
    let acc: DayCounters | null = null
    for (const [day, counters] of Object.entries(days)) {
      if (day < fromDay || day > toDay) continue
      acc = acc ? sumCounters(acc, counters) : counters
    }
    if (acc) out[docKey] = acc
  }
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/insights/merge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/insights/merge.ts src/lib/insights/merge.test.ts
git commit -m "feat(insights): cross-device merge and date-range aggregation"
```

---

## Task 5: Analytics store — accumulate into day buckets + persist to sotvault

**Files:**
- Create: `src/lib/insights/store.svelte.ts`
- Test: `src/lib/insights/store.test.ts`

The store holds this device's `DocDays` in memory, exposes `accrue(docKey, patch, now)` (adds a partial counter delta into today's bucket), and `readAllDevices()` / `flush()` that read and write JSON files under `sotvault/.mdeditor/analytics/`. To keep it unit-testable, filesystem access is injected (default binding to `@tauri-apps/plugin-fs`).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/insights/store.test.ts
import { describe, it, expect } from 'vitest'
import { createAnalyticsStore, type Fs } from './store.svelte'
import { emptyCounters } from './model'

function memoryFs(): Fs & { files: Record<string, string> } {
  const files: Record<string, string> = {}
  return {
    files,
    async exists(p) { return p in files || Object.keys(files).some((f) => f.startsWith(p + '/')) },
    async mkdir() {},
    async readDir(dir) {
      const prefix = dir.replace(/\/$/, '') + '/'
      return Object.keys(files)
        .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
        .map((f) => ({ name: f.slice(prefix.length), isFile: true }))
    },
    async readTextFile(p) { return files[p] },
    async writeTextFile(p, c) { files[p] = c },
  }
}

const CFG = { deviceId: 'DEV1', deviceName: 'Mac', tzOffsetMinutes: 480 }

describe('analytics store', () => {
  it('accrues counter deltas into the correct local day bucket', () => {
    const store = createAnalyticsStore({ fs: memoryFs(), vaultRoot: () => '/v', ...CFG })
    const now = Date.UTC(2026, 6, 8, 7, 0) // UTC+8 → 2026-07-08 15:00 local
    store.accrue('rel:a.md', { read_ms: 500, mark_ops: 2 }, now)
    const days = store.snapshot()['rel:a.md']
    expect(days['2026-07-08'].read_ms).toBe(500)
    expect(days['2026-07-08'].mark_ops).toBe(2)
  })

  it('flush writes this device file; readAllDevices reads every device file back', async () => {
    const fs = memoryFs()
    const store = createAnalyticsStore({ fs, vaultRoot: () => '/v', ...CFG })
    store.accrue('rel:a.md', { read_ms: 500 }, Date.UTC(2026, 6, 8, 7, 0))
    await store.flush()
    expect(fs.files['/v/.mdeditor/analytics/DEV1.json']).toContain('rel:a.md')

    // A second device's file already on disk.
    fs.files['/v/.mdeditor/analytics/DEV2.json'] = JSON.stringify({
      deviceId: 'DEV2', deviceName: 'iPhone',
      docs: { 'rel:a.md': { '2026-07-08': { ...emptyCounters(0), read_ms: 250 } } },
    })
    const all = await store.readAllDevices()
    const ids = all.map((d) => d.deviceId).sort()
    expect(ids).toEqual(['DEV1', 'DEV2'])
  })

  it('flush is a no-op when no vault is configured', async () => {
    const fs = memoryFs()
    const store = createAnalyticsStore({ fs, vaultRoot: () => null, ...CFG })
    store.accrue('rel:a.md', { read_ms: 500 }, Date.UTC(2026, 6, 8, 7, 0))
    await store.flush()
    expect(Object.keys(fs.files)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/insights/store.test.ts`
Expected: FAIL — cannot find module `./store.svelte`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/insights/store.svelte.ts
import { dayKey, emptyCounters, type DayCounters, type DeviceAnalytics, type DocDays } from './model'

/** Minimal filesystem surface (injectable for tests; bound to plugin-fs in prod). */
export interface Fs {
  exists(path: string): Promise<boolean>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  readDir(path: string): Promise<Array<{ name: string; isFile: boolean }>>
  readTextFile(path: string): Promise<string>
  writeTextFile(path: string, content: string): Promise<void>
}

export interface AnalyticsStoreConfig {
  fs: Fs
  vaultRoot: () => string | null
  deviceId: string
  deviceName: string
  tzOffsetMinutes: number
}

const SUBDIR = '.mdeditor/analytics'

function analyticsDir(vaultRoot: string): string {
  return `${vaultRoot.replace(/\/$/, '')}/${SUBDIR}`
}

export function createAnalyticsStore(cfg: AnalyticsStoreConfig) {
  const docs: DocDays = {}

  function accrue(docKey: string, patch: Partial<DayCounters>, now: number): void {
    const day = dayKey(now, cfg.tzOffsetMinutes)
    const perDoc = (docs[docKey] ??= {})
    const bucket = (perDoc[day] ??= emptyCounters(now))
    bucket.read_ms += patch.read_ms ?? 0
    bucket.edit_ms += patch.edit_ms ?? 0
    bucket.open_count += patch.open_count ?? 0
    bucket.edit_sessions += patch.edit_sessions ?? 0
    bucket.net_chars += patch.net_chars ?? 0
    bucket.mark_ops += patch.mark_ops ?? 0
    bucket.first_seen_at = Math.min(bucket.first_seen_at, now)
    bucket.last_active_at = Math.max(bucket.last_active_at, now)
  }

  function snapshot(): DocDays {
    return docs
  }

  async function flush(): Promise<void> {
    const root = cfg.vaultRoot()
    if (!root) return
    const dir = analyticsDir(root)
    await cfg.fs.mkdir(dir, { recursive: true }).catch(() => {})
    const doc: DeviceAnalytics = { deviceId: cfg.deviceId, deviceName: cfg.deviceName, docs }
    await cfg.fs.writeTextFile(`${dir}/${cfg.deviceId}.json`, JSON.stringify(doc, null, 2))
  }

  async function readAllDevices(): Promise<DeviceAnalytics[]> {
    const root = cfg.vaultRoot()
    if (!root) return [{ deviceId: cfg.deviceId, deviceName: cfg.deviceName, docs }]
    const dir = analyticsDir(root)
    if (!(await cfg.fs.exists(dir).catch(() => false))) {
      return [{ deviceId: cfg.deviceId, deviceName: cfg.deviceName, docs }]
    }
    const out: DeviceAnalytics[] = []
    const ownFile = `${cfg.deviceId}.json`
    const entries = await cfg.fs.readDir(dir).catch(() => [])
    for (const ent of entries) {
      if (!ent.isFile || !ent.name.endsWith('.json') || ent.name === ownFile) continue
      try {
        const parsed = JSON.parse(await cfg.fs.readTextFile(`${dir}/${ent.name}`)) as DeviceAnalytics
        if (parsed && parsed.docs) out.push(parsed)
      } catch {
        // Skip corrupt / partially-written files.
      }
    }
    // Include this device's live in-memory state (fresher than any on-disk copy).
    out.push({ deviceId: cfg.deviceId, deviceName: cfg.deviceName, docs })
    return out
  }

  return { accrue, snapshot, flush, readAllDevices }
}

export type AnalyticsStore = ReturnType<typeof createAnalyticsStore>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/insights/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/insights/store.svelte.ts src/lib/insights/store.test.ts
git commit -m "feat(insights): analytics store with day-bucket accrual and per-device persistence"
```

---

## Task 6: Plugin manifest for `reading-insights`

**Files:**
- Create: `src-tauri/plugins/reading-insights/manifest.json`
- Reference: `src-tauri/plugins/sotvault/manifest.json` (shape), `src-tauri/plugins/README.md` (builtin registration)

**Known facts (verified):** builtins are auto-discovered by walking `<resource_dir>/plugins/*/manifest.json` at startup (`src-tauri/src/plugin_host.rs`), and `plugins/**/*` is already bundled via `src-tauri/tauri.conf.json` `resources` — so **no explicit registration list exists; creating the directory is enough**. The Rust `PluginManifest` struct has NO `#[serde(deny_unknown_fields)]`, so the extra `available_when` field is silently ignored on the Rust side (it is a host/TS-only concern). `default_enabled` is **false** on purpose: the Rust side resolves builtin enabled-state as `default_enabled.unwrap_or(false)` and does NOT understand `available_when`, so `true` would make it show as "checked-but-grayed" before a vault exists. The "on by default once a vault is configured" behavior is delivered by the auto-enable hook in Task 9 instead.

- [ ] **Step 1: Confirm auto-discovery (no code change expected)**

Run: `grep -rn "manifest.json\|default_enabled\|PluginKind::Builtin" src-tauri/src/plugin_host.rs | head`
Expected: confirms directory-walk discovery + `default_enabled.unwrap_or(false)`. No registration list to edit.

- [ ] **Step 2: Write the manifest**

```json
{
  "id": "reading-insights",
  "name": "Reading Insights",
  "version": "0.1.0",
  "description": "Track your reading and editing engagement per document, stored in your Vault.",
  "kind": "builtin",
  "default_enabled": false,
  "available_when": "vaultConfigured",
  "host_capabilities": [],
  "i18n": {
    "zh": {
      "name": "阅读洞察",
      "description": "统计你在每篇文档上的阅读与编辑投入，数据存入你的 Vault。"
    },
    "ja": {
      "name": "リーディングインサイト",
      "description": "ドキュメントごとの閲覧・編集の関与を記録し、Vault に保存します。"
    }
  }
}
```

- [ ] **Step 3: Register the builtin (if Step 1 showed an explicit list)**

Add `reading-insights` to the same embed/registry site that lists `sotvault` (mirror the exact syntax found there). If builtins are auto-discovered from the directory, no change is needed.

- [ ] **Step 4: Verify the app still builds and the plugin appears disabled-but-listed with no vault**

Run: `pnpm check`
Expected: no type errors. (Manual UI verification of the toggle happens in Task 10.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/plugins/reading-insights/manifest.json src-tauri/src
git commit -m "feat(insights): reading-insights builtin plugin manifest"
```

---

## Task 7: Manifest + enabled-when types — `available_when` and `vaultConfigured`

**Files:**
- Modify: `src/lib/plugins/types.ts`
- Test: `src/lib/plugins/enabled-when.test.ts`

- [ ] **Step 1: Add the type fields**

In `src/lib/plugins/types.ts`, add to `PluginManifest` (next to `timeout_seconds?`):

```typescript
  /** Whole-plugin availability gate (distinct from per-menu `enabled_when`).
   *  When present and false, the plugin is not selectable in settings. */
  available_when?: string
```

And add to `EnabledWhenContext` (next to `settings`):

```typescript
  /** True once the user has configured a Vault (sotvault root is set). */
  vaultConfigured: boolean
```

- [ ] **Step 2: Write a failing test for root-level identifier evaluation**

Append to `src/lib/plugins/enabled-when.test.ts`:

```typescript
import { evaluateEnabledWhen } from './enabled-when'

describe('vaultConfigured gate', () => {
  const ctx = (vaultConfigured: boolean) => ({ currentTab: null, settings: {}, vaultConfigured })

  it('evaluates a bare vaultConfigured identifier', () => {
    expect(evaluateEnabledWhen('vaultConfigured', ctx(true))).toBe(true)
    expect(evaluateEnabledWhen('vaultConfigured', ctx(false))).toBe(false)
  })

  it('supports negation', () => {
    expect(evaluateEnabledWhen('!vaultConfigured', ctx(false))).toBe(true)
  })
})
```

- [ ] **Step 3: Run the test**

Run: `pnpm vitest run src/lib/plugins/enabled-when.test.ts`
Expected: If `lookup` already resolves top-level context keys, this PASSES immediately (confirming no code change needed). If it FAILS (only `currentTab`/`settings` roots are handled), proceed to Step 4.

- [ ] **Step 4: If needed, teach `lookup` the new root**

Open `src/lib/plugins/enabled-when.ts`, find `function lookup(ctx, segments)`. If it switches on the first segment's literal value against a fixed set (`currentTab`, `settings`), add a `vaultConfigured` case returning `ctx.vaultConfigured`. Re-run Step 3 until PASS.

- [ ] **Step 5: Run the whole plugins test suite + typecheck, then commit**

Run: `pnpm vitest run src/lib/plugins && pnpm check`
Expected: PASS, no type errors.

```bash
git add src/lib/plugins/types.ts src/lib/plugins/enabled-when.ts src/lib/plugins/enabled-when.test.ts
git commit -m "feat(insights): available_when manifest field + vaultConfigured gate"
```

---

## Task 8: Populate `vaultConfigured` where the enabled-when context is built

**Files:**
- Modify: the call site(s) that construct `EnabledWhenContext` (find in Step 1)

- [ ] **Step 1: Locate every construction of `EnabledWhenContext`**

Run: `grep -rn "currentTab:" src/lib src/components | grep -i "settings:"`
and: `grep -rn "EnabledWhenContext\|evaluateEnabledWhen\|menu-registry" src/components src/lib | grep -v test`
Expected: one or two sites (likely `App.svelte` / a menu builder / `PluginsSettingsTab.svelte`) that build the context object.

- [ ] **Step 2: Add `vaultConfigured` to each constructed context**

At each site, import the sotvault store and set the field:

```typescript
import { sotvaultStore } from '$lib/sotvault.svelte' // adjust to the site's existing import style
// ...where the context object literal is built:
  vaultConfigured: sotvaultStore.vaultRoot !== null,
```

(TypeScript will now error at any context literal missing the field — fix each until `pnpm check` is clean. This is the intended compiler-driven exhaustiveness.)

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: no errors (every `EnabledWhenContext` literal now includes `vaultConfigured`).

- [ ] **Step 4: Commit**

```bash
git add src/lib src/components
git commit -m "feat(insights): fill vaultConfigured in enabled-when contexts"
```

---

## Task 9: Settings UI — gray out the toggle without a vault

**Files:**
- Modify: `src/components/PluginsSettingsTab.svelte`
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/zh.ts`, `src/lib/i18n/ja.ts`

**Simplification (verified against the code):** `isPluginEnabled` in `src/lib/settings.svelte.ts` is **default-on** — a plugin id absent from the `pluginsEnabled` map returns `true`. So `reading-insights` is already "enabled by default" the moment it exists, which satisfies "on by default once a vault is set" WITHOUT any auto-enable hook. The tracker (Task 10) guards on `isPluginEnabled('reading-insights') && vaultConfigured`, so with no vault the plugin collects nothing even though `isPluginEnabled` is `true`. Therefore this task is ONLY the settings-UI graying + one i18n key. Do NOT add `hasExplicitPluginEnabled` or any vault-set auto-enable hook — they are unnecessary.

- [ ] **Step 1: Gray out the toggle when `available_when` is unmet**

Edit `src/components/PluginsSettingsTab.svelte`. Add two imports to the `<script>` block:

```typescript
  import { sotvaultStore } from '../lib/sotvault.svelte'
  import { evaluateEnabledWhen } from '../lib/plugins/enabled-when'
```

Add an availability helper (below the existing `toggle` function):

```typescript
  function isAvailable(m: PluginManifest): boolean {
    if (!m.available_when) return true
    return evaluateEnabledWhen(m.available_when, {
      currentTab: null,
      settings: {},
      vaultConfigured: sotvaultStore.vaultRoot !== null,
    })
  }
```

In the `{#each rows as r ...}` block, compute availability with `{@const avail = isAvailable(r.manifest)}` at the top of the row `<div>`, then:
- checkbox: `disabled={!avail}` and `checked={avail && r.enabled}` (grayed rows read as unchecked).
- after the `.name`/`.version` spans, show the hint when unavailable: `{#if !avail}<span class="needs-vault">{t('plugins.needsVault')}</span>{/if}`.
- optionally add `class:unavailable={!avail}` on the row `<div>` and a dim style.

Add a small style for `.needs-vault` (reuse the muted color pattern already in the file, e.g. `font-size: 11px; color: color-mix(in srgb, CanvasText 55%, transparent);`).

- [ ] **Step 2: Add the i18n key to all three locales**

- `src/lib/i18n/en.ts` (next to the other `'plugins.*'` keys): `'plugins.needsVault': 'Set a Vault first to enable this plugin',`
- `src/lib/i18n/zh.ts`: `'plugins.needsVault': '需先设置 Vault 才能启用此插件',`
- `src/lib/i18n/ja.ts`: `'plugins.needsVault': '有効にするには先に Vault を設定してください',`

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: 0 ERRORS (pre-existing a11y WARNINGS are fine).

- [ ] **Step 4: Commit**

```bash
git add src/components/PluginsSettingsTab.svelte src/lib/i18n
git commit -m "feat(insights): gray out reading-insights toggle until a vault is configured"
```

---

## Task 10: Tracker — wire events into the reducer and store

**Files:**
- Create: `src/lib/insights/tracker.svelte.ts`
- Reference: `src/lib/tabs.svelte.ts` (`activeTab`, `activeId`), `src/lib/sotvault.svelte.ts` (`sotvaultStore.vaultRoot`), `src/lib/settings.svelte.ts` (`getDeviceId`, `isPluginEnabled`), `@tauri-apps/api/window` (`getCurrentWindow().onFocusChanged`), `@tauri-apps/plugin-os` (`hostname`)

The tracker owns one `TimingState` for the active document and the `AnalyticsStore`. It converts every incoming event into `applyEvent`, and whenever the reducer returns `accrued`, it calls `store.accrue(docKey, { read_ms | edit_ms }, now)`. The observer delta (mark ops / size delta) and open events accrue directly. A `setInterval` emits `tick` (drives idle + periodic checkpoint) and periodically `flush()`es.

- [ ] **Step 1: Write the tracker**

```typescript
// src/lib/insights/tracker.svelte.ts
import { getCurrentWindow } from '@tauri-apps/api/window'
import { exists, mkdir, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { hostname } from '@tauri-apps/plugin-os'
import type { MorayaEditorInstance } from '@moraya/core'
import { activeTab } from '../tabs.svelte'
import { sotvaultStore } from '../sotvault.svelte'
import { getDeviceId, isPluginEnabled } from '../settings.svelte'
import { createAnalyticsStore, type AnalyticsStore, type Fs } from './store.svelte'
import { initTiming, applyEvent, type TimingState, type TimingEvent, type TimingMode } from './timing'
import { docKeyFor, localTzOffsetMinutes } from './model'
import { analyticsObserverPlugin } from './observer'

const PLUGIN_ID = 'reading-insights'
const TICK_MS = 5_000
const FLUSH_EVERY_TICKS = 6 // ~30s

const fs: Fs = {
  exists: (p) => exists(p),
  mkdir: (p, o) => mkdir(p, o).then(() => {}),
  readDir: async (p) => (await readDir(p)).map((e) => ({ name: e.name, isFile: e.isFile })),
  readTextFile: (p) => readTextFile(p),
  writeTextFile: (p, c) => writeTextFile(p, c),
}

interface TrackerState {
  store: AnalyticsStore
  timing: TimingState
  currentDocKey: string | null
  timer: ReturnType<typeof setInterval> | null
  tickCount: number
  disposers: Array<() => void>
}

let tracker: TrackerState | null = null

function currentDocKey(): string | null {
  const t = activeTab()
  if (!t || !t.filePath || t.kind !== 'markdown') return null
  return docKeyFor(t.filePath, sotvaultStore.vaultRoot)
}

function currentMode(): TimingMode {
  return activeTab()?.mode === 'source' ? 'edit' : 'read'
  // NOTE: 'rich' + no typing is still "read"; edit_ms is credited whenever the
  // observer reports doc changes (below) — see accrueEdit().
}

function dispatch(ev: TimingEvent): void {
  if (!tracker) return
  const now = Date.now()
  const { state, accrued } = applyEvent(tracker.timing, ev, now)
  tracker.timing = state
  if (accrued && tracker.currentDocKey) {
    tracker.store.accrue(
      tracker.currentDocKey,
      accrued.mode === 'read' ? { read_ms: accrued.ms } : { edit_ms: accrued.ms },
      now,
    )
  }
}

/** Switch the tracked document: flush the old one, reset timing for the new. */
export function onActiveDocChanged(): void {
  if (!tracker) return
  dispatch({ type: 'tabInactive' }) // credit remaining time to old doc
  tracker.currentDocKey = currentDocKey()
  tracker.timing = initTiming(Date.now(), currentMode())
  if (tracker.currentDocKey) {
    tracker.store.accrue(tracker.currentDocKey, { open_count: 1 }, Date.now())
    dispatch({ type: 'tabActive' })
  }
}

/** Attach the analytics observer to a freshly mounted editor. Returns a plugin
 *  to be merged into the editor's state (see editor-bridge wiring). */
export function analyticsPluginForEditor() {
  return analyticsObserverPlugin(({ markOps, sizeDelta }) => {
    if (!tracker || !tracker.currentDocKey) return
    const now = Date.now()
    // A doc change counts as user activity (resumes from idle) and an edit.
    dispatch({ type: 'activity' })
    tracker.store.accrue(
      tracker.currentDocKey,
      { mark_ops: markOps, net_chars: Math.max(0, sizeDelta), edit_sessions: 1 },
      now,
    )
  })
}

export async function installTracker(): Promise<() => void> {
  if (!isPluginEnabled(PLUGIN_ID) || sotvaultStore.vaultRoot === null) {
    return () => {}
  }
  const deviceId = getDeviceId()
  const deviceName = (await hostname().catch(() => null)) ?? `Device-${deviceId.slice(0, 8)}`
  const store = createAnalyticsStore({
    fs,
    vaultRoot: () => sotvaultStore.vaultRoot,
    deviceId,
    deviceName,
    tzOffsetMinutes: localTzOffsetMinutes(),
  })
  tracker = {
    store,
    timing: initTiming(Date.now(), currentMode()),
    currentDocKey: currentDocKey(),
    timer: null,
    tickCount: 0,
    disposers: [],
  }

  // Window focus/blur.
  const unlistenFocus = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    dispatch({ type: focused ? 'focus' : 'blur' })
  })
  tracker.disposers.push(unlistenFocus)

  // User activity (idle reset).
  const activity = () => dispatch({ type: 'activity' })
  for (const evt of ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(evt, activity, { passive: true })
    tracker.disposers.push(() => window.removeEventListener(evt, activity))
  }

  // Periodic tick: idle detection + checkpoint + flush.
  tracker.timer = setInterval(() => {
    dispatch({ type: 'tick' })
    if (tracker && ++tracker.tickCount % FLUSH_EVERY_TICKS === 0) void store.flush()
  }, TICK_MS)

  // Assume focused + active tab at install (app is in the foreground on mount).
  dispatch({ type: 'focus' })
  dispatch({ type: 'tabActive' })
  if (tracker.currentDocKey) store.accrue(tracker.currentDocKey, { open_count: 1 }, Date.now())

  // Flush on page hide (app quit / backgrounding).
  const onHide = () => { void store.flush() }
  window.addEventListener('pagehide', onHide)
  tracker.disposers.push(() => window.removeEventListener('pagehide', onHide))

  return async () => {
    dispatch({ type: 'blur' })
    if (tracker?.timer) clearInterval(tracker.timer)
    tracker?.disposers.forEach((d) => d())
    await store.flush()
    tracker = null
  }
}

/** Notify the tracker that the editor mode toggled (rich ↔ source). */
export function onModeChanged(): void {
  dispatch({ type: 'mode', mode: currentMode() })
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: no type errors. (If `onFocusChanged`'s payload shape differs in the installed `@tauri-apps/api` version, adjust the destructuring to match — verify with `grep -rn "onFocusChanged" node_modules/@tauri-apps/api/window.d.ts`.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/insights/tracker.svelte.ts
git commit -m "feat(insights): tracker wiring focus/idle/tabs/observer into store"
```

---

## Task 11: Integrate — mount observer in editor, install tracker on app start, react to tab/mode changes

**Files:**
- Modify: `src/lib/editor-bridge.ts`
- Modify: `src/App.svelte` (or the mount site found in Step 2)
- Modify: `src/lib/tabs.svelte.ts` (call `onActiveDocChanged` / `onModeChanged`)

- [ ] **Step 1: Attach the observer plugin to the mounted editor**

In `src/lib/editor-bridge.ts`, after `coreCreateEditor(...)` resolves to `instance`, reconfigure its state to include the analytics plugin, then return:

```typescript
import { analyticsPluginForEditor } from './insights/tracker.svelte'
import { isPluginEnabled } from './settings.svelte'
// …at the end of mountRichEditor, replace `return coreCreateEditor({...})` with:
  const instance = await coreCreateEditor({ /* …existing opts… */ })
  if (isPluginEnabled('reading-insights')) {
    const plugin = analyticsPluginForEditor()
    instance.view.updateState(
      instance.view.state.reconfigure({
        plugins: instance.view.state.plugins.concat(plugin),
      }),
    )
  }
  return instance
```

- [ ] **Step 2: Install the tracker on app mount**

Run: `grep -rn "installRecentsSync\|onMount" src/App.svelte`
Expected: shows the existing mount/onMount block (where `installRecentsSync()` is called). Alongside it:

```typescript
import { installTracker } from './lib/insights/tracker.svelte'
// inside onMount:
const uninstallTracker = await installTracker()
// inside the returned cleanup:
void uninstallTracker()
```

- [ ] **Step 3: Notify the tracker on tab activation and mode change**

In `src/lib/tabs.svelte.ts`:
- In `activate(id)` and at the end of `openFile` (after `activeId.value = tab.id`), call `onActiveDocChanged()`.
- In `setMode(id, mode)` after `t.mode = mode`, call `onModeChanged()`.

Guard the import to avoid a cycle by importing lazily inside the functions:

```typescript
export function activate(id: string): void {
  if (tabs.some((t) => t.id === id)) {
    activeId.value = id
    void import('./insights/tracker.svelte').then((m) => m.onActiveDocChanged())
  }
}
```

Apply the same lazy-import call in `openFile` (after activation) and `onModeChanged()` in `setMode`.

- [ ] **Step 4: Typecheck + full test suite**

Run: `pnpm check && pnpm test`
Expected: type-clean; all tests pass (no regressions in tabs/settings/plugins suites).

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor-bridge.ts src/App.svelte src/lib/tabs.svelte.ts
git commit -m "feat(insights): integrate tracker + observer into editor/app/tabs"
```

---

## Task 12: Manual verification with a real vault

**Files:** none (manual)

- [ ] **Step 1: Run the app, configure a Vault, confirm the toggle**

Run: `pnpm tauri dev`
- Before setting a vault: open Settings ▸ Plugins → `Reading Insights` row is present but its checkbox is **disabled** with the "needs vault" hint.
- Configure a Vault → the toggle becomes enabled and **checked** by default.

- [ ] **Step 2: Generate and inspect data**

- Open a markdown file inside the vault; read for ~30s, then type some text and apply bold/highlight to a selection.
- Switch to another tab and back.
- Wait ~30s for a flush (or quit the app).

Run: `cat "<vault>/.mdeditor/analytics/"*.json`
Expected: a `<device_id>.json` containing the file's `rel:` key with today's day bucket showing non-zero `read_ms`, `edit_ms`, `net_chars`, `mark_ops >= 2`, and `open_count >= 1`.

- [ ] **Step 3: Confirm the disabled path is inert**

- Toggle the plugin off in Settings, restart, edit a file: no new writes to the analytics dir (the tracker returns the no-op disposer).

- [ ] **Step 4: Commit any fixes found during manual testing**

```bash
git add -A
git commit -m "fix(insights): address manual-verification findings"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage (Phase 1 scope):** owner counters `read_ms`/`edit_ms` (Tasks 2, 10), `open_count` (Task 10), `edit_sessions`/`net_chars` (Tasks 3, 10), `mark_ops` (Tasks 3, 10); local-day bucketing (Task 1); per-device sotvault file + cross-device merge (Tasks 4, 5); date-range aggregation for later phases (Task 4); plugin packaging + vault gating + auto-enable (Tasks 6–9); zero-overhead when disabled/no-vault (Tasks 5, 10, 11). Deferred to later phases by design: web beacon + worker (Phase 2), dashboard/value score (Phase 3), daily report + CLI (Phase 4).
- **Type consistency:** `DayCounters`, `DeviceAnalytics`, `DocDays` (Task 1) are the single source of truth reused in Tasks 4/5/10; `AnalyticsStore` from Task 5 is consumed in Task 10; `TimingState`/`applyEvent`/`TimingMode` from Task 2 are consumed in Task 10; `analyticsObserverPlugin`/`ObserverDelta` from Task 3 are consumed in Task 10.
- **`edit_ms` vs `edit_sessions`:** dwell in source mode accrues `edit_ms` via the timing reducer; each observer-reported doc change adds one `edit_sessions` and the net chars. If a finer "burst coalescing" for `edit_sessions` is desired, it can be added later by debouncing observer deltas — intentionally kept simple here.
```
