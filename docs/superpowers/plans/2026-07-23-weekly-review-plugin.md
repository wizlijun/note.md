# Weekly Review Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone note.md v2 UI plugin that shows a traditional year calendar of `vault/weekly-review/` records — each ISO week is a boxed, clickable unit that opens its weekly-review `.md` in the main editor — plus one small host-API addition (`host.editor.open`) that lets any plugin open a vault file in the main editor.

**Architecture:** Pure-frontend Svelte 5 + Vite plugin (isolated webview, no Tauri IPC; all host effects via the injected `window.notemd.request`). Calendar is rendered Monday-start so one grid row == one ISO week; weeks with a review file are colored and clickable. Clicking calls the new `host.editor.open` bridge method, which the host resolves inside the vault and forwards to the existing `emit_open_file_delayed` + `show_main_window` main-window flow. A localStorage cache gives instant repaint; a "Rebuild" button forces a full re-list.

**Tech Stack:** Svelte 5, Vite 6, TypeScript, Vitest (pure-function tests); Rust (Tauri host: `host_api.rs` capability table + `ui_rpc.rs` dispatch/HostServices).

---

## File Structure

**New plugin project — `plugins-src/weekly-review/`:**
- `manifest.v2.json` — static declaration (tray + window + capabilities).
- `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html` — Vite/Svelte scaffold (copied from `roam-import`).
- `src/main.ts` — mounts `App.svelte`.
- `src/App.svelte` — layout: header (artistic year + toolbar) + `YearCalendar`; owns data load + state.
- `src/lib/bridge.ts` — typed `window.notemd` wrapper + `openInEditor`, `vaultInfo`, `vaultList`, `vaultExists`, `toast`.
- `src/lib/isoweek.ts` — ISO-week math + `buildMonthRows` (pure; Vitest).
- `src/lib/scan.ts` — filename parse + `buildIndex` (pure; Vitest).
- `src/lib/cache.ts` — localStorage cache of raw filenames keyed by vault root (Vitest).
- `src/lib/strings.ts` — self-contained i18n (en/zh/ja/de).
- `src/lib/components/YearCalendar.svelte` — 12 `MonthGrid` + legend.
- `src/lib/components/MonthGrid.svelte` — one month: weekday header + `WeekRow`s + watermark.
- `src/lib/components/WeekRow.svelte` — one ISO week (7-day boxed unit + state + click).
- `src/assets/brush-year.woff2` — bundled decorative font for the year number.
- `vitest.config.ts` — test runner config.
- `src/lib/*.test.ts` — unit tests colocated.

**Core host change (main program):**
- `src-tauri/src/plugin_runtime/host_api.rs` — add `host.editor.open → editor.open` to `method_capability` + test.
- `src-tauri/src/plugin_runtime/ui_rpc.rs` — `HostServices::open_in_editor` (default + `TauriServices` impl), `editor_open` handler, dispatch arm, StubServices override + dispatch test.

**Wiring/docs:**
- `scripts/dev-install-plugin.sh` — add `weekly-review` branch.
- `docs/plugin-v2-development.md` — add `editor.open` capability row + `host.editor.open` method row.

---

## Task 1: Core host API — `host.editor.open` capability mapping

**Files:**
- Modify: `src-tauri/src/plugin_runtime/host_api.rs` (`method_capability`, ~line 44; test ~line 779)

- [ ] **Step 1: Add the failing capability-table assertion**

In `host_api.rs`, find the test that lists `(method, capability)` pairs (around line 779, the vector beginning `("host.dialog.open", "dialog"),`). Add one line to that vector:

