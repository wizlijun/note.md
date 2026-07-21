# Unified Log Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single centralized log window (`logs.html`) that aggregates backend, frontend, git-sync, and plugin logs into one ring buffer with source+category filtering; re-point the tray "View Log…" entry to open it filtered to git-sync.

**Architecture:** A Rust singleton `LogBus` (`OnceLock`) owns a 3000-line ring buffer, appends to `logs/app.log`, and emits `log://line`. New log calls flow in via `log_info!/log_warn!/log_error!` (category=core) and `log_cat!` (git-sync/plugins). Existing `vault_sync::LogBuffer::push` and plugin `append_plugin_log` gain a one-line mirror into the bus — no existing storage touched. A standalone Svelte 5 window replays the snapshot, tails live lines, and offers source/category/level/keyword filters. Tray git-sync entry opens the window preset to category=git-sync via `nav://logs-filter`.

**Tech Stack:** Rust / Tauri 2, Svelte 5 (runes), Vite multi-entry, Vitest.

---

## File Structure

**Create:**
- `src-tauri/src/log_bus.rs` — the log bus (buffer, macros, commands, timestamp helper)
- `logs.html` — window entry
- `src/logs-main.ts` — mount root
- `src/logs-app.svelte` — the log viewer UI
- `src/lib/logs/console-bridge.ts` — patches `console.*` → `logs_append_frontend`
- `src/lib/logs/logs-store.svelte.ts` — snapshot replay + live tail + filter state
- `src/lib/logs/logs-store.test.ts`, `src/lib/logs/console-bridge.test.ts`

**Modify:**
- `src-tauri/src/lib.rs` — `mod log_bus`, `log_bus::init` in setup, register 3 commands, dlog dual-write, `open_logs_window`, tray re-point, View menu item, `menu_label` `view.logs`
- `src-tauri/src/vault_sync/log_buffer.rs` — mirror `push` into bus (category=git-sync)
- `src-tauri/src/plugin_runtime/process.rs` — mirror `append_plugin_log` into bus (category=plugin:id)
- `src-tauri/capabilities/default.json` — add `logs` window
- `vite.config.ts` — add `logs` input + optimizeDeps entry
- `src/main.ts` — install console bridge on startup
- `src/lib/i18n/en.ts` (+ zh partial) — logs.* keys

---

## Task 1: Log bus core + timestamp helper + unit tests

**Files:**
- Create: `src-tauri/src/log_bus.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod log_bus;` near other `pub mod` lines ~17-43)

- [ ] **Step 1: Write `log_bus.rs` with the bus, timestamp helper, commands, macros, and tests**

```rust
//! Unified log bus: merges backend main-process + frontend webview + git-sync +
//! plugin sources into a single ring buffer, lands them in `logs/app.log`, and
//! emits `log://line` to the "View Logs" window. Only NEW log calls flow in —
//! existing vault_sync/plugin stores are untouched, they mirror one line here.
use serde::Serialize;
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const MAX_LINES: usize = 3000;

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub ts: String,       // RFC3339 millis UTC, e.g. 2026-07-21T08:12:33.456Z
    pub source: String,   // "backend" | "frontend"
    pub category: String, // "core" | "git-sync" | "plugin:<id>" | "frontend"
    pub level: String,    // "debug" | "info" | "warn" | "error"
    pub message: String,
}

struct LogBus {
    buffer: Mutex<VecDeque<LogLine>>,
    app: OnceLock<AppHandle>,
    file: Mutex<Option<File>>,
}

impl LogBus {
    fn new() -> Self {
        LogBus {
            buffer: Mutex::new(VecDeque::with_capacity(MAX_LINES)),
            app: OnceLock::new(),
            file: Mutex::new(None),
        }
    }

    fn record(&self, line: LogLine) {
        if let Ok(mut buf) = self.buffer.lock() {
            buf.push_back(line.clone());
            while buf.len() > MAX_LINES {
                buf.pop_front();
            }
        }
        if let Ok(mut f) = self.file.lock() {
            if let Some(file) = f.as_mut() {
                let _ = writeln!(
                    file,
                    "{} [{}/{}/{}] {}",
                    line.ts, line.source, line.category, line.level, line.message
                );
            }
        }
        if let Some(app) = self.app.get() {
            let _ = app.emit("log://line", &line);
        }
    }
}

