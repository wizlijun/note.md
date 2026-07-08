# Reading Insights — Phase 4: Daily Report + CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge a date range's engagement into a human-readable markdown "reading digest" saved to `<vault>/stat/`, generated two ways: an in-app button (full owner + audience + value) and a self-contained Node CLI (owner-only, for external tools/automation).

**Architecture:** A pure TS renderer (`report.ts`) turns the already-assembled `InsightRow[]` into `{ filename, markdown }`; the in-app panel wires it to `assembleRows` (Phase 3) and writes/opens the file via Tauri. A dependency-free `scripts/insights-report.mjs` reads the git-synced per-day analytics with `node:fs`, reproduces the small owner-side merge/aggregate, and renders an owner digest — its pure core is unit-tested so its numbers can't silently drift.

**Tech Stack:** TypeScript, Svelte 5, Vitest, Node (`node:fs`). No new deps, no build step for the CLI.

**Scope note:** Phase 4 of 4 — the final phase. In-app report = owner + audience + value score. CLI = owner-only digest (self-contained; audience needs app settings + network, out of CLI scope for v1). Both write `stat/*.md` into the vault.

**Report file naming:** single day → `stat/<YYYY-MM-DD>-daily-stat.md`; multi-day range → `stat/<from>_<to>-stat.md`.

---

## File Structure

**New:**
- `src/lib/insights/report.ts` + `report.test.ts` — pure `renderDailyReport(rows, fromDay, toDay)`.
- `scripts/insights-report.mjs` — CLI entry (arg parse + node:fs read + write/stdout).
- `scripts/insights-report-core.mjs` + `scripts/insights-report-core.test.ts` — pure CLI core (parse files → merge → aggregate → render owner digest), unit-tested.

**Modified:**
- `src/components/InsightsPanel.svelte` — add a "Generate report" button.
- `src/lib/i18n/{en,zh,ja}.ts` — button + toast strings.
- `README.md` — a short CLI usage note (optional, at the end).

---

## Task 1: Pure report renderer (`report.ts`)

**Files:** Create `src/lib/insights/report.ts`, `src/lib/insights/report.test.ts`