```rust
            ("host.editor.open", "editor.open"),
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `(cd src-tauri && cargo test --lib plugin_runtime::host_api 2>&1 | tail -20)` (crate name per `src-tauri/Cargo.toml` — if different, use that; the test module is `plugin_runtime::host_api`).
Expected: FAIL — `method_capability("host.editor.open")` returns `Some("__unknown__")`, not `Some("editor.open")`.

- [ ] **Step 3: Add the mapping**

In `method_capability` (the `match method {` block, after the `"host.clipboard.write" => Some("clipboard.write"),` arm), add:

```rust
        "host.editor.open" => Some("editor.open"),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `(cd src-tauri && cargo test --lib plugin_runtime::host_api 2>&1 | tail -20)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugin_runtime/host_api.rs
git commit -m "feat(plugin-host): map host.editor.open to editor.open capability"
```

---

## Task 2: Core host API — `open_in_editor` service + `editor_open` dispatch

**Files:**
- Modify: `src-tauri/src/plugin_runtime/ui_rpc.rs` (trait ~line 144; `TauriServices` impl ~line 595; handlers near `vault_*`; dispatch ~line 297; test StubServices ~line 682)

- [ ] **Step 1: Write the failing dispatch test**

In the `ui_rpc.rs` `#[cfg(test)] mod` (near the other `run(...)`-based tests, e.g. after the vault list test ~line 913), add:

```rust
    #[tokio::test]
    async fn editor_open_resolves_and_records() {
        let s = stub_with_vault(&[("weekly-review/2026-W30-weekly-review.md", "hi")]);
        let r = run(&s, &["editor.open"], "host.editor.open",
                    serde_json::json!({ "path": "weekly-review/2026-W30-weekly-review.md" })).await;
        assert_eq!(r.get("ok"), Some(&serde_json::json!(true)), "resp: {r:?}");
        let opened = s.opened.lock().unwrap();
        assert_eq!(opened.len(), 1);
        assert!(opened[0].ends_with("2026-W30-weekly-review.md"), "opened: {opened:?}");
    }

    #[tokio::test]
    async fn editor_open_rejects_escape() {
        let s = stub_with_vault(&[]);
        let r = run_err(&s, &["editor.open"], "host.editor.open",
                        serde_json::json!({ "path": "../secret.md" })).await;
        assert!(r.contains("escapes the vault"), "err: {r}");
    }
```

If helpers `stub_with_vault`, `run`, `run_err` do not already exist in this module with these exact shapes, use the existing test scaffolding instead: mirror the vault tests — build a `StubServices { vault: Some(tempdir), .. }`, write the file with `std::fs`, and call `run(&s, &["editor.open"], "host.editor.open", params)` (the existing `run` returns the `result` value; if only a raw-response helper exists, assert on `resp["result"]["ok"]`). Keep the two assertions: result `{ ok: true }` + `s.opened` recorded the resolved path.

- [ ] **Step 2: Add the recording field + override to StubServices**

In `StubServices` (struct ~line 682) add a field:

```rust
        /// recorded editor.open paths
        opened: Arc<Mutex<Vec<PathBuf>>>,
```

In `impl HostServices for StubServices` (~line 696) add:

```rust
        fn open_in_editor(&self, abs_path: &Path) -> Result<(), String> {
            self.opened.lock().unwrap().push(abs_path.to_path_buf());
            Ok(())
        }
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `(cd src-tauri && cargo test --lib plugin_runtime::ui_rpc::tests::editor_open 2>&1 | tail -30)`
Expected: FAIL — `host.editor.open` routes to the unknown-method arm (or `open_in_editor` default), so no `{ok:true}` / no recorded path.

- [ ] **Step 4: Add the trait default, TauriServices impl, handler, and dispatch arm**

In the `HostServices` trait (after `location_get` default ~line 159) add:

```rust
    /// Open a vault file in the main editor window. Default: unavailable
    /// (the process sink has no main-window context). `abs_path` is the
    /// vault-resolved absolute path from `resolve_in_vault`.
    fn open_in_editor(&self, _abs_path: &Path) -> Result<(), String> {
        Err("io: editor.open is only available from a plugin UI window".into())
    }
```

In `impl<R: tauri::Runtime> HostServices for TauriServices<R>` (~line 595, after `location_get`) add:

```rust
    fn open_in_editor(&self, abs_path: &Path) -> Result<(), String> {
        let s = abs_path
            .to_str()
            .ok_or_else(|| "io: path is not valid UTF-8".to_string())?;
        crate::emit_open_file_delayed(&self.app, s);
        crate::show_main_window(&self.app);
        Ok(())
    }
```

Add the handler next to `vault_mkdir` (~line 576):

```rust
/// `{ path } → { ok: true }`. Resolves a vault-relative path and opens it in
/// the main editor (focuses the main window). UI-bridge only — the process
/// sink's default `open_in_editor` returns an error.
pub(crate) fn editor_open(services: &dyn HostServices, params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let p = resolve_in_vault(services, params)?;
    services.open_in_editor(&p)?;
    Ok(serde_json::json!({ "ok": true }))
}
```

Add the dispatch arm in the `match method` block (after `"host.vault.mkdir" => vault_mkdir(...)`, ~line 308):

```rust
        "host.editor.open" => editor_open(services, &req.params),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `(cd src-tauri && cargo test --lib plugin_runtime::ui_rpc 2>&1 | tail -30)`
Expected: PASS (both new tests + existing ui_rpc tests).

- [ ] **Step 6: Update the dev-doc capability + method tables**

In `docs/plugin-v2-development.md`, §5 capability table add a row:

```
| `editor.open` | `host.editor.open` |
```

§6 "其它" method table add a row:

```
| `host.editor.open` | `editor.open` | `{ path }`(vault 相对)→ `{ ok:true }`;在主编辑器打开文件并聚焦主窗口。仅 UI 桥可用。 |
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/plugin_runtime/ui_rpc.rs docs/plugin-v2-development.md
git commit -m "feat(plugin-host): host.editor.open opens a vault file in the main editor"
```

---

## Task 3: Plugin scaffold (project + manifest, no logic yet)

**Files:**
- Create: `plugins-src/weekly-review/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `vitest.config.ts`
- Create: `plugins-src/weekly-review/src/main.ts`, `src/App.svelte`
- Create: `plugins-src/weekly-review/manifest.v2.json`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "weekly-review",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "vite build",
    "check": "svelte-check --tsconfig ./tsconfig.json",
    "test": "vitest run",
    "preview": "vite preview"
  },
  "devDependencies": {
    "@sveltejs/vite-plugin-svelte": "^5",
    "svelte": "^5",
    "svelte-check": "^4",
    "typescript": "^5",
    "vite": "^6",
    "vitest": "^3"
  }
}
```

- [ ] **Step 2: Create `vite.config.ts`** (identical relative-base config to roam-import)

```ts
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Standalone plugin UI bundle. Served by the host under `plugin://<id>/…`, so
// asset URLs MUST be relative (`base: './'`). dist/ is copied verbatim into the
// installed plugin's ui/ directory (see scripts/dev-install-plugin.sh).
export default defineConfig({
  plugins: [svelte()],
  base: './',
  build: {
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: false,
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: { index: 'index.html' } },
  },
})
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'jsdom', include: ['src/**/*.test.ts'] },
})
```

Add `jsdom` to devDependencies (for `cache.ts` localStorage tests): append `"jsdom": "^25"` to `package.json` devDependencies.

- [ ] **Step 4: Create `tsconfig.json`** (copy roam-import's)

```bash
cp plugins-src/roam-import/tsconfig.json plugins-src/weekly-review/tsconfig.json
```

- [ ] **Step 5: Create `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Weekly Review</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `src/main.ts`**

```ts
import { mount } from 'svelte'
import App from './App.svelte'

const app = mount(App, { target: document.getElementById('app')! })
export default app
```

- [ ] **Step 7: Create a placeholder `src/App.svelte`**

```svelte
<script lang="ts">
  // Filled in Task 9. Placeholder so the scaffold builds.
</script>

<main>Weekly Review</main>

<style>
  :global(:root) { color-scheme: light dark; }
</style>
```

- [ ] **Step 8: Create `manifest.v2.json`**

```json
{
  "manifest_version": 2,
  "id": "notemd.weekly-review",
  "name": "Weekly Review",
  "version": "1.0.0",
  "kind": "native",
  "engines": { "notemd": ">=6.722.1" },
  "description": "A year-at-a-glance calendar of your weekly reviews.",
  "ui": "ui/",
  "activation": { "events": ["onCommand:open"] },
  "contributes": {
    "menus": [
      { "location": "window", "label": "Weekly Review", "command": "open" }
    ],
    "windows": [
      {
        "id": "main",
        "entry": "index.html",
        "title": "Weekly Review",
        "width": 1000.0,
        "height": 720.0,
        "min_width": 820.0,
        "min_height": 560.0,
        "open_command": "open"
      }
    ],
    "tray": [ { "window": "main" } ]
  },
  "capabilities": ["vault.read", "editor.open", "toast"],
  "i18n": { "zh": { "name": "周检视", "menus": { "open": "周检视" } } }
}
```