fn bus() -> &'static LogBus {
    static BUS: OnceLock<LogBus> = OnceLock::new();
    BUS.get_or_init(LogBus::new)
}

/// RFC3339 millis UTC without pulling in `chrono` (src-tauri has no such dep).
/// Uses Howard Hinnant's days->civil algorithm.
fn now_rfc3339() -> String {
    let dur = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format_rfc3339(dur.as_secs() as i64, dur.subsec_millis())
}

fn format_rfc3339(epoch_secs: i64, millis: u32) -> String {
    let days = epoch_secs.div_euclid(86_400);
    let secs_of_day = epoch_secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, hh, mm, ss, millis
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn push(level: &str, message: String) {
    push_cat("core", "backend", level, message);
}

pub fn push_cat(category: &str, source: &str, level: &str, message: String) {
    eprintln!("[{category}] {message}"); // dev stderr mirror
    bus().record(LogLine {
        ts: now_rfc3339(),
        source: source.into(),
        category: category.into(),
        level: level.into(),
        message,
    });
}

pub fn snapshot() -> Vec<LogLine> {
    bus().buffer.lock().map(|b| b.iter().cloned().collect()).unwrap_or_default()
}

pub fn clear() {
    if let Ok(mut b) = bus().buffer.lock() {
        b.clear();
    }
}

pub fn init(app: AppHandle) {
    let _ = bus().app.set(app.clone());
    if let Ok(dir) = app.path().app_data_dir() {
        let logs_dir = dir.join("logs");
        let _ = std::fs::create_dir_all(&logs_dir);
        if let Ok(file) = OpenOptions::new().create(true).append(true).open(logs_dir.join("app.log")) {
            if let Ok(mut slot) = bus().file.lock() {
                *slot = Some(file);
            }
        }
    }
}

#[tauri::command]
pub fn logs_append_frontend(level: String, message: String) {
    let level = if matches!(level.as_str(), "debug" | "info" | "warn" | "error") {
        level
    } else {
        "info".into()
    };
    bus().record(LogLine {
        ts: now_rfc3339(),
        source: "frontend".into(),
        category: "frontend".into(),
        level,
        message,
    });
}

#[tauri::command]
pub fn logs_get_snapshot() -> Vec<LogLine> {
    snapshot()
}

#[tauri::command]
pub fn logs_clear() {
    clear()
}

#[macro_export]
macro_rules! log_info {
    ($($a:tt)*) => { $crate::log_bus::push("info", format!($($a)*)) };
}
#[macro_export]
macro_rules! log_warn {
    ($($a:tt)*) => { $crate::log_bus::push("warn", format!($($a)*)) };
}
#[macro_export]
macro_rules! log_error {
    ($($a:tt)*) => { $crate::log_bus::push("error", format!($($a)*)) };
}
/// Category-tagged variant for git-sync / plugins. `$cat` and `$lvl` are string
/// literals; the rest is a `format!` payload.
#[macro_export]
macro_rules! log_cat {
    ($cat:expr, $lvl:expr, $($a:tt)*) => {
        $crate::log_bus::push_cat($cat, "backend", $lvl, format!($($a)*))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_drops_oldest_and_keeps_newest() {
        clear();
        for i in 0..(MAX_LINES + 5) {
            push_cat("core", "backend", "info", format!("line {i}"));
        }
        let snap = snapshot();
        assert_eq!(snap.len(), MAX_LINES);
        assert_eq!(snap.last().unwrap().message, format!("line {}", MAX_LINES + 4));
        clear();
    }

    #[test]
    fn clear_empties_buffer() {
        clear();
        push_cat("core", "backend", "info", "hi".into());
        clear();
        assert!(snapshot().is_empty());
    }

    #[test]
    fn category_and_source_pass_through() {
        clear();
        push_cat("git-sync", "backend", "warn", "conflict".into());
        let last = snapshot().pop().unwrap();
        assert_eq!(last.category, "git-sync");
        assert_eq!(last.source, "backend");
        assert_eq!(last.level, "warn");
        clear();
    }

    #[test]
    fn frontend_command_forces_category_and_defaults_bad_level() {
        clear();
        logs_append_frontend("bogus".into(), "msg".into());
        let last = snapshot().pop().unwrap();
        assert_eq!(last.category, "frontend");
        assert_eq!(last.source, "frontend");
        assert_eq!(last.level, "info");
        clear();
    }

    #[test]
    fn rfc3339_matches_known_epoch() {
        // 2021-01-01T00:00:00.000Z == 1609459200 s
        assert_eq!(format_rfc3339(1_609_459_200, 0), "2021-01-01T00:00:00.000Z");
        assert_eq!(format_rfc3339(1_609_459_200, 456), "2021-01-01T00:00:00.456Z");
    }
}
```

Add to `src-tauri/src/lib.rs` next to the other module declarations (around line 17-43):

```rust
pub mod log_bus;
```

- [ ] **Step 2: Run the bus tests — expect PASS**

Run: `cd src-tauri && cargo test log_bus`
Expected: 5 tests pass (`ring_buffer_drops_oldest_and_keeps_newest`, `clear_empties_buffer`, `category_and_source_pass_through`, `frontend_command_forces_category_and_defaults_bad_level`, `rfc3339_matches_known_epoch`).

> Note: tests share one process-global bus; each calls `clear()` at start+end. `cargo test` runs them on threads, so if flakiness appears, run `cargo test log_bus -- --test-threads=1`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/log_bus.rs src-tauri/src/lib.rs
git commit -m "feat(logs): add unified log bus (ring buffer + macros + commands)"
```

---

## Task 2: Wire bus into Tauri setup + register commands + dlog dual-write

**Files:**
- Modify: `src-tauri/src/lib.rs` (setup ~line 996, invoke_handler ~935-975, `dlog` ~65-80)

- [ ] **Step 1: Init the bus as the first thing in `setup`**

In `.setup(|app| {` (line 996), insert as the very first statement inside the closure body:

```rust
            log_bus::init(app.handle().clone());
```

- [ ] **Step 2: Register the three commands in the desktop `generate_handler!`**

In the `#[cfg(not(target_os = "ios"))]` handler list (ends ~line 975 with `shared_config_write,`), add:

```rust
                log_bus::logs_append_frontend,
                log_bus::logs_get_snapshot,
                log_bus::logs_clear,
```

- [ ] **Step 3: Make `dlog` also feed the bus (keep /tmp write)**

Replace the body of `fn dlog` (lines ~65-80) so the /tmp write stays debug-only but the bus record happens in all builds:

```rust
#[allow(unused_variables)]
fn dlog(msg: &str) {
    crate::log_bus::push("info", msg.to_string());
    #[cfg(debug_assertions)]
    {
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open("/tmp/mdeditor.log")
        {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let _ = writeln!(f, "{} {}", ts, msg);
        }
    }
}
```

- [ ] **Step 4: Build to verify wiring compiles**

Run: `cd src-tauri && cargo check`
Expected: compiles clean (warnings ok).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(logs): init bus in setup, register commands, dlog dual-write"
```

---

## Task 3: Mirror git-sync logs into the bus

**Files:**
- Modify: `src-tauri/src/vault_sync/log_buffer.rs` (the `push` method ~line 24)

Mirroring at `LogBuffer::push` covers all ~11 `mgr.logs.push(...)` call sites in one place. Levels there are uppercase (`"INFO"/"WARN"/"ERROR"`) — lowercase them for the bus.

- [ ] **Step 1: Add the bus mirror to `LogBuffer::push`**

In `src-tauri/src/vault_sync/log_buffer.rs`, at the end of the `push` method (after `entries.push_back(entry);`), add:

```rust
        // Mirror into the unified log bus (category=git-sync). Existing storage
        // above is untouched; this is additive so the Logs window can tail it.
        crate::log_bus::push_cat("git-sync", "backend", &level.to_ascii_lowercase(), message.to_string());
```

The method signature is `pub fn push(&self, level: &str, message: &str)`, so `level`/`message` are in scope.

- [ ] **Step 2: Build**

Run: `cd src-tauri && cargo check`
Expected: compiles clean.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/vault_sync/log_buffer.rs
git commit -m "feat(logs): mirror git-sync LogBuffer into unified bus"
```

---

## Task 4: Mirror plugin logs into the bus

**Files:**
- Modify: `src-tauri/src/plugin_runtime/process.rs` (`append_plugin_log` ~line 217)

- [ ] **Step 1: Add the bus mirror to `append_plugin_log`**

In `pub(crate) fn append_plugin_log(dir: &Path, plugin_id: &str, level: &str, msg: &str)` (line ~217), add at the top of the body (before the existing file append):

```rust
    // Mirror into the unified log bus (category=plugin:<id>). File append below
    // is untouched. Map raw stderr level to a bus level.
    let bus_level = match level {
        "debug" | "info" | "warn" | "error" => level,
        _ => "info", // e.g. "stderr"
    };
    crate::log_bus::push_cat(&format!("plugin:{plugin_id}"), "backend", bus_level, msg.to_string());
```

- [ ] **Step 2: Build + run the existing plugin-log test**

Run: `cd src-tauri && cargo test append_plugin_log`
Expected: `append_plugin_log_writes_level_tagged_lines_and_rolls_past_5mb` still passes (file behavior unchanged).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/plugin_runtime/process.rs
git commit -m "feat(logs): mirror plugin logs into unified bus"
```

---

## Task 5: Logs window opener + tray re-point + View menu + capabilities

**Files:**
- Modify: `src-tauri/src/lib.rs` (add `open_logs_window`, tray `tray-sync-log` branch ~1101, `open-logs` menu handler ~1063, View menu build ~1668, `menu_label` catalog ~1317)
- Modify: `src-tauri/capabilities/default.json` (line 5 windows array)

- [ ] **Step 1: Add `open_logs_window`**

Place next to `show_insights_window` (after it, ~line 387). It builds/reuses the `logs` window and, when a filter is given, emits `nav://logs-filter` once the window is up:

```rust
#[cfg(not(target_os = "ios"))]
fn open_logs_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>, filter: Option<&str>) {
    use tauri::WebviewUrl;
    let win = app.get_webview_window("logs").or_else(|| {
        tauri::WebviewWindowBuilder::new(app, "logs", WebviewUrl::App("logs.html".into()))
            .title("Logs")
            .inner_size(900.0, 640.0)
            .min_inner_size(520.0, 360.0)
            .resizable(true)
            .decorations(true)
            .visible(false)
            .build()
            .map_err(|e| eprintln!("[logs] window build failed: {e}"))
            .ok()
    });
    if let Some(w) = win {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        if let Some(f) = filter {
            // Small delay so the webview has registered its listener before the
            // preset filter arrives (mirrors emit_open_file_delayed usage).
            let app2 = app.clone();
            let f = f.to_string();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                let _ = app2.emit("nav://logs-filter", f);
            });
        }
    }
}
```

- [ ] **Step 2: Re-point the tray "View Log…" entry**

In the tray menu handler, change the `tray-sync-log` branch (line ~1101):

```rust
                            "tray-sync-log" => { open_logs_window(app, Some("git-sync")); }
```

- [ ] **Step 3: Handle the new `open-logs` View menu item**

Next to the `open-insights` handler (line ~1063-1066), add:

```rust
                    if event.id().0.as_str() == "open-logs" {
                        open_logs_window(app, None);
                        return;
                    }
```

Match the exact surrounding style of the `open-insights` block (it uses `show_insights_window(app); return;` inside an `if`).

- [ ] **Step 4: Add the `view.logs` label to the `menu_label` catalog**

After the `view.insights` line (~1317) add:

```rust
        "view.logs" => ("View Logs…", "查看日志…", "ログを表示…", "Protokolle anzeigen…"),
```

- [ ] **Step 5: Add the View menu item**

In the View submenu builder (~line 1668), after the `open-insights` item + its `.separator()`, add an item:

```rust
        .item(&MenuItemBuilder::with_id("open-logs", menu_label(locale, "view.logs")).build(app)?)
```

Place it right after the `open-insights` item line and before the following `.separator()` so Insights and Logs sit together.

- [ ] **Step 6: Allow the `logs` window in capabilities**

In `src-tauri/capabilities/default.json`, line 5, add `"logs"` to the windows array:

```json
  "windows": ["main", "cli", "insights", "preview", "plugin-market", "logs"],
```

- [ ] **Step 7: Build**

Run: `cd src-tauri && cargo check`
Expected: compiles clean.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "feat(logs): logs window opener, tray re-point, View menu, capabilities"
```

---

## Task 6: Frontend window scaffold (html + main + vite entry)

**Files:**
- Create: `logs.html`, `src/logs-main.ts`
- Modify: `vite.config.ts` (rollupOptions.input ~line 31, optimizeDeps.entries ~line 40)

- [ ] **Step 1: Create `logs.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Logs</title>
    <style>
      :root { color-scheme: light dark; }
      html, body { margin: 0; height: 100%; }
    </style>
  </head>
  <body>
    <div id="logs-app"></div>
    <script type="module" src="/src/logs-main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/logs-main.ts`**

```ts
import { mount } from 'svelte'
import LogsApp from './logs-app.svelte'

const target = document.getElementById('logs-app')
if (!target) throw new Error('logs-app root missing')
mount(LogsApp, { target })
```

- [ ] **Step 3: Register the entry in `vite.config.ts`**

In `rollupOptions.input` (after `pluginMarket: 'plugin-market.html',`):

```ts
        logs: 'logs.html',
```

In `optimizeDeps.entries`:

```ts
    entries: ['index.html', 'insights.html', 'preview.html', 'plugin-market.html', 'logs.html'],
```

- [ ] **Step 4: Commit** (build verified together with Task 9 once the component exists)

```bash
git add logs.html src/logs-main.ts vite.config.ts
git commit -m "feat(logs): window scaffold + vite entry"
```

---

## Task 7: Console bridge + install on startup + test

**Files:**
- Create: `src/lib/logs/console-bridge.ts`, `src/lib/logs/console-bridge.test.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/logs/console-bridge.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn(() => Promise.resolve())
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))

describe('installConsoleBridge', () => {
  beforeEach(() => { invokeMock.mockClear() })

  it('calls the original console and reports to the backend', async () => {
    const { installConsoleBridge } = await import('./console-bridge')
    const original = console.warn
    installConsoleBridge()
    console.warn('hello', 42)
    expect(invokeMock).toHaveBeenCalledWith('logs_append_frontend', { level: 'warn', message: 'hello 42' })
    console.warn = original
  })

  it('is idempotent — patching twice does not double-report', async () => {
    const { installConsoleBridge } = await import('./console-bridge')
    installConsoleBridge()
    installConsoleBridge()
    invokeMock.mockClear()
    console.info('x')
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('does not loop when the report itself throws', async () => {
    const { installConsoleBridge } = await import('./console-bridge')
    invokeMock.mockImplementationOnce(() => Promise.reject(new Error('boom')))
    installConsoleBridge()
    expect(() => console.error('kaboom')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `pnpm vitest run src/lib/logs/console-bridge.test.ts`
Expected: FAIL, cannot resolve `./console-bridge`.

- [ ] **Step 3: Write `src/lib/logs/console-bridge.ts`**

```ts
import { invoke } from '@tauri-apps/api/core'

export interface LogLine {
  ts: string
  source: string
  category: string
  level: string
  message: string
}

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return `${a.name}: ${a.message}`
  try { return JSON.stringify(a) } catch { return String(a) }
}

let patched = false

/** Idempotent. Patches console.* to also forward into the backend log bus.
 *  HARD RULE: call the native console first, then report; swallow report
 *  failures — otherwise a reporting error logs, which re-enters here → loop. */
export function installConsoleBridge(): void {
  if (patched) return
  patched = true
  const map = [
    ['debug', 'debug'],
    ['info', 'info'],
    ['info', 'log'],
    ['warn', 'warn'],
    ['error', 'error'],
  ] as const
  for (const [level, method] of map) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      original(...args)
      const message = args.map(stringifyArg).join(' ')
      void invoke('logs_append_frontend', { level, message }).catch(() => {})
    }
  }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm vitest run src/lib/logs/console-bridge.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Install the bridge on startup**

