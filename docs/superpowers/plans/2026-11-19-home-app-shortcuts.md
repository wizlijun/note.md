# Home App Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现用户已确认的专注首页和8格固定/常用插件启动区。

**Architecture:** 纯函数负责格位/排名/主入口解析，单一本机store负责持久化；统一插件dispatcher上报明确成功的使用；Svelte首页组件消费状态并复用现有Vault/设置。每个任务独立验证提交，下一任务使用前一任务实际接口。

**Tech Stack:** Svelte 5/TypeScript/Tauri Store、Vitest和Testing Library；现有CSS，无新增依赖。

**Spec:** docs/superpowers/specs/2026-11-19-home-app-shortcuts-design.md

## Global Constraints

- 首页顺序：创建/打开图标 → Apps → 设置；顶部图标与Apps前三列对齐。
- 最多8格，固定序号不因排序改变；同ID去重；30本地日、最近7日双倍、30秒去重、每日进入快照。
- 全部应用基于本机安装清单，禁用保留固定，卸载只在完整成功清单后清理；失败/取消不计使用。
- 仅蓝、青、赭三组低饱和色与中性色，图标56px，无渐变/动画，浅色与近黑深色，窄屏两列。
- 弹层菜单复用menu-panel/menu-row，不写局部hover背景。四语文案。
- 不改NEXT任务契约、插件市场发布流程、正式Vault、原有两处EOF改动。无新增依赖。不安装、不发布、不推送。

### Task 1: 快捷位模型、入口目录和本机持久化

**Files:** Create src/lib/home-apps/model.ts, catalog.ts, store.svelte.ts and corresponding *.test.ts.

**Interfaces:**
- model: `HomeAppsData { version: 1; pins: (string|null)[]; usage: Record<string, {days: Record<string,number>; lastUsed: number}>; snapshot: {day:string; ids:string[]} }`.
- Exports `emptyHomeAppsData()`, `normalizeHomeAppsData(value:unknown)`, `recordUsage(data,id,now)`, `pinApp(data,id,slot)`, `unpinApp(data,id)`, `movePin(data,id,slot)`, `reconcileInstalled(data,installedIds)`, `refreshRanking(data,eligibleIds,now)`, `shortcutSlots(data,eligibleIds): (string|null)[]`. Pure operations return next data and do not mutate input. Range errors/duplicate constraints explicit.
- catalog: `HomeApp {id,name,description,category,enabled,available,manifest?,entry}`; `entry` discriminated union `{kind:'command';command:string}|{kind:'details'}`. `buildHomeApps(installed:InstalledV2[], manifests:PluginManifest[], locale:string):HomeApp[]`. Resolve explicit open window, unique window, unique file view, then details. `appIcon(id)` returns stable glyph/tone choice for future component; unknown uses generic glyph. Can export simple types instead of SVG code.
- store: reactive `homeAppsStore {data,ready,busy,error}`; async `loadHomeApps()`, `recordHomeAppUse(id,now?)`, `pinHomeApp(id,slot)`, `unpinHomeApp(id)`, `moveHomeApp(id,slot)`, `reconcileHomeApps(installedIds)`, `refreshHomeAppRanking(eligibleIds,now?)`. Store file home-apps.json, key data; wait hydration, serialize writes; update reactive saved state only after save. `loadHomeApps` supports retry after failure. Helpers return Promise<void>; reject saves for UI reporting, never erase on read error.

- [ ] Write focused failing tests for positions, swaps, full grid, disabled/uninstalled handling, window/file-view/details mapping and daily ranking; run direct `node_modules/.bin/vitest run src/lib/home-apps`.

```ts
const d = pinApp(emptyHomeAppsData(), 'a', 3)
expect(shortcutSlots(d, ['a','b'])[3]).toBe('a')
expect(d.pins.filter(Boolean)).toEqual(['a'])
// Record b at day 0, rank then record c on same day: existing snapshot must not jump.
// Advance local day and rank: new eligible usage participates; pins stay at same index.
```

- [ ] Implement immutable helpers and local date scoring, stable tie-breaks, schema normalization and bounded 30-day buckets. On pin new ID to occupied pinned slot reject; moving existing pinned swaps; moving auto item into occupied pinned slot swaps using its visible source slot via UI two-pin operation or explicit helper extension, documented in report.
- [ ] Add async Store tests: concurrent load+pin+use preserves all state; failed get doesn't overwrite; failed save leaves previous visible state and allows retry. Implement serialized load/write without swallowing errors.
- [ ] Run focused tests, inspect diff, commit only task files. Write report with RED/GREEN evidence and actual exported signatures.

### Task 2: 统一启动计数和返回首页导航

**Files:** Modify src/App.svelte, src/lib/plugins/file-view-commands.ts (only if necessary), src/lib/tabs.svelte.ts, src/components/TabBar.svelte, relevant tests and src/lib/i18n/{en,zh,ja,de}.ts.

**Interfaces:** Consumes `recordHomeAppUse(id)` from Task1. Produces `activateHome():Promise<void>` in tabs.svelte.ts. Reuses `activeId.value=null` for home while retaining tabs, rather than duplicate home booleans. Shared dispatcher remains `(pluginId,command)=>Promise<void>` unless clear need; counting occurs exactly where success is known, not on resolution of a swallowed error.