> The `engines.notemd` value must be ≥ the version that ships Tasks 1–2. Confirm the current dev version (`node -e "console.log(require('./package.json').version)"` at repo root, or check `src-tauri/tauri.conf.json`) and set this to that upcoming release; leave `>=6.722.1` only if that already satisfies it.

- [ ] **Step 9: Install deps and verify the scaffold builds**

Run: `pnpm install && pnpm --filter weekly-review build`
Expected: `dist/index.html` + `dist/assets/*` produced, no errors.

- [ ] **Step 10: Commit**

```bash
git add plugins-src/weekly-review pnpm-lock.yaml
git commit -m "feat(weekly-review): scaffold v2 plugin project + manifest"
```

---

## Task 4: `isoweek.ts` — ISO-week math + month row builder

**Files:**
- Create: `plugins-src/weekly-review/src/lib/isoweek.ts`
- Test: `plugins-src/weekly-review/src/lib/isoweek.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { isoWeek, isoWeekYear, mondayOf, weeksInYear, buildMonthRows } from './isoweek'

describe('isoWeek', () => {
  it('2026-01-01 (Thu) is week 1 of 2026', () => {
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1)
    expect(isoWeekYear(new Date(2026, 0, 1))).toBe(2026)
  })
  it('2026-07-23 is week 30', () => {
    expect(isoWeek(new Date(2026, 6, 23))).toBe(30)
  })
  it('2026-12-28 (Mon) is week 53 — 2026 is a 53-week year', () => {
    expect(isoWeek(new Date(2026, 11, 28))).toBe(53)
    expect(weeksInYear(2026)).toBe(53)
  })
  it('2025 is a 52-week year', () => {
    expect(weeksInYear(2025)).toBe(52)
  })
})

describe('mondayOf', () => {
  it('returns the Monday 00:00 of the week', () => {
    const m = mondayOf(new Date(2026, 6, 23)) // Thu → Mon 2026-07-20
    expect(m.getFullYear()).toBe(2026)
    expect(m.getMonth()).toBe(6)
    expect(m.getDate()).toBe(20)
    expect(m.getHours()).toBe(0)
  })
})

describe('buildMonthRows', () => {
  it('groups July 2026 into ISO-week rows, Monday-first', () => {
    const rows = buildMonthRows(2026, 6) // July
    // First row contains W27 (Mon 2026-06-29); day 1..5 land in row for W27? No —
    // July 1 is Wed → belongs to W27 (Mon 06-29). Row for W27 shows only 1,2,3.
    expect(rows[0].week).toBe(27)
    expect(rows[0].days[0]).toBe(null) // Monday col = June 29, outside July → null
    expect(rows[0].days[2]).toBe(1)    // Wednesday col = July 1
    // A row that fully belongs to July, e.g. W30 (Mon 07-20):
    const w30 = rows.find(r => r.week === 30)!
    expect(w30.days).toEqual([20, 21, 22, 23, 24, 25, 26])
    // Every row has exactly 7 day slots:
    for (const r of rows) expect(r.days.length).toBe(7)
  })
  it('assigns the ISO week-numbering year on cross-year rows', () => {
    const jan = buildMonthRows(2026, 0)
    // Jan 1 2026 belongs to W1 whose Monday is 2025-12-29:
    expect(jan[0].week).toBe(1)
    expect(jan[0].weekYear).toBe(2026)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter weekly-review test 2>&1 | tail -20`
Expected: FAIL — module `./isoweek` not found.

- [ ] **Step 3: Implement `isoweek.ts`**

```ts
// ISO-8601 week math (Monday-start weeks). Pure functions — unit-tested.

/** ISO week number (1..53) for a local date. */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = (t.getUTCDay() + 6) % 7 // Mon=0..Sun=6
  t.setUTCDate(t.getUTCDate() - day + 3) // to Thursday of this week
  const firstTh = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  const fday = (firstTh.getUTCDay() + 6) % 7
  firstTh.setUTCDate(firstTh.getUTCDate() - fday + 3)
  return 1 + Math.round((t.getTime() - firstTh.getTime()) / (7 * 864e5))
}

/** ISO week-numbering year (differs from calendar year on the 1–3 boundary days). */
export function isoWeekYear(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - day + 3)
  return t.getUTCFullYear()
}

/** Monday 00:00 (local) of the week containing `d`. */
export function mondayOf(d: Date): Date {
  const x = new Date(d)
  const day = (x.getDay() + 6) % 7
  x.setDate(x.getDate() - day)
  x.setHours(0, 0, 0, 0)
  return x
}

/** 52 or 53 — the number of ISO weeks in a week-numbering year. */
export function weeksInYear(year: number): number {
  return isoWeek(new Date(year, 11, 28))
}

export interface MonthWeek {
  weekYear: number // ISO week-numbering year
  week: number // ISO week number 1..53
  monday: Date // local Monday 00:00 of this row's week
  days: (number | null)[] // length 7, Mon..Sun; day-of-month, or null if outside `month0`
}

/** Build the week rows for a calendar month (0-based `month0`), Monday-first.
 *  Each row is one ISO week; days outside the month are null. */
export function buildMonthRows(year: number, month0: number): MonthWeek[] {
  const last = new Date(year, month0 + 1, 0).getDate()
  const byMonday = new Map<number, MonthWeek>()
  const order: MonthWeek[] = []
  for (let dnum = 1; dnum <= last; dnum++) {
    const d = new Date(year, month0, dnum)
    const mon = mondayOf(d)
    const key = mon.getTime()
    let row = byMonday.get(key)
    if (!row) {
      row = { weekYear: isoWeekYear(d), week: isoWeek(d), monday: mon, days: [null, null, null, null, null, null, null] }
      byMonday.set(key, row)
      order.push(row)
    }
    const col = (d.getDay() + 6) % 7
    row.days[col] = dnum
  }
  return order
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter weekly-review test 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins-src/weekly-review/src/lib/isoweek.ts plugins-src/weekly-review/src/lib/isoweek.test.ts
git commit -m "feat(weekly-review): ISO-week math + month row builder"
```

