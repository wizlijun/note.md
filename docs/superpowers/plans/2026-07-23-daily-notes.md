# Daily Notes（每日笔记）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把每日日记升级为一个独立、单实例窗口的 Roam 式 Daily Notes——滚动懒加载多天大纲、聚焦即激活单活编辑器、双链穿梭、工具栏导航，由设置开关控制启停并接管 tray。

**Architecture:** 核心功能（非隔离插件），新增一个加载主前端 bundle 的二级窗口 `daily-notes`（与 insights/preview 同构），复用 `OutlineEditor` + `src/lib/outline/*`。日记流里任一时刻只有聚焦的那天是活的 `OutlineEditor`（绑定全局单例 `outline`），其余天用轻量只读大纲渲染，不重构单例。设置开关 `dailyNotes.enabled` 由前端写入 `settings.json`、Rust 侧镜像到一个 `Mutex<bool>` 供 `build_tray_menu` 读取。

**Tech Stack:** Tauri 2 (Rust) · Svelte 5 (runes) · TypeScript · Vite · Vitest · @tauri-apps/plugin-opener · 现有 outline 栈（model/commands/store.svelte）。

设计文档：`docs/superpowers/specs/2026-07-23-daily-notes-design.md`

---

## 参考约定（实施前必读）

- 共享 worktree：**只精确 `git add` 目标文件，绝不 `git add -A`**（本仓库常被并行会话共享）。
- IO 薄层 / GUI 不做 vitest（仓库惯例）；纯逻辑必须 TDD。
- i18n：`src/lib/i18n/en.ts` 扁平点分键 + `zh` 覆盖目录；`t()` 取值。
- 二级窗口三件套：`*.html` 入口 + `src/*-main.ts` + 根 `*-app.svelte`；vite `rollupOptions.input` 与 `optimizeDeps.entries` 都要登记；`capabilities/default.json` 的 `windows` 要登记，否则后端命令被静默拒绝。
- 独立窗口根组件须自声明 `:global(:root){ color-scheme: light dark }`。
- 每完成一个 Task 跑一次相关检查后 commit。全量检查命令：
  - 前端类型：`pnpm check`（等价 `svelte-check`）
  - 前端单测：`pnpm test`（vitest）
  - Rust：`cargo check --manifest-path src-tauri/Cargo.toml`

---

## File Structure

**新增**
- `daily-notes.html` — 窗口 HTML 入口
- `src/daily-notes-main.ts` — 挂载根组件
- `src/daily-notes-app.svelte` — 根组件：bootstrap + 顶层布局（工具栏 + 视图切换）
- `src/components/daily/DailyToolbar.svelte` — 工具栏（上一个/下一个/刷新/日历/查找）
- `src/components/daily/DailyFeed.svelte` — 日记流容器（懒加载 + 单活编辑器编排）
- `src/components/daily/DailyDay.svelte` — 单天区块（只读渲染 ⇄ 活跃 OutlineEditor）
- `src/components/daily/DailyOutlineView.svelte` — 轻量只读大纲渲染（递归 bullets + 双链 pill）
- `src/components/daily/DailyPage.svelte` — 单页视图（[[页面]] → 完整 OutlineEditor）
- `src/lib/daily/dates.ts` — 纯逻辑：日期区块序列 / 懒加载游标
- `src/lib/daily/dates.test.ts`
- `src/lib/daily/link-route.ts` — 纯逻辑：链接分类（date/page/md/external）
- `src/lib/daily/link-route.test.ts`
- `src/lib/daily/nav-history.ts` — 纯逻辑：前进/后退导航栈
- `src/lib/daily/nav-history.test.ts`
- `src/lib/daily/filter.ts` — 纯逻辑：查找过滤命中判定
- `src/lib/daily/filter.test.ts`

**修改**
- `vite.config.ts` — 追加 `dailyNotes` 输入与 optimizeDeps 条目
- `src-tauri/capabilities/default.json` — `windows` 追加 `"daily-notes"`
- `src-tauri/src/lib.rs` — 新增窗口/命令/状态；tray 改名与条件项；invoke_handler 注册
- `src/App.svelte` — `tray-today-note` 监听改名 `tray-daily-note`
- `src/lib/settings.svelte.ts` — `settings` 增加 `dailyNotes: { enabled }`，load/save
- `src/lib/i18n/en.ts` 及 `zh` — 新增键、`tray.todayNote`→`tray.dailyNote`
- Settings UI 组件 — 增开关行（具体文件在 Task 8 定位）

---

## Phase 1 — 命名统一 today-note → daily-note

### Task 1: Rust 侧 tray id / event / i18n key 改名

**Files:**
- Modify: `src-tauri/src/lib.rs`（tray 构建 + 事件处理，约 1437 / 1088 行）

- [ ] **Step 1: 改 tray 项 id 与 i18n key**

在 `build_tray_menu`（约 1437 行）把：
```rust
let today_note_item = MenuItem::with_id(app, "tray-today-note", menu_label(locale, "tray.todayNote"), true, None::<&str>)?;
```
改为：
```rust
let daily_note_item = MenuItem::with_id(app, "tray-daily-note", menu_label(locale, "tray.dailyNote"), true, None::<&str>)?;
```
并把后面 `.item(&today_note_item)`（约 1530 行 `MenuBuilder::new(app).item(&show_item).item(&today_note_item)`）改为 `.item(&daily_note_item)`。

- [ ] **Step 2: 改事件处理分支**

在 tray `on_menu_event`（约 1088 行）把：
```rust
"tray-today-note" => {
    show_main_window(app);
    let _ = app.emit("tray-today-note", ());
}
```
改为：
```rust
"tray-daily-note" => {
    show_main_window(app);
    let _ = app.emit("tray-daily-note", ());
}
```