In `src/main.ts`, add near the top (after existing imports), calling once before mount:

```ts
import { installConsoleBridge } from './lib/logs/console-bridge'
installConsoleBridge()
```

Read `src/main.ts` first and place the import with the other imports and the call before the app is mounted.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logs/console-bridge.ts src/lib/logs/console-bridge.test.ts src/main.ts
git commit -m "feat(logs): frontend console bridge + install on startup"
```

---

## Task 8: Logs store (snapshot replay + live tail + filter) + test

**Files:**
- Create: `src/lib/logs/logs-store.svelte.ts`, `src/lib/logs/logs-store.test.ts`

The store keeps a plain module-level helper `capLines` that's unit-testable without a webview, plus the runes-based reactive state used by the component.

- [ ] **Step 1: Write the failing test**

`src/lib/logs/logs-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { capLines, MAX_LINES } from './logs-store.svelte'
import type { LogLine } from './console-bridge'

function line(i: number): LogLine {
  return { ts: `${i}`, source: 'backend', category: 'core', level: 'info', message: `m${i}` }
}

describe('capLines', () => {
  it('keeps at most MAX_LINES, dropping the oldest', () => {
    const arr = Array.from({ length: MAX_LINES + 5 }, (_, i) => line(i))
    const capped = capLines(arr)
    expect(capped.length).toBe(MAX_LINES)
    expect(capped[capped.length - 1].message).toBe(`m${MAX_LINES + 4}`)
    expect(capped[0].message).toBe('m5')
  })

  it('returns the array unchanged when under the cap', () => {
    const arr = [line(1), line(2)]
    expect(capLines(arr)).toBe(arr)
  })
})
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `pnpm vitest run src/lib/logs/logs-store.test.ts`
Expected: FAIL, cannot resolve `./logs-store.svelte`.