---

## Task 5: `scan.ts` — filename parse + index build

**Files:**
- Create: `plugins-src/weekly-review/src/lib/scan.ts`
- Test: `plugins-src/weekly-review/src/lib/scan.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { WEEKLY_DIR, parseReviewName, buildIndex } from './scan'

describe('parseReviewName', () => {
  it('parses a padded ISO-week filename', () => {
    expect(parseReviewName('2026-W30-weekly-review.md')).toEqual({ year: 2026, week: 30 })
  })
  it('tolerates an unpadded week number', () => {
    expect(parseReviewName('2026-W3-weekly-review.md')).toEqual({ year: 2026, week: 3 })
  })
  it('rejects non-matching names', () => {
    expect(parseReviewName('2026-07-20-diary.md')).toBeNull()
    expect(parseReviewName('notes.md')).toBeNull()
    expect(parseReviewName('2026-W30-weekly-review.txt')).toBeNull()
  })
})

describe('buildIndex', () => {
  it('maps year→week→relative path and lists only years with data', () => {
    const idx = buildIndex([
      { name: '2026-W30-weekly-review.md', is_dir: false },
      { name: '2026-W3-weekly-review.md', is_dir: false },
      { name: '2025-W52-weekly-review.md', is_dir: false },
      { name: 'random.md', is_dir: false },
      { name: 'subdir', is_dir: true },
    ])
    expect(idx.years).toEqual([2025, 2026])
    expect(idx.byYear.get(2026)!.get(30)).toBe('weekly-review/2026-W30-weekly-review.md')
    expect(idx.byYear.get(2026)!.get(3)).toBe('weekly-review/2026-W3-weekly-review.md')
    expect(idx.byYear.get(2025)!.get(52)).toBe('weekly-review/2025-W52-weekly-review.md')
    expect(idx.byYear.has(9999)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter weekly-review test 2>&1 | tail -20`
Expected: FAIL — `./scan` not found.

- [ ] **Step 3: Implement `scan.ts`**

```ts
// Parse vault/weekly-review filenames into a year→week→path index.

export const WEEKLY_DIR = 'weekly-review'

const NAME_RE = /^(\d{4})-W(\d{1,2})-weekly-review\.md$/

/** Parse `YYYY-Www-weekly-review.md` → { year, week } (or null). Week may be unpadded. */
export function parseReviewName(name: string): { year: number; week: number } | null {
  const m = NAME_RE.exec(name)
  if (!m) return null
  const year = Number(m[1])
  const week = Number(m[2])
  if (week < 1 || week > 53) return null
  return { year, week }
}

export interface ReviewIndex {
  /** year → (ISO week number → vault-relative path of the review file) */
  byYear: Map<number, Map<number, string>>
  /** sorted ascending; only years that have at least one review file */
  years: number[]
}

/** Build the index from a `host.vault.list` entries array. */
export function buildIndex(entries: { name: string; is_dir: boolean }[]): ReviewIndex {
  const byYear = new Map<number, Map<number, string>>()
  for (const e of entries) {
    if (e.is_dir) continue
    const parsed = parseReviewName(e.name)
    if (!parsed) continue
    let weeks = byYear.get(parsed.year)
    if (!weeks) {
      weeks = new Map()
      byYear.set(parsed.year, weeks)
    }
    weeks.set(parsed.week, `${WEEKLY_DIR}/${e.name}`)
  }
  const years = [...byYear.keys()].sort((a, b) => a - b)
  return { byYear, years }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter weekly-review test 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins-src/weekly-review/src/lib/scan.ts plugins-src/weekly-review/src/lib/scan.test.ts
git commit -m "feat(weekly-review): weekly-review filename parser + index builder"
```

---

## Task 6: `cache.ts` — localStorage cache of raw filenames

**Files:**
- Create: `plugins-src/weekly-review/src/lib/cache.ts`
- Test: `plugins-src/weekly-review/src/lib/cache.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { loadCache, saveCache } from './cache'

beforeEach(() => localStorage.clear())

describe('cache', () => {
  it('round-trips entry names keyed by vault root', () => {
    saveCache('/Users/x/vault', ['2026-W30-weekly-review.md'])
    expect(loadCache('/Users/x/vault')).toEqual(['2026-W30-weekly-review.md'])
  })
  it('is isolated per vault root', () => {
    saveCache('/vault/a', ['a.md'])
    expect(loadCache('/vault/b')).toBeNull()
  })
  it('returns null on missing or corrupt data', () => {
    expect(loadCache('/nope')).toBeNull()
    localStorage.setItem('weekly-review:cache:/bad', '{not json')
    expect(loadCache('/bad')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter weekly-review test 2>&1 | tail -20`
Expected: FAIL — `./cache` not found.

- [ ] **Step 3: Implement `cache.ts`**

```ts
// Instant-repaint cache: the raw weekly-review directory filenames, keyed by
// vault root. buildIndex() reconstructs the ReviewIndex from these on load.

const PREFIX = 'weekly-review:cache:'

export function loadCache(vaultRoot: string): string[] | null {
  try {
    const raw = localStorage.getItem(PREFIX + vaultRoot)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) return null
    return parsed as string[]
  } catch {
    return null
  }
}

export function saveCache(vaultRoot: string, entries: string[]): void {
  try {
    localStorage.setItem(PREFIX + vaultRoot, JSON.stringify(entries))
  } catch {
    /* best-effort */
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter weekly-review test 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins-src/weekly-review/src/lib/cache.ts plugins-src/weekly-review/src/lib/cache.test.ts
git commit -m "feat(weekly-review): localStorage cache keyed by vault root"
```

---

## Task 7: `bridge.ts` — typed host bridge

**Files:**
- Create: `plugins-src/weekly-review/src/lib/bridge.ts`

- [ ] **Step 1: Create `bridge.ts`**