The renderer is deterministic (no `Date.now()` inside). Output is Chinese (the primary user's language). Durations formatted as `Xh Ym` / `Xm Ys` / `Xs`.

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import { renderDailyReport, reportFilename } from './report'
import type { InsightRow } from './dashboard.svelte'

function row(over: Partial<InsightRow>): InsightRow {
  return {
    docKey: 'rel:a.md', label: 'a.md', path: '/v/a.md',
    read_ms: 0, edit_ms: 0, edit_sessions: 0, mark_ops: 0, net_chars: 0,
    aud_read_ms: 0, unique_readers: 0, shared: false, value: 0, ...over,
  }
}

describe('reportFilename', () => {
  it('single day → daily-stat', () => {
    expect(reportFilename('2026-07-08', '2026-07-08')).toBe('stat/2026-07-08-daily-stat.md')
  })
  it('range → from_to-stat', () => {
    expect(reportFilename('2026-07-01', '2026-07-07')).toBe('stat/2026-07-01_2026-07-07-stat.md')
  })
})

describe('renderDailyReport', () => {
  const rows = [
    row({ label: 'a.md', read_ms: 120_000, edit_ms: 60_000, edit_sessions: 2, mark_ops: 3, aud_read_ms: 90_000, unique_readers: 4, shared: true, value: 8.2 }),
    row({ docKey: 'abs:/tmp/b.md', label: 'b.md', path: '/tmp/b.md', read_ms: 30_000, value: 1.1 }),
  ]
  it('has a heading with the range and a totals row', () => {
    const { markdown } = renderDailyReport(rows, '2026-07-08', '2026-07-08')
    expect(markdown).toContain('# 阅读数据')
    expect(markdown).toContain('2026-07-08')
    expect(markdown).toContain('| a.md |')
    expect(markdown).toContain('| b.md |')
    expect(markdown).toContain('合计')
  })
  it('summary reports doc count and total engagement time', () => {
    const { markdown } = renderDailyReport(rows, '2026-07-08', '2026-07-08')
    // 2 docs; total read+edit = 120+60+30 = 210s = 3m 30s
    expect(markdown).toContain('2 篇')
    expect(markdown).toMatch(/3m ?30s/)
  })
  it('mentions audience when any doc was read by others', () => {
    const { markdown } = renderDailyReport(rows, '2026-07-08', '2026-07-08')
    expect(markdown).toContain('读者') // 4 unique readers surfaced
  })
  it('returns the matching filename', () => {
    const { filename } = renderDailyReport(rows, '2026-07-08', '2026-07-08')
    expect(filename).toBe('stat/2026-07-08-daily-stat.md')
  })
  it('renders an empty-state note when no rows', () => {
    const { markdown } = renderDailyReport([], '2026-07-08', '2026-07-08')
    expect(markdown).toContain('没有')
  })
}
)
```

- [ ] **Step 2: Run, expect fail.** `pnpm vitest run src/lib/insights/report.test.ts`

- [ ] **Step 3: Implement `src/lib/insights/report.ts`**

```typescript
import type { InsightRow } from './dashboard.svelte'

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function reportFilename(fromDay: string, toDay: string): string {
  return fromDay === toDay
    ? `stat/${fromDay}-daily-stat.md`
    : `stat/${fromDay}_${toDay}-stat.md`
}

/** Render a deterministic Chinese reading digest for the range. */
export function renderDailyReport(rows: InsightRow[], fromDay: string, toDay: string): { filename: string; markdown: string } {
  const filename = reportFilename(fromDay, toDay)
  const rangeLabel = fromDay === toDay ? fromDay : `${fromDay} → ${toDay}`

  if (rows.length === 0) {
    return { filename, markdown: `# 阅读数据 · ${rangeLabel}\n\n此区间没有阅读或编辑记录。\n` }
  }

  const totalEngage = rows.reduce((n, r) => n + r.read_ms + r.edit_ms, 0)
  const top = [...rows].sort((a, b) => (b.read_ms + b.edit_ms) - (a.read_ms + a.edit_ms))[0]
  const totalReaders = rows.reduce((n, r) => n + r.unique_readers, 0)
  const sharedRead = rows.reduce((n, r) => n + r.aud_read_ms, 0)
  const sharedCount = rows.filter((r) => r.shared).length

  let summary = `本区间你在 ${rows.length} 篇文档上共停留 ${fmtDuration(totalEngage)}，投入最多的是《${top.label}》。`
  if (totalReaders > 0) {
    summary += ` 其中 ${sharedCount} 篇分享文档共被 ${totalReaders} 位读者阅读 ${fmtDuration(sharedRead)}。`
  }

  const header = '| 文档 | 阅读 | 编辑 | 编辑段 | 标注 | 受众时长 | 读者 | 价值 |'
  const divider = '|---|---|---|---|---|---|---|---|'
  const body = rows.map((r) =>
    `| ${r.label}${r.shared ? ' 🔗' : ''} | ${fmtDuration(r.read_ms)} | ${fmtDuration(r.edit_ms)} | ${r.edit_sessions} | ${r.mark_ops} | ${fmtDuration(r.aud_read_ms)} | ${r.unique_readers} | ${r.value.toFixed(1)} |`,
  )
  const totals = `| **合计** | ${fmtDuration(rows.reduce((n, r) => n + r.read_ms, 0))} | ${fmtDuration(rows.reduce((n, r) => n + r.edit_ms, 0))} | ${rows.reduce((n, r) => n + r.edit_sessions, 0)} | ${rows.reduce((n, r) => n + r.mark_ops, 0)} | ${fmtDuration(sharedRead)} | ${totalReaders} | |`

  const markdown = [
    `# 阅读数据 · ${rangeLabel}`, '', summary, '',
    header, divider, ...body, totals, '',
    '<sub>由 M↓ Reading Insights 生成</sub>', '',
  ].join('\n')

  return { filename, markdown }
}
```

- [ ] **Step 4: Run, expect pass.** **Step 5: Commit** `feat(insights): daily report markdown renderer`.

---

## Task 2: In-app "Generate report" button

**Files:** Modify `src/components/InsightsPanel.svelte`, `src/lib/i18n/{en,zh,ja}.ts`

- [ ] **Step 1:** In `InsightsPanel.svelte`, add imports:

```typescript
import { renderDailyReport } from '../lib/insights/report'
import { mkdir, writeTextFile } from '@tauri-apps/plugin-fs'
import { openFile } from '../lib/tabs.svelte'
import { sotvaultStore } from '../lib/sotvault.svelte'  // if not already imported
import { pushToast } from '../lib/toast.svelte'          // check the real toast API in the repo
```

Add a handler that reuses the current `rows` + range:

```typescript
async function generateReport() {
  const root = sotvaultStore.vaultRoot
  if (!root || rows.length === 0) return
  const { filename, markdown } = renderDailyReport(rows, fromDay, toDay)
  const dir = `${root.replace(/\/$/, '')}/stat`
  await mkdir(dir, { recursive: true }).catch(() => {})
  const abs = `${root.replace(/\/$/, '')}/${filename}`
  await writeTextFile(abs, markdown)
  await openFile(abs)
}
```

(Verify the toast helper's real name/signature in the repo — e.g. `src/lib/toast.svelte.ts` — and show a success toast, or skip the toast if unsure. Opening the file is the primary feedback.)

- [ ] **Step 2:** Add a button near the preset row: `<button onclick={() => void generateReport()} disabled={rows.length === 0}>{t('insights.generateReport')}</button>`.

- [ ] **Step 3:** i18n `insights.generateReport` = `Generate report` / `生成报告` / `レポート生成` in the three locales.

- [ ] **Step 4: Verify** `pnpm check` → 0 errors; `pnpm test` → green. **Step 5: Commit** `feat(insights): in-app generate-report button writes stat/*.md`.

---

## Task 3: Self-contained Node CLI (owner-only digest)

**Files:** Create `scripts/insights-report-core.mjs`, `scripts/insights-report-core.test.ts`, `scripts/insights-report.mjs`

The CLI reads `<vault>/.mdeditor/analytics/<YYYY-MM-DD>.<device>.json` files directly, merges owner counters across devices, aggregates over a range, and renders an owner digest. Dependency-free ESM so external tools run it with plain `node`.

- [ ] **Step 1: Write failing tests — `scripts/insights-report-core.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { mergeFiles, aggregate, renderOwnerDigest, resolvePreset } from './insights-report-core.mjs'

const files = [
  { name: '2026-07-08.DEV1.json', json: { deviceId: 'DEV1', deviceName: 'Mac', day: '2026-07-08', docs: { 'rel:a.md': { read_ms: 120000, edit_ms: 60000, edit_sessions: 2, mark_ops: 3, net_chars: 40, open_count: 1, first_seen_at: 0, last_active_at: 0 } } } },
  { name: '2026-07-08.DEV2.json', json: { deviceId: 'DEV2', deviceName: 'iPhone', day: '2026-07-08', docs: { 'rel:a.md': { read_ms: 30000, edit_ms: 0, edit_sessions: 0, mark_ops: 0, net_chars: 0, open_count: 1, first_seen_at: 0, last_active_at: 0 } } } },
  { name: '2026-07-07.DEV1.json', json: { deviceId: 'DEV1', deviceName: 'Mac', day: '2026-07-07', docs: { 'rel:a.md': { read_ms: 999, edit_ms: 0, edit_sessions: 0, mark_ops: 0, net_chars: 0, open_count: 1, first_seen_at: 0, last_active_at: 0 } } } },
]

describe('mergeFiles + aggregate', () => {
  it('sums a doc across devices for the range only', () => {
    const merged = mergeFiles(files)
    const agg = aggregate(merged, '2026-07-08', '2026-07-08')
    expect(agg['rel:a.md'].read_ms).toBe(150000) // 120k + 30k; the 07-07 file excluded
  })
})

describe('renderOwnerDigest', () => {
  it('produces a heading, the doc, and a total', () => {
    const merged = mergeFiles(files)
    const agg = aggregate(merged, '2026-07-08', '2026-07-08')
    const md = renderOwnerDigest(agg, '2026-07-08', '2026-07-08')
    expect(md).toContain('# 阅读数据')
    expect(md).toContain('a.md')
    expect(md).toContain('合计')
    expect(md).toContain('2m 30s') // 150000ms read
  })
})

describe('resolvePreset', () => {
  it('yesterday resolves to the prior day', () => {
    const now = Date.UTC(2026, 6, 8, 7, 0)
    expect(resolvePreset('yesterday', now, 480)).toEqual({ from: '2026-07-07', to: '2026-07-07' })
  })
})
```

- [ ] **Step 2: Make the test part of the suite, then run (expect fail).** `vitest.config.ts` currently has `include: ['src/**/*.test.ts']`. Add `'scripts/**/*.test.ts'` to that array so `pnpm test` covers the CLI core. Then `pnpm vitest run scripts/insights-report-core.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `scripts/insights-report-core.mjs`** (plain ESM; mirrors `report.ts` formatting for the owner columns)

```javascript
export function fmtDuration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.(.+)\.json$/

/** files: [{ name, json }] → docKey -> day -> summed counters (across devices). */
export function mergeFiles(files) {
  const out = {}
  for (const f of files) {
    const m = FILE_RE.exec(f.name)
    if (!m || !f.json || !f.json.docs) continue
    const day = m[1]
    for (const [docKey, c] of Object.entries(f.json.docs)) {
      const perDoc = (out[docKey] ??= {})
      const b = (perDoc[day] ??= { read_ms: 0, edit_ms: 0, edit_sessions: 0, mark_ops: 0, net_chars: 0, open_count: 0 })
      b.read_ms += c.read_ms || 0
      b.edit_ms += c.edit_ms || 0
      b.edit_sessions += c.edit_sessions || 0
      b.mark_ops += c.mark_ops || 0
      b.net_chars += c.net_chars || 0
      b.open_count += c.open_count || 0
    }
  }
  return out
}

/** Sum each doc over the inclusive [from,to] day range (lexicographic). */
export function aggregate(merged, fromDay, toDay) {
  const out = {}
  for (const [docKey, days] of Object.entries(merged)) {
    let acc = null
    for (const [day, c] of Object.entries(days)) {
      if (day < fromDay || day > toDay) continue
      if (!acc) acc = { read_ms: 0, edit_ms: 0, edit_sessions: 0, mark_ops: 0, net_chars: 0, open_count: 0 }
      for (const k of Object.keys(acc)) acc[k] += c[k] || 0
    }
    if (acc) out[docKey] = acc
  }
  return out
}

function label(docKey) {
  const p = docKey.replace(/^(rel:|abs:)/, '')
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

export function renderOwnerDigest(agg, fromDay, toDay) {
  const rangeLabel = fromDay === toDay ? fromDay : `${fromDay} → ${toDay}`
  const rows = Object.entries(agg).map(([docKey, c]) => ({ label: label(docKey), ...c }))
    .sort((a, b) => (b.read_ms + b.edit_ms) - (a.read_ms + a.edit_ms))
  if (rows.length === 0) return `# 阅读数据 · ${rangeLabel}\n\n此区间没有阅读或编辑记录。\n`
  const totalEngage = rows.reduce((n, r) => n + r.read_ms + r.edit_ms, 0)
  const summary = `本区间你在 ${rows.length} 篇文档上共停留 ${fmtDuration(totalEngage)}，投入最多的是《${rows[0].label}》。`
  const header = '| 文档 | 阅读 | 编辑 | 编辑段 | 标注 |'
  const divider = '|---|---|---|---|---|'
  const body = rows.map((r) => `| ${r.label} | ${fmtDuration(r.read_ms)} | ${fmtDuration(r.edit_ms)} | ${r.edit_sessions} | ${r.mark_ops} |`)
  const totals = `| **合计** | ${fmtDuration(rows.reduce((n, r) => n + r.read_ms, 0))} | ${fmtDuration(rows.reduce((n, r) => n + r.edit_ms, 0))} | ${rows.reduce((n, r) => n + r.edit_sessions, 0)} | ${rows.reduce((n, r) => n + r.mark_ops, 0)} |`
  return [`# 阅读数据 · ${rangeLabel}`, '', summary, '', header, divider, ...body, totals, '', '<sub>由 M↓ Reading Insights CLI 生成</sub>', ''].join('\n')
}