- [ ] **Step 3: Write `src/lib/logs/logs-store.svelte.ts`**

```ts
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { LogLine } from './console-bridge'

export const MAX_LINES = 3000

/** Cap to the newest MAX_LINES; identity when already under the cap. */
export function capLines(lines: LogLine[]): LogLine[] {
  return lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines
}

export function createLogsStore() {
  let lines = $state<LogLine[]>([])
  let categoryFilter = $state<string>('all')

  async function start(): Promise<() => void> {
    const snap = await invoke<LogLine[]>('logs_get_snapshot').catch(() => [] as LogLine[])
    lines = capLines(snap)
    const unLine = await listen<LogLine>('log://line', (e) => {
      lines = capLines([...lines, e.payload])
    })
    const unFilter = await listen<string>('nav://logs-filter', (e) => {
      categoryFilter = e.payload
    })
    return () => { unLine(); unFilter() }
  }

  async function clear(): Promise<void> {
    lines = []
    await invoke('logs_clear').catch(() => {})
  }

  return {
    get lines() { return lines },
    get categoryFilter() { return categoryFilter },
    set categoryFilter(v: string) { categoryFilter = v },
    start,
    clear,
  }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm vitest run src/lib/logs/logs-store.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logs/logs-store.svelte.ts src/lib/logs/logs-store.test.ts
git commit -m "feat(logs): logs store with snapshot replay, live tail, filter"
```