```ts
// Typed accessor for the host-injected `window.notemd` fetch-RPC bridge.
// A plugin window has ZERO Tauri IPC; every host effect goes through
// `notemd.request(method, params)`.

export interface NotemdBridge {
  pluginId: string
  locale: string // 'en' | 'zh' | 'ja' | 'de'
  theme: string
  request(method: string, params?: unknown): Promise<any>
  onMessage(cb: (payload: unknown) => void): void
}

declare global {
  interface Window {
    notemd: NotemdBridge
  }
}

export function bridge(): NotemdBridge {
  const b = window.notemd
  if (!b) throw new Error('window.notemd bridge missing (not running inside a plugin window)')
  return b
}

export interface VaultInfo {
  root: string | null
  wiki_dir: string | null
  daily_dir: string | null
}

/** `host.vault.info` → root + configured wiki/daily dir names. */
export function vaultInfo(): Promise<VaultInfo> {
  return bridge().request('host.vault.info')
}

/** `host.vault.exists` → whether a vault-relative path exists. */
export async function vaultExists(path: string): Promise<boolean> {
  const res: { exists: boolean } = await bridge().request('host.vault.exists', { path })
  return res.exists
}

/** `host.vault.list` → directory entries (name + is_dir), sorted by name. */
export async function vaultList(path: string): Promise<{ name: string; is_dir: boolean }[]> {
  const res: { entries: { name: string; is_dir: boolean }[] } = await bridge().request('host.vault.list', { path })
  return res.entries
}

/** `host.editor.open` — open a vault-relative file in the main editor (focuses main window). */
export async function openInEditor(path: string): Promise<void> {
  await bridge().request('host.editor.open', { path })
}

/** `host.toast` — surface a message through the host toast system (best-effort). */
export async function toast(level: 'success' | 'info' | 'warn' | 'error', message: string, detail?: string): Promise<void> {
  try {
    await bridge().request('host.toast', { level, message, detail })
  } catch {
    /* best-effort */
  }
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter weekly-review check 2>&1 | tail -20`
Expected: no errors from `bridge.ts` (App.svelte placeholder may report unused; acceptable until Task 9).

- [ ] **Step 3: Commit**

```bash
git add plugins-src/weekly-review/src/lib/bridge.ts
git commit -m "feat(weekly-review): typed window.notemd bridge with openInEditor"
```

---

## Task 8: `strings.ts` — self-contained i18n

**Files:**
- Create: `plugins-src/weekly-review/src/lib/strings.ts`

- [ ] **Step 1: Create `strings.ts`**

```ts
import { bridge } from './bridge'

export type MessageKey =
  | 'title'
  | 'thisWeek'
  | 'rebuild'
  | 'legend.review'
  | 'legend.today'
  | 'legend.past'
  | 'legend.future'
  | 'empty.noVault'
  | 'empty.noData'
  | 'tip.review'
  | 'tip.none'
  | 'tip.future'

type Catalog = Record<MessageKey, string>

const en: Catalog = {
  title: 'Weekly Review',
  thisWeek: 'This week',
  rebuild: 'Rebuild',
  'legend.review': 'Has review (click to open)',
  'legend.today': 'This week',
  'legend.past': 'Past',
  'legend.future': 'Upcoming',
  'empty.noVault': 'Configure a Vault to see your weekly reviews.',
  'empty.noData': 'No weekly reviews yet. Add files to the weekly-review/ folder.',
  'tip.review': 'has review — click to open',
  'tip.none': 'no review',
  'tip.future': 'upcoming',
}

const zh: Catalog = {
  title: '周检视',
  thisWeek: '本周',
  rebuild: '重构',
  'legend.review': '有周报(点击打开)',
  'legend.today': '本周',
  'legend.past': '已过去',
  'legend.future': '未来',
  'empty.noVault': '请先配置 Vault,才能查看每周检视。',
  'empty.noData': '还没有周报。把文件放进 weekly-review/ 目录。',
  'tip.review': '有周报 · 点击打开',
  'tip.none': '无',
  'tip.future': '未来',
}

const ja: Catalog = {
  title: 'ウィークリーレビュー',
  thisWeek: '今週',
  rebuild: '再構築',
  'legend.review': 'レビューあり(クリックで開く)',
  'legend.today': '今週',
  'legend.past': '過去',
  'legend.future': '今後',
  'empty.noVault': 'Vault を設定するとレビューが表示されます。',
  'empty.noData': 'まだレビューがありません。weekly-review/ に追加してください。',
  'tip.review': 'レビューあり · クリックで開く',
  'tip.none': 'なし',
  'tip.future': '今後',
}

const de: Catalog = {
  title: 'Wochenrückblick',
  thisWeek: 'Diese Woche',
  rebuild: 'Neu aufbauen',
  'legend.review': 'Rückblick vorhanden (zum Öffnen klicken)',
  'legend.today': 'Diese Woche',
  'legend.past': 'Vergangen',
  'legend.future': 'Bevorstehend',
  'empty.noVault': 'Konfiguriere ein Vault, um deine Rückblicke zu sehen.',
  'empty.noData': 'Noch keine Rückblicke. Lege Dateien im Ordner weekly-review/ ab.',
  'tip.review': 'Rückblick vorhanden · zum Öffnen klicken',
  'tip.none': 'keiner',
  'tip.future': 'bevorstehend',
}

const catalogs: Record<string, Catalog> = { en, zh, ja, de }

export function t(key: MessageKey): string {
  const loc = (() => {
    try {
      return bridge().locale
    } catch {
      return 'en'
    }
  })()
  const cat = catalogs[loc] ?? en
  return cat[key] ?? en[key]
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter weekly-review check 2>&1 | tail -20`
Expected: no errors from `strings.ts`.

- [ ] **Step 3: Commit**

```bash
git add plugins-src/weekly-review/src/lib/strings.ts
git commit -m "feat(weekly-review): self-contained i18n strings (en/zh/ja/de)"
```

---

## Task 9: Svelte UI — WeekRow, MonthGrid, YearCalendar, App

**Files:**
- Create: `plugins-src/weekly-review/src/lib/components/WeekRow.svelte`, `MonthGrid.svelte`, `YearCalendar.svelte`
- Create: `plugins-src/weekly-review/src/assets/brush-year.woff2` (bundled decorative font)
- Modify: `plugins-src/weekly-review/src/App.svelte`

> Visual reference: `docs/superpowers/specs/2026-07-23-weekly-review-plugin-mockup.html`. Match its layout, colors (light+dark via CSS vars), and states.

- [ ] **Step 1: Add the decorative year font**