function dayKey(ms, tz) {
  const d = new Date(ms + tz * 60000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
function addDays(day, delta) { return new Date(Date.parse(day + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10) }

/** preset: today|yesterday|7d|30d|month → { from, to } */
export function resolvePreset(preset, now, tz) {
  const today = dayKey(now, tz)
  switch (preset) {
    case 'today': return { from: today, to: today }
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y } }
    case '7d': return { from: addDays(today, -6), to: today }
    case '30d': return { from: addDays(today, -29), to: today }
    case 'month': return { from: today.slice(0, 8) + '01', to: today }
    default: return { from: today, to: today }
  }
}
```

- [ ] **Step 4:** Run tests, expect pass.

- [ ] **Step 5: Implement `scripts/insights-report.mjs`** (arg parsing + node:fs I/O)

```javascript
#!/usr/bin/env node
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mergeFiles, aggregate, renderOwnerDigest, resolvePreset } from './insights-report-core.mjs'

function arg(name, def) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const has = (name) => process.argv.includes(name)

const vault = arg('--vault', process.env.MDEDITOR_VAULT)
if (!vault) { console.error('usage: insights-report.mjs --vault <path> [--date yesterday|today] [--from YYYY-MM-DD --to YYYY-MM-DD] [--stdout]'); process.exit(2) }