---

## Task 9: Logs viewer UI + i18n + full build

**Files:**
- Create: `src/logs-app.svelte`
- Modify: `src/lib/i18n/en.ts` (add logs.* keys near insights.* ~line 563)

- [ ] **Step 1: Add i18n keys to `src/lib/i18n/en.ts`**

Insert near the insights block (after line ~571). These are flat dotted keys (see the i18n convention):

```ts
  'nav.logs': 'Logs',
  'logs.title': 'Logs',
  'logs.source': 'Source',
  'logs.category': 'Category',
  'logs.level': 'Level',
  'logs.search': 'Search…',
  'logs.autoScroll': 'Auto-scroll',
  'logs.clear': 'Clear',
  'logs.empty': 'No logs yet',
  'logs.sources.all': 'All sources',
  'logs.sources.backend': 'Backend',
  'logs.sources.frontend': 'Frontend',
  'logs.categories.all': 'All categories',
  'logs.categories.core': 'Core',
  'logs.categories.gitSync': 'Git Sync',
  'logs.categories.plugin': 'Plugins',
  'logs.categories.frontend': 'Frontend',
  'logs.levels.all': 'All levels',
  'logs.levels.debug': 'Debug',
  'logs.levels.info': 'Info',
  'logs.levels.warn': 'Warn',
  'logs.levels.error': 'Error',
```