Obtain a redistributable brush/script `.woff2` (e.g. a SIL/OFL brush font) and save as `src/assets/brush-year.woff2`. If none is bundled, the `@font-face` in App.svelte falls back to the system cursive stack — the UI must still render correctly without the file. (Do not block on the font; fallback is acceptable for first release.)

- [ ] **Step 2: Create `WeekRow.svelte`**

```svelte
<script lang="ts">
  import type { MonthWeek } from '../isoweek'
  import { t } from '../strings'

  interface Props {
    row: MonthWeek
    reviewPath: string | null // vault-relative path if this week has a review, else null
    isToday: boolean
    isFuture: boolean
    onOpen: (path: string) => void
  }
  let { row, reviewPath, isToday, isFuture, onOpen }: Props = $props()

  const DOW_WEEKEND = [false, false, false, false, false, true, true] // Sat, Sun
  const state = $derived(reviewPath ? 'review' : isFuture ? 'future' : 'past')
  const tip = $derived(
    `${row.weekYear}-W${String(row.week).padStart(2, '0')} · ` +
      (reviewPath ? t('tip.review') : isFuture ? t('tip.future') : t('tip.none')),
  )
</script>

<div
  class="wk {state}"
  class:today={isToday}
  class:clickable={!!reviewPath}
  title={tip}
  role={reviewPath ? 'button' : undefined}
  tabindex={reviewPath ? 0 : undefined}
  onclick={() => reviewPath && onOpen(reviewPath)}
  onkeydown={(e) => reviewPath && (e.key === 'Enter' || e.key === ' ') && onOpen(reviewPath)}
>
  {#each row.days as d, i}
    <span class="day" class:we={DOW_WEEKEND[i]} class:empty={d === null}>{d ?? '·'}</span>
  {/each}
</div>

<style>
  .wk {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    border-radius: 7px;
    border: 1px solid transparent;
  }
  .wk.past { background: var(--past); }
  .wk.future { border-color: var(--future-line); }
  .wk.review { background: var(--accent); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.13); }
  .wk.clickable { cursor: pointer; }
  .wk.today { outline: 2.5px solid var(--today-ring); outline-offset: 1px; }
  .day {
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
  }
  .wk.past .day { color: var(--past-day); }
  .wk.future .day { color: var(--future-day); }
  .day.we { color: var(--weekend); }
  .day.empty { color: transparent; }
  .wk.review .day { color: var(--accent-fg); }
  .wk.review .day.we { color: #ffe0dd; }
</style>
```

- [ ] **Step 3: Create `MonthGrid.svelte`**

```svelte
<script lang="ts">
  import { buildMonthRows } from '../isoweek'
  import WeekRow from './WeekRow.svelte'

  interface Props {
    year: number
    month0: number // 0-based
    weeks: Map<number, string> | undefined // ISO week → review path for this year
    todayMondayMs: number
    onOpen: (path: string) => void
  }
  let { year, month0, weeks, todayMondayMs, onOpen }: Props = $props()

  const DOW = ['一', '二', '三', '四', '五', '六', '日']
  const rows = $derived(buildMonthRows(year, month0))
</script>

<div class="month">
  <div class="wm">{month0 + 1}</div>
  <div class="mtitle">{month0 + 1}月</div>
  <div class="dow">
    {#each DOW as d, i}<span class:we={i >= 5}>{d}</span>{/each}
  </div>
  <div class="weeks">
    {#each rows as row}
      <WeekRow
        {row}
        reviewPath={weeks?.get(row.week) ?? null}
        isToday={row.monday.getTime() === todayMondayMs}
        isFuture={row.monday.getTime() > todayMondayMs}
        {onOpen}
      />
    {/each}
  </div>
</div>

<style>
  .month { position: relative; }
  .wm {
    position: absolute;
    right: 2px;
    top: 12px;
    font-size: 52px;
    font-weight: 800;
    color: var(--wm);
    z-index: 0;
    pointer-events: none;
    letter-spacing: -2px;
  }
  .mtitle { font-weight: 700; font-size: 13px; margin: 0 0 4px 2px; position: relative; z-index: 1; }
  .dow { display: grid; grid-template-columns: repeat(7, 1fr); position: relative; z-index: 1; }
  .dow span { text-align: center; font-size: 10px; color: var(--muted); font-weight: 600; padding-bottom: 2px; }
  .dow span.we { color: var(--weekend); }
  .weeks { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 2px; }
</style>
```

- [ ] **Step 4: Create `YearCalendar.svelte`**

```svelte
<script lang="ts">
  import MonthGrid from './MonthGrid.svelte'
  import { t } from '../strings'

  interface Props {
    year: number
    weeks: Map<number, string> | undefined // ISO week → path for `year`
    todayMondayMs: number
    onOpen: (path: string) => void
  }
  let { year, weeks, todayMondayMs, onOpen }: Props = $props()
  const months = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
</script>

<div class="cal">
  {#each months as m}
    <MonthGrid {year} month0={m} {weeks} {todayMondayMs} {onOpen} />
  {/each}
</div>

<div class="legend">
  <div class="it"><span class="sw review"></span>{t('legend.review')}</div>
  <div class="it"><span class="sw today"></span>{t('legend.today')}</div>
  <div class="it"><span class="sw past"></span>{t('legend.past')}</div>
  <div class="it"><span class="sw future"></span>{t('legend.future')}</div>
</div>

<style>
  .cal { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px 18px; padding: 8px 22px 16px; }
  .legend {
    display: flex;
    gap: 16px;
    margin: 2px 22px 16px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
    font-size: 11.5px;
    color: var(--muted);
    flex-wrap: wrap;
  }
  .legend .it { display: flex; align-items: center; gap: 6px; }
  .sw { width: 22px; height: 15px; border-radius: 5px; }
  .sw.review { background: var(--accent); }
  .sw.today { background: var(--past); outline: 2.5px solid var(--today-ring); outline-offset: -2px; }
  .sw.past { background: var(--past); }
  .sw.future { background: transparent; border: 1px solid var(--future-line); }
</style>
```

- [ ] **Step 5: Implement `App.svelte`** (data load, cache, year selection, toolbar, theme vars)