- [ ] Add failing tests proving return-home flushes active modified/native session, rejects transition on flush failure, retains tabs, and can activate existing tab again. Add single-file TabBar home entry and active home selection tests.

```ts
await m.activateHome()
expect(m.activeId.value).toBeNull()
expect(m.tabs.map(t => t.id)).toEqual(beforeIds)
await m.activate(beforeIds[0])
expect(m.activeId.value).toBe(beforeIds[0])
```

- [ ] Implement activateHome with existing flush barriers and stale-active guards. Expose home tab on desktop when one or more file tabs exist; homepage with no files need not add a redundant tab strip. Hide ModeToggle when no active doc. Preserve phone behavior. Error remains visible and existing doc stays selected.
- [ ] Add behavioral tests for usage only after successful window open / actual file view open callback; cancellation, mismatched file, unknown/disabled plugin and rejected invoke do not record. Check live enabled_when before dispatch. Route menu and component through same existing function; do not count backend auto activations. Use helper extraction if needed to test actual command branching instead of source-string assertions.
- [ ] Implement four locale home label and safe nonblocking usage persistence error reporting; stats failures must not make plugin open fail. Keep runtime signature compatible. Run TabBar, tabs, file-view command and added dispatcher tests, then commit only verified files; write report.

### Task 3: 首页应用UI、目录、固定编辑与折叠Vault

**Files:** Modify src/components/EmptyState.svelte, VaultOverview.svelte, their tests and four locale files. Create src/components/HomeApps.svelte, AppIcon.svelte, HomeApps.test.ts, EmptyState.test.ts; create a focused AppDirectory component if needed. Add reusable src/styles/home-apps.css for shared grid/tile tokens. Modify CHANGELOG.md and CHANGELOG.zh-CN.md or actual existing bilingual log filenames after checking repository.

**Interfaces:** Uses Task1 store/catalog, Task2 dispatch/navigation, `pluginRuntime.manifests`, `plugin_market_installed`, `plugins-changed`, `openSettings`, `open_plugin_market_window`. Props remain compatible for EmptyState and VaultOverview. Components use localized keys, not hardcoded Chinese.

- [ ] Add failing component tests for top creation-icon actions, Apps/Settings order, collapsed Vault detail controls with visible stats and errors; existing reveal tests must expand details first. Add HomeApps tests for installed directory/search/category, cold-start, pin/select-position/full-cap, drag swap and keyboard alternative, disabled detail state, errors/retry, and stale load/unmount behavior.

```ts
render(VaultOverview)
expect(screen.queryByRole('button', {name: 'Copy path'})).toBeNull()
await fireEvent.click(screen.getByRole('button', {name: 'Show details'}))
expect(screen.getByRole('button', {name: 'Copy path'})).toBeTruthy()
```

- [ ] Implement shared four-column grid and flat SVG icons/tone mapping, static CSS light/dark palettes and two-column narrow fallback. Top identity compact, no large numeral or bottom action duplication. iOS must not mount desktop HomeApps.
- [ ] Load complete installed catalog independently from runtime; handle loading/error/retry and plugins-changed with late-response protection. Only successful catalogs reconcile uninstalls. Freeze rankings on mount/day boundary, not on every usage reactive update. Fixed inactive icons stay at exact slot, clicking gives reason/manage; automatic unavailable icons are removed.
- [ ] Implement accessible dialog directory: search + existing category filter, explicit details, pin target selector and close/focus restoration. Reuse global popup classes for context menu; keyboard Escape and menu navigation. Open declared commands through existing dispatcher; detail usage recorded only for enabled/available entries after open. No arbitrary command auto-execution.
- [ ] Implement edit mode fixed-slot drag/drop and explicit move-to-slot controls, full grid limits, consistent save failures. Avoid duplicate IDs and moving uninvolved fixed slots. Top creation handlers catch async failures; icon double clicks do not propagate to background new-note action.
- [ ] Fold secondary Vault information under aria-expanded details; retain loading/errors/partial-state visibility and existing watchers. Localize all new labels in en/zh/ja/de; update bilingual Unreleased behavior list.
- [ ] Run focused tests and svelte-check, inspect diff and commit task changes. Report exact tests/remaining verification boundaries.

### Task 4: 整体评审、浏览器验收和交付证据

**Files:** docs/superpowers/reports/2026-11-19-home-app-shortcuts/verification.md and verified screenshots; task-related fixes only.

- [ ] Run complete frontend suite, typecheck and production build from isolated worktree using existing installed binaries; save logs outside tracked source.
- [ ] Mount real components with isolated IPC fixtures in a local browser. Verify light/dark at desktop size, narrow screen, long name, error states, keyboard, context hover, fixed-slot persistence, full/empty directory, and collapsed/expanded stats. Use actual rendered screenshots; never treat generated design mockups as acceptance evidence.
- [ ] Dispatch independent final review against entire branch with spec and test evidence. Resolve substantive findings, rerun affected tests, and update report with exact current commit and limitations.
- [ ] Commit evidence, update tasks/todo and ledger. Preserve original workspace dirty files and generated mockups. No automatic merge/push/release; deliver branch/worktree path and SHA with instructions if user wants to inspect later.