> zh/ja/de come from partial locale dirs; if a `zh` partial exists mirror the same keys there. Sample docs/keywords are not translated (see i18n convention). If only `en.ts` is the source-of-truth catalog, this step is complete.

- [ ] **Step 2: Create `src/logs-app.svelte`**

```svelte
<!-- src/logs-app.svelte — standalone Logs window (View ▸ View Logs, or tray
     git-sync entry which presets the category filter to git-sync). -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { loadLocale, t } from './lib/i18n/store.svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { createLogsStore } from './lib/logs/logs-store.svelte'
  import type { LogLine } from './lib/logs/console-bridge'

  const store = createLogsStore()
  let sourceFilter = $state<'all' | 'backend' | 'frontend'>('all')
  let levelFilter = $state<'all' | 'debug' | 'info' | 'warn' | 'error'>('all')
  let search = $state('')
  let autoScroll = $state(true)
  let ready = $state(false)
  let logEnd: HTMLDivElement | undefined

  onMount(() => {
    let stop: (() => void) | undefined
    ;(async () => {
      await loadLocale()
      try { await getCurrentWindow().setTitle(t('logs.title')) } catch { /* no-op */ }
      stop = await store.start()
      ready = true
    })()
    return () => stop?.()
  })

  // category filter groups every plugin:<id> under the single "plugin" bucket.
  function matchCategory(line: LogLine): boolean {
    const f = store.categoryFilter
    if (f === 'all') return true
    if (f === 'plugin') return line.category.startsWith('plugin:')
    return line.category === f
  }

  const filtered = $derived(
    store.lines.filter((l) =>
      (sourceFilter === 'all' || l.source === sourceFilter) &&
      matchCategory(l) &&
      (levelFilter === 'all' || l.level === levelFilter) &&
      (search === '' || l.message.toLowerCase().includes(search.toLowerCase())))
  )

  $effect(() => {
    // Re-run on every filtered change; scroll to bottom when enabled.
    filtered.length
    if (autoScroll) logEnd?.scrollIntoView({ block: 'end' })
  })

  function catClass(cat: string): string {
    if (cat === 'git-sync') return 'cat-git'
    if (cat.startsWith('plugin:')) return 'cat-plugin'
    if (cat === 'frontend') return 'cat-frontend'
    return 'cat-core'
  }
</script>

<div class="logs-root">
  <header class="bar">
    <select bind:value={sourceFilter}>
      <option value="all">{t('logs.sources.all')}</option>
      <option value="backend">{t('logs.sources.backend')}</option>
      <option value="frontend">{t('logs.sources.frontend')}</option>
    </select>
    <select bind:value={store.categoryFilter}>
      <option value="all">{t('logs.categories.all')}</option>
      <option value="core">{t('logs.categories.core')}</option>
      <option value="git-sync">{t('logs.categories.gitSync')}</option>
      <option value="plugin">{t('logs.categories.plugin')}</option>
      <option value="frontend">{t('logs.categories.frontend')}</option>
    </select>
    <select bind:value={levelFilter}>
      <option value="all">{t('logs.levels.all')}</option>
      <option value="debug">{t('logs.levels.debug')}</option>
      <option value="info">{t('logs.levels.info')}</option>
      <option value="warn">{t('logs.levels.warn')}</option>
      <option value="error">{t('logs.levels.error')}</option>
    </select>
    <input class="search" type="text" placeholder={t('logs.search')} bind:value={search} />
    <label class="auto"><input type="checkbox" bind:checked={autoScroll} />{t('logs.autoScroll')}</label>
    <button onclick={() => store.clear()}>{t('logs.clear')}</button>
  </header>

  <div class="stream">
    {#if ready && filtered.length === 0}
      <div class="empty">{t('logs.empty')}</div>
    {/if}
    {#each filtered as line (line.ts + line.message)}
      <div class="row">
        <span class="ts">{line.ts}</span>
        <span class="cat {catClass(line.category)}">[{line.category}]</span>
        <span class="src">[{line.source}]</span>
        <span class="lvl lvl-{line.level}">{line.level}</span>
        <span class="msg">{line.message}</span>
      </div>
    {/each}
    <div bind:this={logEnd}></div>
  </div>
</div>

<style>
  .logs-root { display: flex; flex-direction: column; height: 100vh; background: #1e1e1e; color: #ddd; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .bar { display: flex; gap: 8px; align-items: center; padding: 6px 8px; background: #252526; border-bottom: 1px solid #333; flex-wrap: wrap; }
  .bar select, .bar input, .bar button { background: #333; color: #ddd; border: 1px solid #444; border-radius: 4px; padding: 2px 6px; font: inherit; }
  .search { flex: 1; min-width: 120px; }
  .auto { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  .stream { flex: 1; overflow-y: auto; padding: 6px 8px; }
  .empty { opacity: 0.5; padding: 16px; text-align: center; }
  .row { display: flex; gap: 8px; padding: 1px 0; align-items: baseline; }
  .ts { color: #777; white-space: nowrap; }
  .src { color: #6a9955; white-space: nowrap; }
  .cat { white-space: nowrap; }
  .cat-git { color: #4fc1ff; }
  .cat-plugin { color: #c586c0; }
  .cat-frontend { color: #4ec9b0; }
  .cat-core { color: #6a9955; }
  .lvl { white-space: nowrap; text-transform: uppercase; }
  .lvl-error { color: #f14c4c; }
  .lvl-warn { color: #cca700; }
  .lvl-debug { color: #888; }
  .lvl-info { color: #ddd; }
  .msg { white-space: pre-wrap; word-break: break-all; }
</style>
```