```svelte
<script lang="ts">
  import { vaultInfo, vaultList, vaultExists, openInEditor, toast } from './lib/bridge'
  import { buildIndex, WEEKLY_DIR, type ReviewIndex } from './lib/scan'
  import { mondayOf, isoWeek, isoWeekYear } from './lib/isoweek'
  import { t } from './lib/strings'
  import YearCalendar from './lib/components/YearCalendar.svelte'

  let vaultRoot = $state<string | null>(null)
  let index = $state<ReviewIndex>({ byYear: new Map(), years: [] })
  let selectedYear = $state<number>(new Date().getFullYear())
  let loading = $state(true)
  let noVault = $state(false)

  const now = new Date()
  const todayMondayMs = mondayOf(now).getTime()
  const currentYear = now.getFullYear()

  const weeksForYear = $derived(index.byYear.get(selectedYear))

  function pickDefaultYear(idx: ReviewIndex): number {
    if (idx.byYear.has(currentYear)) return currentYear
    if (idx.years.length) return idx.years[idx.years.length - 1]
    return currentYear
  }

  async function loadFromCache() {
    const { loadCache } = await import('./lib/cache')
    if (!vaultRoot) return
    const names = loadCache(vaultRoot)
    if (names) {
      index = buildIndex(names.map((name) => ({ name, is_dir: false })))
      selectedYear = pickDefaultYear(index)
    }
  }

  async function scan(force = false) {
    try {
      const info = await vaultInfo()
      vaultRoot = info.root
      if (!vaultRoot) {
        noVault = true
        loading = false
        return
      }
      if (!force) await loadFromCache()
      const exists = await vaultExists(WEEKLY_DIR)
      const entries = exists ? await vaultList(WEEKLY_DIR) : []
      index = buildIndex(entries)
      if (!index.byYear.has(selectedYear)) selectedYear = pickDefaultYear(index)
      const { saveCache } = await import('./lib/cache')
      saveCache(vaultRoot, entries.map((e) => e.name))
    } catch (e) {
      await toast('error', t('title'), String(e))
    } finally {
      loading = false
    }
  }

  function goThisWeek() {
    selectedYear = currentYear
  }

  async function onOpen(path: string) {
    try {
      await openInEditor(path)
    } catch (e) {
      await toast('error', t('title'), String(e))
    }
  }

  scan()
</script>

<div class="app">
  <header class="head">
    <div class="yearart">{selectedYear}</div>
    <div class="subtitle">{t('title')}</div>
    <div class="spacer"></div>
    <div class="toolbar">
      <button class="arrow" onclick={() => (selectedYear -= 1)} aria-label="prev year">‹</button>
      <div class="years">
        {#each index.years as y}
          <button class="ychip" class:active={y === selectedYear} onclick={() => (selectedYear = y)}>{y}</button>
        {/each}
      </div>
      <button class="arrow" onclick={() => (selectedYear += 1)} aria-label="next year">›</button>
      <button class="tbtn accent" onclick={goThisWeek}>◎ {t('thisWeek')}</button>
      <button class="tbtn" onclick={() => scan(true)}>↻ {t('rebuild')}</button>
    </div>
  </header>

  {#if noVault}
    <div class="empty">{t('empty.noVault')}</div>
  {:else if !loading && index.years.length === 0}
    <div class="empty">{t('empty.noData')}</div>
  {:else}
    <YearCalendar year={selectedYear} weeks={weeksForYear} {todayMondayMs} {onOpen} />
  {/if}
</div>

<style>
  @font-face {
    font-family: 'BrushYear';
    src: url('./assets/brush-year.woff2') format('woff2');
    font-display: swap;
  }
  :global(:root) {
    color-scheme: light dark;
    --bg: #fff; --fg: #22252a; --muted: #9aa0a8; --line: #e6e8ec; --wm: #f0f1f4;
    --chip-bg: #f2f3f5; --chip-active: #2f6feb;
    --accent: #2f6feb; --accent-fg: #fff;
    --past: #f1f2f4; --past-day: #aeb4bc;
    --future-line: #eaecef; --future-day: #c6ccd4;
    --today-ring: #ff9500; --weekend: #e0605a; --yearart: #d21f2b;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #191b1f; --fg: #e7e9ec; --muted: #7b8189; --line: #2a2d33; --wm: #212429;
      --chip-bg: #2a2d33; --chip-active: #3b82f6;
      --accent: #4b8bff; --accent-fg: #fff;
      --past: #212429; --past-day: #6b717a;
      --future-line: #282b31; --future-day: #565c65;
      --today-ring: #ffa726; --weekend: #e0736d; --yearart: #ff5a63;
    }
  }
  :global(body) { margin: 0; background: var(--bg); color: var(--fg);
    font: 12px/1.35 -apple-system, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif; }
  .head { display: flex; align-items: center; gap: 18px; padding: 14px 22px 6px; }
  .yearart { font-family: 'BrushYear', 'Snell Roundhand', 'Zapfino', cursive; font-weight: 700;
    font-style: italic; font-size: 58px; line-height: 1; color: var(--yearart); }
  .subtitle { font-size: 13px; color: var(--muted); font-weight: 600; letter-spacing: 3px; }
  .spacer { flex: 1; }
  .toolbar { display: flex; align-items: center; gap: 8px; }
  .arrow { width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--line);
    background: var(--chip-bg); color: var(--fg); font-size: 14px; cursor: pointer; }
  .years { display: flex; gap: 5px; }
  .ychip { padding: 4px 11px; border-radius: 20px; background: var(--chip-bg); color: var(--fg);
    font-weight: 600; font-size: 12px; cursor: pointer; border: none; }
  .ychip.active { background: var(--chip-active); color: #fff; }
  .tbtn { display: flex; align-items: center; gap: 5px; padding: 5px 11px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--chip-bg); color: var(--fg);
    font-weight: 600; font-size: 12px; cursor: pointer; }
  .tbtn.accent { border-color: var(--accent); color: var(--accent); background: transparent; }
  .empty { padding: 60px 22px; text-align: center; color: var(--muted); font-size: 13px; }
</style>
```

- [ ] **Step 6: Type-check and build**

Run: `pnpm --filter weekly-review check && pnpm --filter weekly-review build 2>&1 | tail -20`
Expected: no type errors; `dist/` built.

- [ ] **Step 7: Commit**

```bash
git add plugins-src/weekly-review/src
git commit -m "feat(weekly-review): calendar UI — WeekRow/MonthGrid/YearCalendar + App"
```