const tz = -new Date().getTimezoneOffset()
let from = arg('--from'), to = arg('--to')
if (!from || !to) { const r = resolvePreset(arg('--date', 'yesterday'), Date.now(), tz); from = r.from; to = r.to }

const dir = join(vault, '.mdeditor', 'analytics')
const files = []
if (existsSync(dir)) {
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.json')) continue
    try { files.push({ name, json: JSON.parse(await readFile(join(dir, name), 'utf8')) }) } catch {}
  }
}
const md = renderOwnerDigest(aggregate(mergeFiles(files), from, to), from, to)

if (has('--stdout')) { process.stdout.write(md) }
else {
  const statDir = join(vault, 'stat')
  await mkdir(statDir, { recursive: true })
  const fname = from === to ? `${from}-daily-stat.md` : `${from}_${to}-stat.md`
  const out = join(statDir, fname)
  await writeFile(out, md)
  console.log(`wrote ${out}`)
}
```

- [ ] **Step 6: Smoke test** the CLI against a temp vault:

```bash
mkdir -p /tmp/vt/.mdeditor/analytics
echo '{"deviceId":"D1","deviceName":"Mac","day":"2026-07-08","docs":{"rel:a.md":{"read_ms":120000,"edit_ms":60000,"edit_sessions":2,"mark_ops":3,"net_chars":40,"open_count":1,"first_seen_at":0,"last_active_at":0}}}' > /tmp/vt/.mdeditor/analytics/2026-07-08.D1.json
node scripts/insights-report.mjs --vault /tmp/vt --from 2026-07-08 --to 2026-07-08 --stdout
```
Expected: a Chinese digest containing `a.md`, `2m 0s`, `合计`.

- [ ] **Step 7: Commit** `feat(insights): self-contained CLI daily report (owner digest)`.

---

## Task 4: Verification + docs

- [ ] **Step 1:** `pnpm check && pnpm test` → all green (report + core tests included). `pnpm vitest run scripts/insights-report-core.test.ts` passes.
- [ ] **Step 2:** Add a short "Reading Insights CLI" note to `README.md` (usage: `node scripts/insights-report.mjs --vault <path> --date yesterday`). Commit `docs(readme): reading-insights CLI usage`.
- [ ] **Step 3: Manual (human):** in-app — open Settings ▸ Insights, pick a range, click "Generate report" → a `stat/<...>.md` opens showing the digest table. CLI — run the smoke command against your real vault → digest written to `<vault>/stat/`.

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** one-click range→md digest saved to `stat/YYYY-MM-DD-daily-stat.md` (Tasks 1, 2); short prose summary + table (Task 1); CLI for external tools (Task 3) with `--date`/`--from`/`--to`/`--stdout`. In-app = owner+audience+value; CLI = owner-only (documented scope).
- **Drift guard:** `report.ts` (TS, in-app) and `insights-report-core.mjs` (CLI) share the `fmtDuration` shape and Chinese summary/format; both are unit-tested against explicit fixtures, so a formatting change that breaks parity fails a test. They intentionally differ in columns (CLI omits audience/value — owner-only).
- **Type consistency:** `renderDailyReport` consumes `InsightRow` (Phase 3, Task 3). The CLI core operates on the on-disk `DayFile.docs` shape (`docKey -> counters`) from Phase 1 — mirrored inline (dependency-free by design).
- **Reuse:** the in-app button reuses the panel's already-loaded `rows` + `fromDay`/`toDay` and Phase 3's `assembleRows`; no re-fetch logic is duplicated in the panel.
```