- [ ] **Step 3: Typecheck + run the full frontend test suite**

Run: `pnpm run check` (svelte-check) then `pnpm vitest run src/lib/logs`
Expected: no type errors; console-bridge (3) + logs-store (2) tests pass.

- [ ] **Step 4: Production build of the frontend to confirm the new entry bundles**

Run: `pnpm run build`
Expected: build succeeds and emits a `logs.html` bundle (check `dist/logs.html` exists).

- [ ] **Step 5: Commit**

```bash
git add src/logs-app.svelte src/lib/i18n/en.ts
git commit -m "feat(logs): logs viewer UI + i18n keys"
```

---

## Task 10: Full backend build + GUI verification handoff

**Files:** none (verification only)

- [ ] **Step 1: Full workspace build**

Run: `cd src-tauri && cargo build` and (repo root) `pnpm run check`
Expected: both succeed.

- [ ] **Step 2: Manual GUI verification (user-run — no UI automation)**

Provide the user these steps (dev build):
1. `pnpm tauri dev`
2. Menu **View ▸ View Logs…** → the Logs window opens; existing startup lines appear (category=core).
3. In the main window devtools console run `console.warn('probe frontend log')` → a `frontend` row appears live in the Logs window.
4. Trigger a git sync (tray **Sync Now**) → `git-sync` rows appear; select category **Git Sync** to isolate them.
5. Tray **View Log…** → Logs window focuses and the category dropdown is preset to **Git Sync**.
6. Toggle **Auto-scroll**, type in the search box, hit **Clear** → buffer empties; new lines still stream in.
7. Confirm `~/Library/Application Support/<bundle-id>/logs/app.log` is being written with `[source/category/level]` lines.