---

## Task 10: dev-install branch + full verification

**Files:**
- Modify: `scripts/dev-install-plugin.sh` (arg list ~line 34, usage ~line 4; add a branch after the `decision-log` branch ~line 174)

- [ ] **Step 1: Add `weekly-review` to the arg allowlist**

In `scripts/dev-install-plugin.sh`, add `weekly-review` to the `case "$arg"` match (line ~34) and both usage strings (lines ~4 and ~35):

```sh
    md2pdf|roam-import|openclaw|cef|exlibris|pos-log|decision-log|weekly-review) PLUGIN="$arg" ;;
```

- [ ] **Step 2: Add the install branch**

Before the final `fi` (~line 174), add an `elif` branch mirroring decision-log:

```sh
elif [[ "$PLUGIN" == "weekly-review" ]]; then
  SRC="plugins-src/weekly-review"
  # Build the standalone UI bundle (dist/). Pure UI plugin; no native backend.
  pnpm --filter weekly-review build
  VERSION=$(node -e "console.log(require('./$SRC/manifest.v2.json').version)")
  DEST="$ROOT/notemd.weekly-review/$VERSION"
  rm -rf "$DEST"
  mkdir -p "$DEST/ui"
  cp -R "$SRC/dist/." "$DEST/ui/"
  cp "$SRC/manifest.v2.json" "$DEST/manifest.json"
  ln -sfn "$VERSION" "$ROOT/notemd.weekly-review/current"
  mark_installed "notemd.weekly-review" "$VERSION"
  echo "✓ installed notemd.weekly-review@$VERSION (ui-only) → $DEST"
  echo "  enable the v2 runtime:  \"plugins_v2.enabled\": true in settings.json, or NOTEMD_PLUGINS_V2=1"
fi
```

- [ ] **Step 3: Run the full automated suite (Rust + plugin unit tests)**

Run:
```bash
(cd src-tauri && cargo test --lib plugin_runtime 2>&1 | tail -20)
pnpm --filter weekly-review test 2>&1 | tail -20
pnpm --filter weekly-review check 2>&1 | tail -20
(cd plugin-protocol && cargo test 2>&1 | tail -10)
```
Expected: all PASS.

- [ ] **Step 4: Install for dev**

Run: `scripts/dev-install-plugin.sh weekly-review`
Expected: `✓ installed notemd.weekly-review@1.0.0 (ui-only)`.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-install-plugin.sh
git commit -m "chore(weekly-review): dev-install-plugin.sh branch"
```

- [ ] **Step 6: MANUAL GUI VERIFICATION (hand to user — do not automate)**

Provide the user these steps (per project convention, the user tests the GUI):
1. Ensure `weekly-review/` in the vault has a few `YYYY-Www-weekly-review.md` files (e.g. `2026-W30-weekly-review.md`). Create sample files if needed.
2. Launch dev: `NOTEMD_PLUGINS_V2=1 pnpm tauri dev`.
3. Menu-bar **tray** dropdown → **Weekly Review** (or 周检视) → window opens.
4. Verify: 12-month calendar; artistic year; week rows boxed; reviewed weeks blue; **current week** (this week) orange-ringed; past gray; future outlined; year chips list only years with data.
5. Click a **blue** week → main editor opens that `.md` and the main window comes to front.
6. Click **◎ This week** → jumps to the current year.
7. Add a new review file on disk → click **↻ Rebuild** → the new week turns blue without restart.
8. Toggle system Light/Dark → colors follow.

---

## Task 11: Publish to the marketplace

> Only after Task 10 Step 6 (manual GUI verification) passes. Follows `project_plugin_index_merge_publish` — the index MUST merge, never wholesale-replace.

- [ ] **Step 1: Package the plugin**

Run: `scripts/release-plugins.sh weekly-review` (or the repo's documented plugin-release entry; produces `dist-plugins/notemd.weekly-review/1.0.0/*.notemdpkg` + metadata).

- [ ] **Step 2: Regenerate the marketplace index (MERGE)**

Run: `node scripts/gen-plugin-index.mjs` (default merges into the live index; do NOT pass `--drop`). Verify the output `index.json` still lists the other 6 plugins plus `notemd.weekly-review`.

- [ ] **Step 3: Deploy the index/artifacts** per the plugins.notemd.net publish flow (same as the last plugin release; confirm `gh` active account is `wizlijun` first).

- [ ] **Step 4: Commit any release metadata and push**

```bash
git add -A dist-plugins docs
git commit -m "release(weekly-review): publish notemd.weekly-review@1.0.0 to marketplace"
```

---

## Self-Review Notes

- **Spec §4 host.editor.open** → Tasks 1–2 (capability + service + dispatch + tests + dev-doc). ✓
- **Spec §2 scaffold / §3 manifest** → Task 3. ✓
- **Spec §6 ISO-week rendering** → Task 4 (`isoweek.ts`) + Task 9 (components). ✓
- **Spec §5 scan + cache/incremental + rebuild** → Task 5 (`scan.ts`), Task 6 (`cache.ts`), Task 9 (`scan(force)` + Rebuild button). ✓
- **Spec §7 interactions (open, This week, Rebuild, year switch)** → Task 9 App.svelte. ✓
- **Spec §8 theme (color-scheme, light/dark vars, artistic font)** → Task 9. ✓
- **Spec §9 i18n** → Task 8. ✓
- **Spec §10 tests** → Rust (Tasks 1–2), Vitest (Tasks 4–6), manual GUI (Task 10 Step 6). ✓
- **Spec §11 build/install/publish** → Task 10 + Task 11. ✓
- **Type consistency:** `ReviewIndex { byYear: Map<number, Map<number,string>>, years:number[] }`, `MonthWeek { weekYear, week, monday, days }`, `openInEditor(path)`, `buildIndex(entries)`, `buildMonthRows(year, month0)`, `mondayOf/isoWeek/isoWeekYear/weeksInYear` — used identically across Tasks 4/5/9. ✓
- **Open items flagged, not placeheld:** `engines.notemd` exact version (Task 3 Step 8 note); brush font file optional with fallback (Task 9 Step 1); crate name for `cargo test` is `notemd` (verified in `src-tauri/Cargo.toml`); exact plugin-release script name (Task 11 — use repo's documented entry).