- [ ] **Step 3: 编译**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 通过（剩余 i18n key 在 Task 3 补，key 缺失只会运行时回退不报编译错）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "refactor(tray): rename today-note → daily-note (rust)"
```

### Task 2: 前端监听改名

**Files:**
- Modify: `src/App.svelte:161`

- [ ] **Step 1: 改监听事件名**

把 `src/App.svelte` 约 161 行：
```ts
const unlistenTodayNote = listen('tray-today-note', async () => {
```
改为：
```ts
const unlistenDailyNote = listen('tray-daily-note', async () => {
```
并同步改函数体末尾的 `unlistenTodayNote()` 清理调用与日志字符串 `'[App] tray-today-note failed:'` → `'[App] tray-daily-note failed:'`。（用编辑器搜索 `TodayNote` / `today-note` 在本文件内确保全部替换。）

- [ ] **Step 2: 类型检查**

Run: `pnpm check`
Expected: 无新增错误。

- [ ] **Step 3: Commit**

```bash
git add src/App.svelte
git commit -m "refactor(tray): rename today-note → daily-note (frontend listener)"
```

### Task 3: i18n key 改名 + 新增每日笔记标签

**Files:**
- Modify: `src/lib/i18n/en.ts`；`zh` 覆盖文件（`grep -rl "tray.todayNote\|todayNote" src/lib/i18n` 定位）

- [ ] **Step 1: 定位现有键**

Run: `grep -rn "todayNote\|tray\\.today" src/lib/i18n`
记录 en 与 zh 两处 `tray.todayNote` 的值。

- [ ] **Step 2: 改键名 + 增新键**

en.ts：`'tray.todayNote'` → `'tray.dailyNote'`（值保留原「Today's Note」）。再新增每日笔记窗口入口标签键：
```ts
'tray.dailyNotes': 'Daily Notes',
```
zh 覆盖：`'tray.dailyNote'`（原「今天的日记」值）；新增：
```ts
'tray.dailyNotes': '每日笔记',
```

- [ ] **Step 3: 类型/单测**

Run: `pnpm check && pnpm test`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src/lib/i18n
git commit -m "i18n: rename tray.todayNote → tray.dailyNote, add tray.dailyNotes"
```

---

## Phase 2 — 独立窗口骨架

### Task 4: 窗口三件套 + vite + capabilities（空壳能打开）

**Files:**
- Create: `daily-notes.html`, `src/daily-notes-main.ts`, `src/daily-notes-app.svelte`
- Modify: `vite.config.ts`, `src-tauri/capabilities/default.json`

- [ ] **Step 1: HTML 入口**

`daily-notes.html`：
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Daily Notes</title>
  </head>
  <body>
    <div id="daily-notes-app"></div>
    <script type="module" src="/src/daily-notes-main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: JS 入口**

`src/daily-notes-main.ts`：
```ts
import { mount } from 'svelte'
import DailyNotesApp from './daily-notes-app.svelte'

const target = document.getElementById('daily-notes-app')
if (!target) throw new Error('daily-notes-app root missing')
mount(DailyNotesApp, { target })
```

- [ ] **Step 3: 根组件（bootstrap，先占位）**

`src/daily-notes-app.svelte`（镜像 insights-app 的 bootstrap）：
```svelte
<!-- src/daily-notes-app.svelte — standalone Daily Notes window. Bootstraps its
     own webview state, then hosts the toolbar + feed/page views. -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { loadSettings } from './lib/settings.svelte'
  import { loadLocale, t } from './lib/i18n/store.svelte'
  import { loadOutlineDirs } from './lib/outline/dirs.svelte'
  import { refreshSotvault, sotvaultStore } from './lib/sotvault.svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'

  let ready = $state(false)

  onMount(async () => {
    try {
      await loadSettings()
      await loadLocale()
      await loadOutlineDirs()
      try { await getCurrentWindow().setTitle(t('daily.windowTitle')) } catch { /* no-op */ }
      await refreshSotvault()
    } catch (e) {
      console.error('[daily-notes] init failed:', e)
    }
    ready = true
  })
</script>

<main>
  {#if !ready}
    <p class="msg">…</p>
  {:else if sotvaultStore.vaultRoot === null}
    <p class="msg">{t('daily.needsVault')}</p>
  {:else}
    <p class="msg">Daily Notes 窗口就绪（feed 待接入）</p>
  {/if}
</main>

<style>
  :global(:root) { color-scheme: light dark; }
  :global(body) { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: Canvas; color: CanvasText; }
  main { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  .msg { color: color-mix(in srgb, CanvasText 55%, transparent); font-size: 13px; padding: 20px; }
</style>
```

- [ ] **Step 4: vite 登记**

`vite.config.ts`：`rollupOptions.input` 增 `dailyNotes: 'daily-notes.html',`；`optimizeDeps.entries` 数组增 `'daily-notes.html'`。

- [ ] **Step 5: capabilities 登记**

`src-tauri/capabilities/default.json`：把 `"windows": ["main", "cli", "insights", "preview", "plugin-market", "logs"]` 改为在末尾加 `, "daily-notes"`。

- [ ] **Step 6: 临时新增 i18n 键（占位，Task 12 统一补全）**

en.ts 增 `'daily.windowTitle': 'Daily Notes'`、`'daily.needsVault': 'Open a vault to use Daily Notes.'`；zh 增 `'daily.windowTitle': '每日笔记'`、`'daily.needsVault': '请先打开一个 vault 再使用每日笔记。'`。

- [ ] **Step 7: 类型检查**

Run: `pnpm check`
Expected: 通过。

- [ ] **Step 8: Commit**

```bash
git add daily-notes.html src/daily-notes-main.ts src/daily-notes-app.svelte vite.config.ts src-tauri/capabilities/default.json src/lib/i18n
git commit -m "feat(daily): scaffold standalone Daily Notes window"
```

### Task 5: Rust 侧开窗命令 + 单实例

**Files:**
- Modify: `src-tauri/src/lib.rs`（新增函数 + `show_insights_window` 附近；invoke_handler 注册约 950 行）

- [ ] **Step 1: 新增开窗函数与命令**

在 `show_insights_window`（约 370 行）之后新增：
```rust
/// The single Daily Notes window's label.
const DAILY_NOTES_LABEL: &str = "daily-notes";

/// Ensure the single Daily Notes window exists; focus if already open.
fn show_daily_notes_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let win = app.get_webview_window(DAILY_NOTES_LABEL).or_else(|| {
        tauri::WebviewWindowBuilder::new(app, DAILY_NOTES_LABEL, WebviewUrl::App("daily-notes.html".into()))
            .title("Daily Notes")
            .inner_size(720.0, 900.0)
            .min_inner_size(480.0, 480.0)
            .build()
            .map_err(|e| eprintln!("[daily-notes] window build failed: {e}"))
            .ok()
    });
    if let Some(w) = win {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.unminimize();
    }
}

#[tauri::command]
fn open_daily_notes_window(app: tauri::AppHandle) {
    show_daily_notes_window(&app);
}
```
（若 `WebviewUrl` 未在作用域，参考 `show_insights_window` 的 `use tauri::WebviewUrl;` 引入方式；insights 已在同文件用它。）

- [ ] **Step 2: 注册命令**

在 `invoke_handler(tauri::generate_handler![…])`（约 950 行，含 `set_menu_locale` 那份列表）加入 `open_daily_notes_window,`。注意仓库里可能有 **两处** generate_handler（桌面/ios，约 950 与 976 行）——两处都要加，或按 `#[cfg]` 归属加到桌面那份（Task 7 的 tray 命令同理）。

- [ ] **Step 3: 编译**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(daily): single-instance Daily Notes window + open command"
```

---

## Phase 3 — 设置开关 + tray 接管

### Task 6: 设置项 dailyNotes.enabled（纯前端 store）

**Files:**
- Modify: `src/lib/settings.svelte.ts:49-59`（`settings` $state），`loadSettings`（约 139 行），`saveSettings`（约 188 行）

- [ ] **Step 1: 扩展 settings 形状与默认**

把 `export const settings = $state<{…}>({…})` 增加字段：
```ts
export const settings = $state<{
  autoSave: boolean
  toastAutoClose: boolean
  theme: ThemeSettings
  mdblock: MdblockSettings
  dailyNotes: { enabled: boolean }
}>({
  autoSave: false,
  toastAutoClose: false,
  theme: { ...DEFAULT_THEME },
  mdblock: structuredClone(DEFAULT_MDBLOCK_SETTINGS),
  dailyNotes: { enabled: false },
})
```

- [ ] **Step 2: loadSettings 读取**

在 `loadSettings` 里（其它 `s.get<…>('…')` 附近）加：
```ts
const storedDaily = await s.get<{ enabled: boolean }>('dailyNotes')
settings.dailyNotes.enabled = storedDaily?.enabled ?? false
```

- [ ] **Step 3: saveSettings 写入**

在 `saveSettings` 里（其它 `s.set('…', …)` 附近）加：
```ts
await s.set('dailyNotes', { enabled: settings.dailyNotes.enabled })
```
（确认 `saveSettings` 末尾有 `await s.save()`；有则不动。）

- [ ] **Step 4: 类型/单测**

Run: `pnpm check && pnpm test`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings.svelte.ts
git commit -m "feat(daily): persist dailyNotes.enabled setting"
```

### Task 7: Rust 侧开关镜像 + tray 条件项

**Files:**
- Modify: `src-tauri/src/lib.rs`（新增状态 + read 函数 + 命令 + `build_tray_menu` 条件 + tray 事件 + 注册 + `setup` 初始化）

- [ ] **Step 1: 新增可读状态与读取函数**

在文件顶部 state 结构区（`TrayShownLargeFiles` 附近，约 56 行）加：
```rust
pub struct DailyNotesEnabled(pub std::sync::Mutex<bool>);
```
在 `read_saved_locale`（约 1396 行）附近加同构读取：
```rust
pub(crate) fn read_daily_notes_enabled<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    use tauri::Manager;
    let Ok(dir) = app.path().app_config_dir() else { return false };
    let Ok(text) = std::fs::read_to_string(dir.join("settings.json")) else { return false };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    json.get("dailyNotes").and_then(|v| v.get("enabled")).and_then(|v| v.as_bool()).unwrap_or(false)
}
```

- [ ] **Step 2: 注册状态并在 setup 初始化**

在 builder 的 `.manage(...)` 链（约 817 行，`TrayShownLargeFiles` 附近）加：
```rust
let builder = builder.manage(DailyNotesEnabled(std::sync::Mutex::new(false)));
```
在 `setup` 里、`build_tray_menu` 首次调用（约 1070 行）**之前**，用磁盘值初始化：
```rust
*app.state::<DailyNotesEnabled>().0.lock().unwrap() = read_daily_notes_enabled(&app.handle());
```

- [ ] **Step 3: build_tray_menu 条件化**

把 Task 1 的 `daily_note_item`（内置「今天的日记」）与新增的「每日笔记」窗口项二选一。改 `build_tray_menu` 组装处（约 1530 行 `MenuBuilder::new(app).item(&show_item).item(&daily_note_item)`）：
```rust
let daily_enabled = *app.state::<DailyNotesEnabled>().0.lock().unwrap();
let daily_notes_item = MenuItem::with_id(app, "tray-daily-notes-open", menu_label(locale, "tray.dailyNotes"), true, None::<&str>)?;
let mut b0 = MenuBuilder::new(app).item(&show_item);
if daily_enabled {
    b0 = b0.item(&daily_notes_item);      // 每日笔记（开独立窗口）
} else {
    b0 = b0.item(&daily_note_item);       // 今天的日记（内置，开主编辑器）
}
```
（`show_item`/`daily_note_item` 保持已在函数内构建；`daily_notes_item` 新建于此。注意 `app.state` 在泛型 `R` 下用 `app.try_state::<DailyNotesEnabled>()`，取不到则默认 false，避免早期无 state 时 panic。）

- [ ] **Step 4: tray 事件处理**

在 `on_menu_event`（约 1088 行）新增分支：
```rust
"tray-daily-notes-open" => show_daily_notes_window(app),
```

- [ ] **Step 5: 开关命令（写状态 + 重建 tray）**

新增命令（`open_daily_notes_window` 附近）：
```rust
#[tauri::command]
fn set_daily_notes_enabled(app: tauri::AppHandle, enabled: bool) {
    if let Some(st) = app.try_state::<DailyNotesEnabled>() {
        *st.0.lock().unwrap() = enabled;
    }
    #[cfg(not(target_os = "ios"))]
    rebuild_menu(&app);
}
```
在 invoke_handler 注册 `set_daily_notes_enabled,`。

- [ ] **Step 6: 编译**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(daily): tray shows Daily Notes when enabled, hides built-in item"
```

### Task 8: Settings UI 开关

**Files:**
- Locate + Modify: 设置面板组件（Run `grep -rln "settings.autoSave\|toastAutoClose" src/components` 定位，通常 `src/components/Settings*.svelte`）

- [ ] **Step 1: 定位设置面板**

Run: `grep -rln "settings.autoSave\|settings.toastAutoClose\|t('settings" src/components`
选中承载「自动保存」等开关行的那个组件。

- [ ] **Step 2: 加开关行**

仿照现有 `autoSave` 开关行，新增一行绑定 `settings.dailyNotes.enabled`，change 时持久化并通知后端：
```svelte
<label class="row">
  <span>{t('settings.dailyNotes.label')}</span>
  <input
    type="checkbox"
    bind:checked={settings.dailyNotes.enabled}
    onchange={async () => {
      await saveSettings()
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('set_daily_notes_enabled', { enabled: settings.dailyNotes.enabled })
      } catch (e) { console.warn('[settings] set_daily_notes_enabled:', e) }
    }}
  />
</label>
```
（确保该文件已 `import { settings, saveSettings } from '../lib/settings.svelte'`；沿用现有 import。样式 class 复用该文件既有开关行 class，别新造。）

- [ ] **Step 3: i18n 键**

en.ts 增 `'settings.dailyNotes.label': 'Daily Notes window'`；zh 增 `'settings.dailyNotes.label': '每日笔记窗口'`。

- [ ] **Step 4: 类型检查**

Run: `pnpm check`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add src/components src/lib/i18n
git commit -m "feat(daily): settings toggle for Daily Notes window"
```

---

## Phase 4 — 纯逻辑（TDD）

### Task 9: 日期区块序列 / 懒加载游标

**Files:**
- Create: `src/lib/daily/dates.ts`, `src/lib/daily/dates.test.ts`

- [ ] **Step 1: 写失败测试**

`src/lib/daily/dates.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { addDays, dateRange, extendEarlier, extendLater } from './dates'

describe('daily/dates', () => {
  it('addDays crosses month/year boundaries', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-07-23', 0)).toBe('2026-07-23')
  })
  it('dateRange is inclusive, descending (newest first)', () => {
    expect(dateRange('2026-07-23', 3)).toEqual(['2026-07-23', '2026-07-22', '2026-07-21'])
  })
  it('extendEarlier appends older dates after the current tail', () => {
    const cur = ['2026-07-23', '2026-07-22']
    expect(extendEarlier(cur, 2)).toEqual(['2026-07-21', '2026-07-20'])
  })
  it('extendLater prepends newer dates before the current head', () => {
    const cur = ['2026-07-22', '2026-07-21']
    expect(extendLater(cur, 2)).toEqual(['2026-07-24', '2026-07-23'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/lib/daily/dates.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/lib/daily/dates.ts`：
```ts
// 纯日期算术。日期字符串统一 'yyyy-MM-dd'（本地时区语义由调用方保证）。
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function addDays(date: string, delta: number): string {
  const m = date.match(DAY_RE)
  if (!m) throw new Error(`bad date: ${date}`)
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  d.setDate(d.getDate() + delta)
  const y = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

/** 从 anchor 起、含 anchor 的降序连续 count 天（新→旧）。 */
export function dateRange(anchor: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(anchor, -i))
}

/** 在当前(降序)列表尾部之后再取 count 个更早的日期。 */
export function extendEarlier(current: string[], count: number): string[] {
  const tail = current[current.length - 1]
  return Array.from({ length: count }, (_, i) => addDays(tail, -(i + 1)))
}

/** 在当前(降序)列表头部之前再取 count 个更新的日期(近→远靠近 head)。 */
export function extendLater(current: string[], count: number): string[] {
  const head = current[0]
  return Array.from({ length: count }, (_, i) => addDays(head, count - i))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/lib/daily/dates.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/daily/dates.ts src/lib/daily/dates.test.ts
git commit -m "feat(daily): date sequence + lazy-load cursor logic"
```

### Task 10: 链接分类

**Files:**
- Create: `src/lib/daily/link-route.ts`, `src/lib/daily/link-route.test.ts`

- [ ] **Step 1: 写失败测试**

`src/lib/daily/link-route.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { classifyLink } from './link-route'

describe('daily/link-route', () => {
  it('external http(s) → external', () => {
    expect(classifyLink('https://a.com')).toEqual({ kind: 'external', href: 'https://a.com' })
    expect(classifyLink('http://a.com/x')).toEqual({ kind: 'external', href: 'http://a.com/x' })
  })
  it('wikilink date → feed-date', () => {
    expect(classifyLink('[[2026-07-23]]')).toEqual({ kind: 'feed-date', date: '2026-07-23' })
  })
  it('wikilink non-date → page', () => {
    expect(classifyLink('[[Some Page]]')).toEqual({ kind: 'page', page: 'Some Page' })
  })
  it('.md path → md-in-main', () => {
    expect(classifyLink('notes/foo.md')).toEqual({ kind: 'md', path: 'notes/foo.md' })
  })
  it('unknown → null', () => {
    expect(classifyLink('mailto:x@y.com')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/lib/daily/link-route.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/lib/daily/link-route.ts`：
```ts
import { parseDateLink } from '../outline/daily'

export type LinkRoute =
  | { kind: 'external'; href: string }
  | { kind: 'feed-date'; date: string }
  | { kind: 'page'; page: string }
  | { kind: 'md'; path: string }

const WIKILINK_RE = /^\[\[(.+?)\]\]$/

export function classifyLink(raw: string): LinkRoute | null {
  const s = raw.trim()
  if (/^https?:\/\//i.test(s)) return { kind: 'external', href: s }
  const wl = s.match(WIKILINK_RE)
  if (wl) {
    const target = wl[1]
    const d = parseDateLink(target)
    if (d && d.kind === 'day') return { kind: 'feed-date', date: target }
    return { kind: 'page', page: target }
  }
  if (/\.md$/i.test(s)) return { kind: 'md', path: s }
  return null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/lib/daily/link-route.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/daily/link-route.ts src/lib/daily/link-route.test.ts
git commit -m "feat(daily): link classifier (date/page/md/external)"
```

### Task 11: 导航历史栈

**Files:**
- Create: `src/lib/daily/nav-history.ts`, `src/lib/daily/nav-history.test.ts`

- [ ] **Step 1: 写失败测试**

`src/lib/daily/nav-history.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { NavHistory } from './nav-history'

type View = { kind: 'feed'; date?: string } | { kind: 'page'; page: string }

describe('daily/nav-history', () => {
  it('push then back/forward', () => {
    const h = new NavHistory<View>({ kind: 'feed' })
    expect(h.current()).toEqual({ kind: 'feed' })
    h.push({ kind: 'page', page: 'A' })
    h.push({ kind: 'page', page: 'B' })
    expect(h.current()).toEqual({ kind: 'page', page: 'B' })
    expect(h.canBack()).toBe(true)
    expect(h.back()).toEqual({ kind: 'page', page: 'A' })
    expect(h.forward()).toEqual({ kind: 'page', page: 'B' })
  })
  it('push after back truncates forward tail', () => {
    const h = new NavHistory<View>({ kind: 'feed' })
    h.push({ kind: 'page', page: 'A' })
    h.back()
    h.push({ kind: 'page', page: 'C' })
    expect(h.canForward()).toBe(false)
    expect(h.current()).toEqual({ kind: 'page', page: 'C' })
  })
  it('back/forward at ends are no-ops returning current', () => {
    const h = new NavHistory<View>({ kind: 'feed' })
    expect(h.canBack()).toBe(false)
    expect(h.back()).toEqual({ kind: 'feed' })
    expect(h.forward()).toEqual({ kind: 'feed' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/lib/daily/nav-history.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/lib/daily/nav-history.ts`：
```ts
/** 浏览器式前进/后退栈。current() 恒有值(初始项)。 */
export class NavHistory<T> {
  private stack: T[]
  private idx: number
  constructor(initial: T) { this.stack = [initial]; this.idx = 0 }
  current(): T { return this.stack[this.idx] }
  canBack(): boolean { return this.idx > 0 }
  canForward(): boolean { return this.idx < this.stack.length - 1 }
  push(view: T): void {
    this.stack = this.stack.slice(0, this.idx + 1)
    this.stack.push(view)
    this.idx = this.stack.length - 1
  }
  back(): T { if (this.canBack()) this.idx--; return this.current() }
  forward(): T { if (this.canForward()) this.idx++; return this.current() }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/lib/daily/nav-history.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/daily/nav-history.ts src/lib/daily/nav-history.test.ts
git commit -m "feat(daily): navigation history stack"
```

### Task 12: 查找过滤命中判定

**Files:**
- Create: `src/lib/daily/filter.ts`, `src/lib/daily/filter.test.ts`

- [ ] **Step 1: 写失败测试**

`src/lib/daily/filter.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { dayMatches } from './filter'

describe('daily/filter', () => {
  it('empty query matches everything', () => {
    expect(dayMatches(['hello', 'world'], '')).toBe(true)
    expect(dayMatches([], '')).toBe(true)
  })
  it('case-insensitive substring over node texts', () => {
    expect(dayMatches(['Buy Milk', 'Call Bob'], 'milk')).toBe(true)
    expect(dayMatches(['Buy Milk'], 'bob')).toBe(false)
  })
  it('empty day never matches a non-empty query', () => {
    expect(dayMatches([], 'anything')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/lib/daily/filter.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/lib/daily/filter.ts`：
```ts
/** 该天的全部节点文本里是否命中查询(大小写不敏感子串)。空查询恒真。 */
export function dayMatches(nodeTexts: string[], query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return nodeTexts.some(t => t.toLowerCase().includes(q))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/lib/daily/filter.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/daily/filter.ts src/lib/daily/filter.test.ts
git commit -m "feat(daily): find/filter match predicate"
```

---

## Phase 5 — 视图组件（GUI，dev 验证）

> 本阶段组件 IO/DOM 密集，按仓库惯例不做 vitest；每个 Task 以 `pnpm check` 通过 + commit 收口，整体在 Task 18 做 dev 实机验证。

### Task 13: 只读大纲渲染组件

**Files:**
- Create: `src/components/daily/DailyOutlineView.svelte`

- [ ] **Step 1: 实现递归只读渲染**

读取一棵已解析的 outline tree（用现有 `src/lib/outline/model` 的 `OutlineNode`/`childrenOf`），递归渲染 bullets 与文本；双链 `[[…]]` 渲成可点击 pill，点击时 `dispatch('linkclick', { raw })`（供父组件路由）。空树渲染一行占位「（空）」。用 `createEventDispatcher` 暴露 `linkclick`、`activate`（点空白区域→请求激活为编辑器）。

```svelte
<!-- 只读大纲渲染。真正编辑走父级切换到 OutlineEditor。 -->
<script lang="ts">
  import { childrenOf, type OutlineNode, type OutlineTree } from '../../lib/outline/model'
  import { createEventDispatcher } from 'svelte'
  let { tree, parentId = null }: { tree: OutlineTree; parentId?: string | null } = $props()
  const dispatch = createEventDispatcher<{ linkclick: { raw: string }; activate: void }>()
  const nodes = $derived(childrenOf(tree, parentId))
  // 把节点文本里的 [[..]] 切成片段，pill 可点。
  function segments(text: string) {
    const out: { t: 'text' | 'link'; v: string }[] = []
    const re = /\[\[(.+?)\]\]/g; let last = 0; let m
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) })
      out.push({ t: 'link', v: m[1] }); last = re.lastIndex
    }
    if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
    return out
  }
</script>

<ul class="ol">
  {#each nodes as n (n.id)}
    <li>
      <span class="txt" onclick={() => dispatch('activate')} role="button" tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter') dispatch('activate') }}>
        {#each segments(n.content) as seg}
          {#if seg.t === 'link'}<button class="pill" onclick={(e) => { e.stopPropagation(); dispatch('linkclick', { raw: `[[${seg.v}]]` }) }}>{seg.v}</button>{:else}{seg.v}{/if}
        {/each}
      </span>
      <svelte:self {tree} parentId={n.id} on:linkclick on:activate />
    </li>
  {/each}
  {#if nodes.length === 0 && parentId === null}
    <li class="empty" onclick={() => dispatch('activate')} role="button" tabindex="0"
        onkeydown={(e) => { if (e.key === 'Enter') dispatch('activate') }}>（空）</li>
  {/if}
</ul>

<style>
  .ol { list-style: disc; margin: 0; padding-left: 1.2em; }
  li { margin: 2px 0; }
  .txt { cursor: text; }
  .pill { border: none; background: color-mix(in srgb, CanvasText 8%, transparent); border-radius: 4px; padding: 0 4px; cursor: pointer; font: inherit; color: LinkText; }
  .empty { color: color-mix(in srgb, CanvasText 40%, transparent); cursor: text; list-style: none; }
</style>
```
（`OutlineNode` 的文本字段名以 `src/lib/outline/model` 实际为准——实施时 `grep -n "content\|text" src/lib/outline/model.ts` 校正 `n.content`。）

- [ ] **Step 2: 类型检查**

Run: `pnpm check`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add src/components/daily/DailyOutlineView.svelte
git commit -m "feat(daily): read-only outline renderer"
```

### Task 14: 单天区块（只读 ⇄ 活跃编辑器）

**Files:**
- Create: `src/components/daily/DailyDay.svelte`

- [ ] **Step 1: 实现区块**

职责：给定 `date`，计算 `notePath = dailyNotePath(vaultRoot, outlineDirs.dailynote, date)`；按需读盘解析成 tree（用现有解析器；`grep -n "parse\|export" src/lib/outline/*.ts` 找到 .note.md → tree 的解析函数，通常在 `create`/`serialize`/`model` 附近）。

- prop `active: boolean`（父级只允许一个为 true）。
- `active === false`：渲染 `DailyOutlineView`，`on:activate` 时 `dispatch('requestActivate', { date })`；`on:linkclick` 冒泡给父。
- `active === true`：挂载 `OutlineEditor`（`tab` 模式——构造一个指向 `notePath` 的临时 Tab，或用 panel 模式）。切入前父级已 flush 上一活跃天；本组件 `onMount`/`$effect` 变 active 时对该 `notePath` 走 `attachDoc`，失活时 `serializeDoc`+落盘并 `detach`（细节见 Task 15 编排）。

```svelte
<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte'
  import { dailyNotePath } from '../../lib/outline/daily'
  import { outlineDirs } from '../../lib/outline/dirs.svelte'
  import { sotvaultStore } from '../../lib/sotvault.svelte'
  import DailyOutlineView from './DailyOutlineView.svelte'
  import OutlineEditor from '../outline/OutlineEditor.svelte'
  import type { OutlineTree } from '../../lib/outline/model'
  import type { Tab } from '../../lib/tabs.svelte'

  let { date, active = false }: { date: string; active?: boolean } = $props()
  const dispatch = createEventDispatcher<{ requestActivate: { date: string }; linkclick: { raw: string } }>()
  let tree = $state<OutlineTree | null>(null)
  let dayTab = $state<Tab | null>(null)

  const notePath = $derived(
    sotvaultStore.vaultRoot ? dailyNotePath(sotvaultStore.vaultRoot, outlineDirs.dailynote, date) : null
  )

  export async function reload() {
    // 读盘 → tree；文件不存在则空树。实现见 Step 说明（复用 outline 解析器）。
    tree = await loadTreeForPath(notePath)
  }
  onMount(reload)
  // active 变化时的 attach/detach 由父组件通过 bind 到编辑器实例编排(Task 15)。
</script>

<section class="day" class:active>
  <header class="date">{date}</header>
  {#if active}
    <OutlineEditor tab={dayTab} />
  {:else if tree}
    <DailyOutlineView {tree}
      on:activate={() => dispatch('requestActivate', { date })}
      on:linkclick={(e) => dispatch('linkclick', e.detail)} />
  {/if}
</section>

<style>
  .day { border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent); padding: 8px 12px; }
  .date { font-weight: 600; font-size: 12px; opacity: 0.7; margin-bottom: 4px; }
  .active { background: color-mix(in srgb, CanvasText 3%, transparent); }
</style>
```
实施说明：`loadTreeForPath` 用现有从 `.note.md` 文本到 tree 的解析入口（`grep -n "export" src/lib/outline/create.ts src/lib/outline/serialize*.ts`）；读盘用 `@tauri-apps/plugin-fs` 的 `readTextFile`，`catch` 不存在 → 空树。`dayTab` 的构造以 `OutlineEditor` 的 `tab` prop 契约为准（见 `OutlineEditor.svelte:38` 的 `tab`/`mainTab` props）。

- [ ] **Step 2: 类型检查**

Run: `pnpm check`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add src/components/daily/DailyDay.svelte
git commit -m "feat(daily): day block (read-only ⇄ active editor)"
```

### Task 15: 日记流容器（懒加载 + 单活编排）

**Files:**
- Create: `src/components/daily/DailyFeed.svelte`

- [ ] **Step 1: 实现容器**

职责：
- 维护 `dates: string[]`（降序，初始 `dateRange(todayStr(), N)`，N=7）与 `activeDate: string | null`。
- 顶/底哨兵 + `IntersectionObserver`：触底 `dates = [...dates, ...extendEarlier(dates, N)]`；触顶 `dates = [...extendLater(dates, N), ...dates]`（并保持滚动位置，记录 `scrollHeight` 差值补偿）。
- `on:requestActivate`：先 flush 当前活跃天（调用现有 store 的 `serializeDoc()` 落盘 + `detach()`；落盘走 `ensureDailyNote` 意图语义，空树不建文件；hash 冲突沿用 OutlineEditor 内建校验），再 `activeDate = date`。
- `on:linkclick`：冒泡给根组件路由（Task 16）。
- 暴露方法：`jumpTo(date)`（确保该 date 在 `dates` 内，不在则重建 `dates` 锚定它并滚动到位）、`refresh()`（`refreshSotvault()` + 各可见 `DailyDay.reload()`）、`applyFilter(query)`（对已加载天用 `dayMatches` 隐藏未命中）。

关键约束（写代码时遵守）：
- **绝不用空序列化覆盖非空 note**（`project_outline_store_singleton_wipe_guard`）——flush 前校验 `outline.docPath === 期望路径` 且树非空再写。
- `$effect` 内若调用会读+写 `$state` 的 store 函数（bump/detach），用 `untrack` 包裹避免自失效死循环（`feedback_svelte_effect_untrack`）。

- [ ] **Step 2: 类型检查**

Run: `pnpm check`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add src/components/daily/DailyFeed.svelte
git commit -m "feat(daily): lazy-loading feed + single-active editor orchestration"
```

### Task 16: 单页视图 + 根组件路由接线

**Files:**
- Create: `src/components/daily/DailyPage.svelte`
- Modify: `src/daily-notes-app.svelte`

- [ ] **Step 1: 单页视图**

`DailyPage.svelte`：给定 `page`（wikilink 目标名），用 backlinks 的 `openPageOrCreate`/落点解析拿到该页 `.note.md` 路径，挂 `OutlineEditor`（`tab` 模式）。`on:linkclick` 冒泡。

- [ ] **Step 2: 根组件接入视图切换 + 链接路由**

改 `src/daily-notes-app.svelte`：`ready && vault` 分支渲染 `DailyToolbar` + 当前视图（`NavHistory<View>` 的 `current()`）。视图类型：
```ts
type View = { kind: 'feed'; date?: string } | { kind: 'page'; page: string }
```
`handleLink(raw)`（用 `classifyLink`）：
```ts
import { classifyLink } from './lib/daily/link-route'
async function handleLink(raw: string) {
  const r = classifyLink(raw)
  if (!r) return
  if (r.kind === 'external') {
    const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(r.href); return
  }
  if (r.kind === 'md') {
    const { invoke } = await import('@tauri-apps/api/core'); await invoke('editor_show_and_open_path', { path: r.path }); return
  }
  if (r.kind === 'feed-date') { nav.push({ kind: 'feed', date: r.date }); syncView(); return }
  if (r.kind === 'page') { nav.push({ kind: 'page', page: r.page }); syncView(); }
}
```
`syncView()` 把 `nav.current()` 应用到渲染（feed 视图并在有 `date` 时调用 `feed.jumpTo(date)`）。工具栏「上一个/下一个」→ `nav.back()/forward()` + `syncView()`。

- [ ] **Step 3: 类型检查**

Run: `pnpm check`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src/components/daily/DailyPage.svelte src/daily-notes-app.svelte
git commit -m "feat(daily): single-page view + link routing + view switching"
```

### Task 17: 工具栏

**Files:**
- Create: `src/components/daily/DailyToolbar.svelte`

- [ ] **Step 1: 实现工具栏**

从左到右按钮/控件，全部通过 props 回调与根组件通信（`onPrev/onNext/onRefresh/onJump(date)/onFilter(query)` + `canBack/canForward` 禁用态）：
- 上一个 / 下一个（`disabled` 绑 `canBack`/`canForward`）
- 刷新
- 日历：`<input type="date">`，change → `onJump(value)`
- 查找：`<input type="search">`，input → `onFilter(value)`（防抖 150ms）

label/aria 用 i18n：`daily.toolbar.prev/next/refresh/calendar/find`。

- [ ] **Step 2: 类型检查**

Run: `pnpm check`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add src/components/daily/DailyToolbar.svelte
git commit -m "feat(daily): toolbar (prev/next/refresh/calendar/find)"
```

---

## Phase 6 — i18n 收尾 + 验证

### Task 18: i18n 键补全（en + zh）

**Files:**
- Modify: `src/lib/i18n/en.ts` 及 zh 覆盖

- [ ] **Step 1: 补全全部键**

en.ts（值为英文），zh 覆盖（中文）——确保以下键都存在且两边齐平：
```
daily.windowTitle           Daily Notes / 每日笔记
daily.needsVault            Open a vault to use Daily Notes. / 请先打开一个 vault 再使用每日笔记。
daily.emptyDay              (empty) / （空）
daily.toolbar.prev          Back / 上一个
daily.toolbar.next          Forward / 下一个
daily.toolbar.refresh       Refresh / 刷新
daily.toolbar.calendar      Jump to date / 跳转日期
daily.toolbar.find          Find / 查找
settings.dailyNotes.label   Daily Notes window / 每日笔记窗口
tray.dailyNote              Today's Note / 今天的日记   (Task 3 已建，核对)
tray.dailyNotes             Daily Notes / 每日笔记        (Task 3 已建，核对)
```
把 Task 4/8/13/17 里临时/散落新增的键统一到此处核对，去重。

- [ ] **Step 2: 类型/单测**

Run: `pnpm check && pnpm test`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add src/lib/i18n
git commit -m "i18n: complete Daily Notes strings (en + zh)"
```

### Task 19: dev 实机验证（GUI）

**Files:** 无（验证）

- [ ] **Step 1: 确认桌面无并发会话**

遵循 `feedback_gui_verify_desktop_contention`：确认当前无其它会话在驱动桌面，避免外来键击污染验证。

- [ ] **Step 2: 起 dev 构建**

按 `reference_dev_gui_verification` 起 dev（`pnpm tauri dev` 或仓库既定命令），日志重定向 `/tmp/mdeditor.log`。

- [ ] **Step 3: 走查清单**

- 打开 Settings → 打开「每日笔记窗口」开关 → tray 里「今天的日记」变为「每日笔记」。
- 点 tray「每日笔记」→ 独立窗口打开（单实例：再点不新开，只聚焦）。
- 窗口显示今天在内的连续多天；向上滚加载更早、向下滚加载更晚（懒加载）。
- 点某天空白 → 该天变为可编辑 OutlineEditor；输入内容 → 切到另一天后回来，内容已落盘（`vault/{dailynoteDir}/{yyyy}/{date}.note.md` 存在）。
- 空白日不输入不产生文件（意图落盘）。
- 双链：`[[yyyy-MM-dd]]` 跳该天；`[[某页]]` 切单页视图；上一个/下一个可回退/前进。
- 普通 `.md` 链接 → 主编辑窗口打开；外链 → 系统浏览器打开。
- 工具栏：刷新（外部改动后可见）、日历跳转、查找过滤命中。
- 关闭开关 → tray 恢复「今天的日记」，点击回到主编辑器开今天（旧行为）。
- 深浅色跟随系统切换正常（无浅色钉死）。

- [ ] **Step 4: 截图留证 + 记录问题**

`screencapture` 关键状态；发现回归回到对应 Task 修复。

---

## Self-Review（作者自查结论）

- **Spec 覆盖**：§2 窗口→Task 4/5；§3 数据模型→Task 9/14；§4 单活日记流→Task 14/15；§5 链接路由→Task 10/16；§6 工具栏→Task 11/12/17；§7 开关+tray+改名→Task 1/2/3/6/7/8；§8 i18n→Task 3/18；§9 错误处理→Task 15（wipe guard/冲突/意图落盘）；§10 测试→Task 9-12 纯逻辑 + Task 19 GUI。无遗漏。
- **占位扫描**：纯逻辑任务均含完整测试+实现代码；GUI/Rust 任务给出完整文件内容或精确改点，标注了两处需 `grep` 现场校正的字段名（`OutlineNode` 文本字段、`.note.md`→tree 解析入口、设置面板组件路径）——这些是「按仓库实际契约核对」而非未定内容。
- **类型一致**：`classifyLink` 返回类型在 Task 10 定义、Task 16 消费一致；`View`/`NavHistory<View>` 在 Task 11/16 一致；`dailyNotePath`/`outlineDirs.dailynote`/`todayStr`/`parseDateLink` 均引用现有导出；tray id/event/key 改名在 Task 1/2/3 一致（`tray-daily-note` / `tray.dailyNote` / `tray-daily-notes-open` / `tray.dailyNotes`）。