- [ ] **Step 3: Commit any fixes from verification, then done.**

---

## Self-Review Notes

- **Spec §2 data contract** → Task 1 `LogLine` (5 fields, snake_case, category added). ✔
- **Spec §3 bus + macros + commands + init + tests** → Tasks 1-2. ✔
- **Spec §3.1 接入点 (core/git-sync/plugin)** → Task 2 (dlog), Task 3 (git-sync via LogBuffer::push), Task 4 (plugins via append_plugin_log). ✔
- **Spec §3.2 unit tests** → Task 1 tests (ring buffer, clear, category passthrough, frontend level fallback) + rfc3339. ✔
- **Spec §4 tray re-point + View menu + capabilities + init-first** → Tasks 2 & 5. ✔
- **Spec §5 frontend window + bridge + store + UI** → Tasks 6-9. ✔
- **Spec §6 i18n keys** → Task 9. ✔
- **Spec §7 frontend tests** → Tasks 7-8. ✔
- **Spec §8 GUI verification** → Task 10. ✔
- **Spec §9 checklist (event/command names verbatim, MAX_LINES both sides, init first, bridge native-then-report, clear buffer-only, 5-field align, capabilities, vite entry, color-scheme, additive mirrors)** → covered across tasks. ✔
- **Event/command name consistency:** `log://line`, `nav://logs-filter`, `logs_append_frontend`, `logs_get_snapshot`, `logs_clear` — identical in Rust (Task 1/5), registration (Task 2), and frontend (Tasks 7-8). ✔
- **Naming consistency:** `createLogsStore`, `capLines`, `MAX_LINES`, `installConsoleBridge`, `open_logs_window`, `push_cat`, `log_cat!` used identically across referencing tasks. ✔
