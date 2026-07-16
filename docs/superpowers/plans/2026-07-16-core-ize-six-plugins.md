# 子项目⓪：六插件 Core 化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 sotvault / outline-notes / folder-view / share / git-history / reading-insights 从 v1 插件体系收编为核心特性：删 manifest、菜单/右键/设置/CLI 内化、启用门摘除、share 桌面端切换到既有 TS 实现并退役 mdshare 二进制。

**Architecture:** v1 插件机制本身不动（md2pdf/roam-import/openclaw-chat/base 仍是 v1 builtin）。六个插件的贡献点逐类内化：原生菜单项在 Rust `build_menu()` 中直接定义（沿用现有 core 菜单项风格），点击经既有 `menu-event`→`dispatch()` 中央命令分发器；share 复用 `src/lib/share/` 的完整 TS 实现（iOS 已在用），mdshare 二进制退役；CLI 用"core CLI stub manifest"注入 `current_scan`，路由/执行层零结构改动。

**Tech Stack:** Tauri v2 (Rust) + Svelte 5 + vitest + cargo test。

**Spec:** `docs/superpowers/specs/2026-07-16-plugin-system-v2-design.md` §9。
**Spec 偏离（已核实的优化）:** spec §9 写"mdshare crate 编译进 src-tauri"。勘查发现 `src/lib/share/index.ts` 已有全功能 TS 实现（`sharePublishCurrent/shareUnpublishCurrent/shareCopyLinkCurrent`，含 prepareShareSrc 前置、bakeShareHtml、25MB 上限，iOS 路径在用，`commands.ts:66-68` 已注册），桌面/CLI 切 TS 路径可整体退役 mdshare 双实现。Task 8 回写 spec。

**工作区注意:** 主 worktree 常被多会话共享——每次提交只精确 `git add` 本任务列出的文件，绝不 `add -A`。

---

### Task 1: Rust 原生菜单——七个核心菜单项 + 标签目录

**Files:**
- Modify: `src-tauri/src/lib.rs`（`menu_label` 目录 ~1254 行区；`build_menu()` File 菜单 ~1480-1502、View 菜单 ~1541-1555）

- [ ] **Step 1: menu_label 目录加 7 个键**

在 `src-tauri/src/lib.rs` 的 `menu_label` 函数中，`"view.insights" => (...)` 行之后插入（译文逐字取自被删 manifest 的 i18n）：

```rust
        "file.syncToVault" => ("Sync to Vault…", "同步到 Vault…", "Vault に同期…", "Mit Vault synchronisieren…"),
        "file.share" => ("Share Current File…", "分享当前文件…", "現在のファイルを共有…", "Aktuelle Datei teilen…"),
        "file.unshare" => ("Unshare Current File…", "取消分享当前文件…", "現在のファイルの共有を解除…", "Freigabe der aktuellen Datei aufheben…"),
        "file.copyShareLink" => ("Copy Share Link", "复制分享链接", "共有リンクをコピー", "Freigabe-Link kopieren"),
        "view.folderView" => ("Folder View", "文件夹视图", "フォルダビュー", "Ordneransicht"),
        "view.sidecarNotes" => ("Sidecar Notes View", "伴生笔记视图", "サイドカーノートビュー", "Begleitnotizen-Ansicht"),
        "view.history" => ("History View", "历史视图", "履歴ビュー", "Verlaufsansicht"),
```

- [ ] **Step 2: File 菜单加 sync-to-vault + share×3**

`build_menu()` 中 File 菜单的 `print` item 之后（`);` 结束链之前）追加：

```rust
        .separator()
        .item(&MenuItemBuilder::with_id("sync-to-vault", menu_label(locale, "file.syncToVault")).build(app)?)
        .item(
            &MenuItemBuilder::with_id("share", menu_label(locale, "file.share"))
                .accelerator("Cmd+Shift+L")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("unshare", menu_label(locale, "file.unshare")).build(app)?)
        .item(&MenuItemBuilder::with_id("copy-share-link", menu_label(locale, "file.copyShareLink")).build(app)?)
```

（id `share`/`unshare`/`copy-share-link` 特意与 `commands.ts` 既有 CommandId 一致——App.svelte menu-event 监听的 default 分支回落到 `dispatch(id as CommandId)`，share 三项零新增监听代码。）

- [ ] **Step 3: View 菜单加三个侧栏 toggle**

View 菜单 `open-insights` item 之后追加（快捷键与原 manifest 一致）：

```rust
        .separator()
        .item(&MenuItemBuilder::with_id("toggle-folder-view", menu_label(locale, "view.folderView")).accelerator("Cmd+Shift+E").build(app)?)
        .item(&MenuItemBuilder::with_id("toggle-sidecar-notes", menu_label(locale, "view.sidecarNotes")).accelerator("Cmd+Shift+O").build(app)?)
        .item(&MenuItemBuilder::with_id("toggle-git-history", menu_label(locale, "view.history")).accelerator("Cmd+Shift+Y").build(app)?)
```

已知现状保留项：md2pdf（仍是 v1 插件）也声明 Cmd+Shift+E——与今日行为一致，不在本期处理。

- [ ] **Step 4: 编译验证**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 编译通过（菜单在 GUI 手测任务验证）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(core): add native menu items for core-ized plugins (sync-to-vault, share×3, side-view toggles)"
```

---

### Task 2: 前端命令分发 + 菜单 enabled 同步

**Files:**
- Modify: `src/lib/commands.ts`（CommandId union + handlers）
- Modify: `src/lib/plugins/menu-registry.ts`（新增 CORE_MENU_ENABLED_ITEMS）
- Modify: `src/App.svelte`（menu-event 内删 sotvault 分支；enabled-sync effect 追加核心项）
- Test: `src/lib/plugins/menu-registry.test.ts`

- [ ] **Step 1: 写失败测试（核心 enabled 项的形状与表达式）**

在 `src/lib/plugins/menu-registry.test.ts` 末尾追加：

```ts
import { CORE_MENU_ENABLED_ITEMS } from './menu-registry'

describe('CORE_MENU_ENABLED_ITEMS', () => {
  it('covers the five conditional core menu ids with original enabled_when expressions', () => {
    const byId = Object.fromEntries(CORE_MENU_ENABLED_ITEMS.map((i) => [i.id, i]))
    expect(byId['sync-to-vault'].enabledWhen).toBe('currentTab.canSyncToVault')
    expect(byId['share'].enabledWhen).toBe('currentTab.hasContent')
    expect(byId['unshare'].enabledWhen).toBe('settings["share.records"][currentTab.path]')
    expect(byId['copy-share-link'].enabledWhen).toBe('settings["share.records"][currentTab.path]')
    expect(byId['toggle-git-history'].enabledWhen).toBe('currentTab.isInVault')
    expect(byId['unshare'].pluginId).toBe('share')  // settings 上下文取 share scope（records 合成保留）
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/plugins/menu-registry.test.ts`
Expected: FAIL（CORE_MENU_ENABLED_ITEMS 未导出）。

- [ ] **Step 3: menu-registry.ts 实现 CORE_MENU_ENABLED_ITEMS**

在 `collectMenuItems` 定义之后追加（CollectedItem 为该文件既有类型；`command` 填 id 同值仅为满足类型，核心项不走 dispatchPlugin）：

```ts
/** Core-ized（原插件）菜单项的 enabled_when 表——App.svelte 的 enabled-sync
 *  effect 将它们与插件项同样对待（表达式与原 manifest 逐字一致）。
 *  始终可用的核心项（三个 view toggle 中除 git-history 外）不需要出现在这里。 */
export const CORE_MENU_ENABLED_ITEMS: CollectedItem[] = [
  { id: 'sync-to-vault', pluginId: 'sotvault', command: 'sync-to-vault', label: '', enabledWhen: 'currentTab.canSyncToVault' },
  { id: 'share', pluginId: 'share', command: 'share', label: '', enabledWhen: 'currentTab.hasContent' },
  { id: 'unshare', pluginId: 'share', command: 'unshare', label: '', enabledWhen: 'settings["share.records"][currentTab.path]' },
  { id: 'copy-share-link', pluginId: 'share', command: 'copy-share-link', label: '', enabledWhen: 'settings["share.records"][currentTab.path]' },
  { id: 'toggle-git-history', pluginId: 'git-history', command: 'toggle', label: '', enabledWhen: 'currentTab.isInVault' },
]
```

若 CollectedItem 含其他必填字段，按类型补齐字面量（不改类型定义）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/plugins/menu-registry.test.ts`
Expected: PASS。

- [ ] **Step 5: commands.ts 注册四个新命令**

CommandId union 追加 `| 'sync-to-vault' | 'toggle-folder-view' | 'toggle-sidecar-notes' | 'toggle-git-history'`；imports 追加：

```ts
import { syncCurrentToVault } from './sotvault.svelte'
import { toggleSideView } from './side-panel/registry.svelte'
```

handlers 追加：

```ts
  'sync-to-vault': syncCurrentToVault,
  'toggle-folder-view': () => toggleSideView('folder-view'),
  'toggle-sidecar-notes': () => toggleSideView('outline-notes'),
  'toggle-git-history': () => toggleSideView('git-history'),
```

（menu-event default 分支已回落 `dispatch(id)`，无需改监听。）

- [ ] **Step 6: App.svelte——删 sotvault 分支、enabled effect 并入核心项**

`dispatchPlugin` 中删除（roam-import/base 分支**保留**，它们仍是 v1 插件）：

```ts
        if (pluginId === 'sotvault') {
          if (command === 'sync-to-vault') await syncCurrentToVault()
          return
        }
```

enabled-sync `$effect`（~695-716 行，`allItems` 展开处）把核心项并入：

```ts
    const allItems = [
      ...collectedItems.file,
      ...collectedItems.edit,
      ...collectedItems.view,
      ...collectedItems.window,
      ...collectedItems.help,
      ...collectedItems.plugins,
      ...CORE_MENU_ENABLED_ITEMS,
    ]
```

（`CORE_MENU_ENABLED_ITEMS` 从 menu-registry import；`set_plugin_menu_item_enabled` 按 id 走全菜单树，核心 id 直接可用。）

- [ ] **Step 7: 全量前端校验**

Run: `pnpm check && pnpm vitest run`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add src/lib/commands.ts src/lib/plugins/menu-registry.ts src/lib/plugins/menu-registry.test.ts src/App.svelte
git commit -m "feat(core): route core-ized menu ids through central command dispatcher; enabled-sync covers core items"
```

---

### Task 3: 启用门摘除（gates / sotvault / insights tracker）

**Files:**
- Modify: `src/lib/folder-view.svelte.ts:449-465`、`src/lib/outline/gate.svelte.ts:26-33`、`src/lib/git-history/gate.svelte.ts:23-29`
- Modify: `src/lib/sotvault.svelte.ts:56,214,270`
- Modify: `src/lib/insights/tracker.svelte.ts:93-96`
- Test: `src/lib/folder-view.test.ts`、`src/lib/sotvault.test.ts`、`src/lib/insights/tracker.test.ts`

- [ ] **Step 1: 三个 gate 恒真**

每个 gate 的 load 函数中 `xxx.enabled = isPluginEnabled(PLUGIN_ID)` 改为 `xxx.enabled = true`，删除 `isPluginEnabled` import（PLUGIN_ID 常量若仍被侧栏注册引用则保留）。以 outline 为例：

```ts
export async function loadOutlineGate(): Promise<void> {
  outlineGate.enabled = true
  const s = await getStore()
  ...
}
```

- [ ] **Step 2: sotvault 三处 isPluginActive 摘除**

`src/lib/sotvault.svelte.ts` 中：
- 行 56：`isPluginActive('sotvault') ? await invoke<SotRecord[]>('sotvault_records') : []` → `await invoke<SotRecord[]>('sotvault_records')`（Rust 侧无启用门，已核实）
- 行 214、270：删除 `if (!isPluginActive('sotvault')) return` 行
- 删除 `isPluginActive` import

**预期行为变化（spec 判定的直接后果，非回归）：** 原未启用 sotvault 插件的用户，升级后 vault 刷新/push 行为随 vault 配置生效。

- [ ] **Step 3: insights tracker 摘除插件门（保留 vault 门）**

`src/lib/insights/tracker.svelte.ts` `installTracker()` 中：

```ts
  if (!isPluginEnabled(PLUGIN_ID) || sotvaultStore.vaultRoot === null) return () => {}
```
改为：
```ts
  if (sotvaultStore.vaultRoot === null) return () => {}
```
删除 `isPluginEnabled` import。

- [ ] **Step 4: 修三个测试文件的 mock**

`folder-view.test.ts`、`sotvault.test.ts`、`tracker.test.ts` 中删除对 `isPluginEnabled('folder-view')` / `isPluginActive('sotvault')` / `isPluginEnabled('reading-insights')` 的 mock 与相关断言（"disabled 时不生效"的用例整条删除——该状态不再存在；"enabled 时生效"的用例去掉 mock 直接跑）。

- [ ] **Step 5: 跑测试**

Run: `pnpm vitest run src/lib/folder-view.test.ts src/lib/sotvault.test.ts src/lib/insights/tracker.test.ts src/lib/side-panel/`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/lib/folder-view.svelte.ts src/lib/outline/gate.svelte.ts src/lib/git-history/gate.svelte.ts src/lib/sotvault.svelte.ts src/lib/insights/tracker.svelte.ts src/lib/folder-view.test.ts src/lib/sotvault.test.ts src/lib/insights/tracker.test.ts
git commit -m "feat(core): remove plugin-enabled gates from core-ized features (side views, sotvault, insights tracker)"
```

---

### Task 4: share 桌面路径切 TS + tab 右键核心项 + App.svelte 清理

**Files:**
- Modify: `src/App.svelte`（dispatchPlugin 的 share 前置 383-395、baker share 分支 423）
- Modify: `src/components/TabBar.svelte`（核心 context 项）
- Modify: `src/lib/i18n/en.ts`、`zh.ts`、`ja.ts`、`de.ts`（tab 右键标签键）

- [ ] **Step 1: App.svelte 删 share 特例**

`dispatchPlugin` 中删除 share publish 前置块（`if (m.id === 'share' && command === 'publish' && snap.path) { ... }` 整块，383-395）与 baker 的 share 分支（`if (m.id === 'share') return bakeShareHtml(t, activeTheme.id)`，423 行；`bakeShareHtml`/`prepareShareSrc` 的 import 若无他处使用一并删除）。share 菜单已不产生 `plugin:share:*` id，此路径死代码化，删除即安全。

- [ ] **Step 2: i18n 加 tab 右键标签键**

`en.ts` 追加 `'share.tabShare': 'Share This Tab…'`；`zh.ts`：`'share.tabShare': '分享此标签页…'`；`ja.ts`：`'share.tabShare': 'このタブを共有…'`；`de.ts`：`'share.tabShare': 'Diesen Tab teilen…'`（逐字取自原 manifest context_menus i18n）。

- [ ] **Step 3: TabBar 追加核心 context 项并分流点击**

`allTabContextItems` derived 改为：

```ts
  let allTabContextItems = $derived([
    {
      id: 'core:share-tab', pluginId: 'share', command: 'share',
      label: t('share.tabShare'), enabledWhen: 'currentTab.hasContent',
    } as CollectedItem,
    ...collectMenuItems(pluginRuntime.manifests).tabContext,
  ])
```

`onCtxItemClick` 开头分流核心项：

```ts
  async function onCtxItemClick(item: CollectedItem, enabled: boolean) {
    if (!enabled) return
    closeCtxMenu()
    if (item.id.startsWith('core:')) {
      const { dispatch } = await import('../lib/commands')
      await dispatch(item.command as CommandId)
      return
    }
    try { await dispatchPluginCommand(item.pluginId, item.command) }
    catch (e) { console.warn('[TabBar] context menu dispatch failed:', e) }
  }
```

（`t` 与 `CommandId` 按需 import；`openTabContextMenu` 对核心项的 enabled 评估复用既有 evaluateEnabled，无需改动。）

- [ ] **Step 4: 校验**

Run: `pnpm check && pnpm vitest run`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/App.svelte src/components/TabBar.svelte src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/ja.ts src/lib/i18n/de.ts
git commit -m "feat(core): desktop share flows through TS implementation; core tab-context share item"
```

---

### Task 5: Share 设置页 core 化

**Files:**
- Create: `src/lib/share/settings-tab.ts`
- Modify: `src/components/SettingsDialog.svelte:178-186`
- Test: `src/lib/share/settings-tab.test.ts`

- [ ] **Step 1: 写失败测试**

`src/lib/share/settings-tab.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { coreShareSettingsTab } from './settings-tab'

describe('coreShareSettingsTab', () => {
  it('preserves the four share settings fields with original keys and defaults', () => {
    const tab = coreShareSettingsTab()
    expect(tab.pluginId).toBe('share')
    const keys = tab.schema.map((f) => f.key)
    expect(keys).toEqual(['share.baseUrl', 'share.apiKey', 'share.defaultExpiry', 'share.slugRandomSuffix'])
    expect(tab.schema[2]).toMatchObject({ type: 'select', options: ['never', '7d', '30d', '90d'], default: 'never' })
    expect(tab.manifest.i18n?.zh?.['settings.tab_label']).toBe('分享')
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `pnpm vitest run src/lib/share/settings-tab.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现 settings-tab.ts**

内容为原 `src-tauri/plugins/share/manifest.json` 的 settings 与 i18n 逐字迁移（stub manifest 满足 `SettingsTab.manifest` 的本地化用途）：

```ts
import type { SettingsTab } from '../plugins/settings-registry'
import type { PluginManifest } from '../plugins/types'

const STUB: PluginManifest = {
  id: 'share', name: 'Share', version: 'core', binary: '', host_capabilities: [],
  settings: {
    tab_label: 'Share',
    schema: [
      { key: 'share.baseUrl', type: 'string', label: 'Service Base URL', default: 'https://mdeditor-share.your-account.workers.dev', placeholder: 'https://share.example.com' },
      { key: 'share.apiKey', type: 'secret', label: 'API Key' },
      { key: 'share.defaultExpiry', type: 'select', label: 'Default expiry', options: ['never', '7d', '30d', '90d'], default: 'never' },
      { key: 'share.slugRandomSuffix', type: 'boolean', label: 'Append 3-char random suffix to URL (recommended)', default: true },
    ],
  },
  i18n: {
    zh: { 'settings.tab_label': '分享', 'settings.fields': { 'share.baseUrl': '服务基础 URL', 'share.apiKey': 'API Key', 'share.defaultExpiry': '默认有效期', 'share.slugRandomSuffix': '在 URL 后追加 3 位随机后缀（推荐）' } },
    ja: { 'settings.tab_label': '共有', 'settings.fields': { 'share.baseUrl': 'サービスのベース URL', 'share.apiKey': 'API Key', 'share.defaultExpiry': '既定の有効期限', 'share.slugRandomSuffix': 'URL に 3 文字のランダムな接尾辞を追加（推奨）' } },
    de: { 'settings.tab_label': 'Teilen', 'settings.fields': { 'share.baseUrl': 'Dienst-Basis-URL', 'share.apiKey': 'API-Schlüssel', 'share.defaultExpiry': 'Standardablauf', 'share.slugRandomSuffix': '3-stelliges Zufallssuffix an URL anhängen (empfohlen)' } },
  },
}

export function coreShareSettingsTab(): SettingsTab {
  return { pluginId: 'share', label: STUB.settings!.tab_label, schema: STUB.settings!.schema, manifest: STUB }
}
```

- [ ] **Step 4: SettingsDialog 前置核心 tab**

onMount 中：

```ts
      const manifests = await invoke<PluginManifest[]>('get_plugin_manifests')
      pluginTabs = [coreShareSettingsTab(), ...collectSettingsTabs(manifests)]
```

catch 分支同样保证 `pluginTabs = [coreShareSettingsTab()]`（离线/异常时 Share 设置仍在）。import `coreShareSettingsTab`。

- [ ] **Step 5: 确认通过** — Run: `pnpm vitest run src/lib/share/settings-tab.test.ts && pnpm check` → PASS。

- [ ] **Step 6: Commit**

```bash
git add src/lib/share/settings-tab.ts src/lib/share/settings-tab.test.ts src/components/SettingsDialog.svelte
git commit -m "feat(core): share settings tab becomes a core settings tab"
```

---

### Task 6: CLI——core stub 注入 + share 走 TS + reading-insights 去门

**Files:**
- Modify: `src-tauri/src/cli/runner.rs`（`current_scan` 追加 core stubs）
- Modify: `src-tauri/src/cli/router.rs`（reading-insights 块去 enabled 门）
- Modify: `src/lib/cli/CliRunner.svelte`（share 前置分流；删生态路径里的 share 特例）
- Test: `src-tauri/src/cli/router.rs` 内联测试（resolve_with 纯函数）

- [ ] **Step 1: 写失败的 router 测试**

router.rs 测试模块追加（沿用现有 resolve_with 测试的构造习惯）：

```rust
    #[test]
    fn share_routes_without_manifest() {
        // share 是 core：无 manifest 时也必须路由成功（core stub 由 current_scan 注入，
        // 纯函数层直接喂 stub 验证匹配逻辑）。
        let stubs = core_cli_stub_manifests();
        let pairs: Vec<(PluginManifest, PathBuf)> =
            stubs.into_iter().map(|m| (m, PathBuf::new())).collect();
        let r = resolve_with(&vec!["share".into(), "/tmp/a.md".into()], &pairs, &HashMap::new());
        match r {
            Route::Plugin(p) => assert_eq!(p.plugin_id, "share"),
            other => panic!("expected share plugin route, got {:?}", other),
        }
    }

    #[test]
    fn reading_insights_never_disabled() {
        let r = resolve_with(&vec!["reading-insights".into(), "report".into()], &[], &HashMap::from([("reading-insights".to_string(), false)]));
        assert!(matches!(r, Route::Plugin(_)), "core-ized: enabled map must be ignored");
    }
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml cli::` → FAIL（`core_cli_stub_manifests` 不存在；reading-insights 返回 Disabled）。

- [ ] **Step 2: 实现 core_cli_stub_manifests + 注入 current_scan**

`runner.rs`（或 cli/mod.rs，与 current_scan 同处）新增——字段值逐字取自被删的两个 manifest 的 cli 段：

```rust
/// Core-ized 功能的 CLI stub：share 与 reading-insights 的子命令属于核心，
/// 不再有磁盘 manifest；注入扫描结果供 router/runner 统一匹配。
pub fn core_cli_stub_manifests() -> Vec<PluginManifest> {
    let share = serde_json::from_value(serde_json::json!({
        "id": "share", "name": "Share", "version": "core", "binary": "",
        "host_capabilities": ["renderer.html", "settings.read", "settings.write:share.records", "clipboard.write", "toast", "dialog"],
        "cli": [{
            "subcommand": "share", "aliases": ["--share"], "command": "publish",
            "summary": "Render and publish file as a shareable URL",
            "args": [{ "name": "file", "type": "path", "required": true, "help": "Markdown or image file to share" }],
            "flags": [
                { "long": "--update", "type": "boolean", "help": "Force update existing share (default if already shared)" },
                { "long": "--copy-link", "type": "boolean", "help": "Print previously-shared URL instead of re-publishing" },
                { "long": "--unshare", "type": "boolean", "help": "Remove share for this file" }
            ],
            "requires_tab_context": true
        }]
    })).expect("share cli stub");
    let insights = serde_json::from_value(serde_json::json!({
        "id": "reading-insights", "name": "Reading Insights", "version": "core", "binary": "",
        "host_capabilities": [],
        "cli": [{
            "subcommand": "report", "command": "report",
            "summary": "Generate a reading engagement report (owner + online audience) from the Vault",
            "args": [],
            "flags": [
                { "long": "--vault", "type": "string", "help": "Vault root (defaults to the configured Vault)" },
                { "long": "--date", "type": "string", "help": "today | yesterday (default) | 7d | 30d | month" },
                { "long": "--from", "type": "string", "help": "YYYY-MM-DD (with --to, overrides --date)" },
                { "long": "--to", "type": "string", "help": "YYYY-MM-DD" },
                { "long": "--stdout", "type": "boolean", "help": "Print to stdout instead of writing <vault>/stat/*.md" }
            ]
        }]
    })).expect("insights cli stub");
    vec![share, insights]
}
```

`current_scan` 返回前把 stubs 追加进 manifests 向量（PathBuf 用 `PathBuf::new()`）。注意 stub 不进 enabled map——`unwrap_or(true)` 语义天然启用。

- [ ] **Step 3: router reading-insights 块去门**

router.rs:96-119 的 `let is_enabled = ...; return if is_enabled {...} else { Route::Disabled {...} }` 简化为无条件 `Route::Plugin(...)`（注释同步改为 core-ized 说明）。

- [ ] **Step 4: 跑 Rust 测试** — Run: `cargo test --manifest-path src-tauri/Cargo.toml` → PASS。

- [ ] **Step 5: CliRunner share 前置分流**

`CliRunner.svelte` 在 reading-insights 分流（`if (payload.plugin_id === 'reading-insights')`）之后追加 share 分流，将现有生态路径中 share 相关逻辑（bakeShareHtml 分支、prepareShareSrc 前置块、diagnostics）迁入：

```ts
    // share 是 core：走 TS 实现，无插件二进制。复用与菜单一致的
    // vault-home 前置与 bake 流程；结果以 cli.result 形状输出。
    if (payload.plugin_id === 'share') {
      await runShareCli(payload)
      return
    }
```

新增 `async function runShareCli(payload: CliPayload)`（同文件内）：复制既有 virtualTab 构建段（stat/读文件/推断 kind），然后按 `payload.plugin_command` 分派：

```ts
    if (payload.plugin_command === 'copy-link') {
      const { copyShareLink } = await import('../share/copy-link')
      const url = await copyShareLink(payload.file!)
      await clipWriteText(url)
      await finish({ exit_code: 0, stdout: [payload.global.json ? JSON.stringify({ url }) : url] })
      return
    }
    if (payload.plugin_command === 'unpublish') {
      const { unpublish } = await import('../share/unpublish')
      const cfg = shareCliConfig()   // 见下
      if (!cfg) { await finish({ exit_code: 1, stderr: ['notemd: share not configured (baseUrl/apiKey)'] }); return }
      await unpublish({ path: payload.file!, baseUrl: cfg.baseUrl })
      await finish({ exit_code: 0, stdout: ['unshared'] })
      return
    }
    // publish：refreshSotvault → prepareShareSrc（含 diagnostics 失败输出，原块迁移）
    // → bakeShareHtml(virtualTab, themeId) → publishHtml({ ..., src }) → 输出 url
```

`shareCliConfig()` 复制 `src/lib/share/index.ts` 的 `getShareConfig`（或将其 export 后复用——优先 export 复用，避免复制）。错误统一 catch：ShareError → `notemd: share failed: <kind>` + exit 1。随后删除生态路径中 `manifest.id === 'share'` 的两处特例（bake 分支与 pre-step 块）与 `shareVaultDiagnostics` 若仅 share 使用则随迁。

- [ ] **Step 6: 前端校验** — Run: `pnpm check && pnpm vitest run` → PASS。

- [ ] **Step 7: CLI 冒烟（真机）**

Run: `pnpm tauri build` 后用 debug 二进制或 dev CLI：`notemd share /tmp/test.md --copy-link`（未配置时应有清晰报错而非 panic）；`notemd reading-insights report --stdout`。
Expected: 行为与 v6.716.x 一致。

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/cli/runner.rs src-tauri/src/cli/router.rs src/lib/cli/CliRunner.svelte src/lib/share/index.ts
git commit -m "feat(core): CLI share/report run as core commands via stubs; share CLI uses TS implementation"
```

---

### Task 7: 删除六个 manifest 目录与 mdshare 产物 + 全量回归

**Files:**
- Delete: `src-tauri/plugins/{sotvault,outline-notes,folder-view,share,git-history,reading-insights}/`（share 含两个 bin）
- Modify: 受影响测试（跑完才知道的兜底步骤）

- [ ] **Step 1: 删目录**

```bash
git rm -r src-tauri/plugins/sotvault src-tauri/plugins/outline-notes src-tauri/plugins/folder-view src-tauri/plugins/share src-tauri/plugins/git-history src-tauri/plugins/reading-insights
```

- [ ] **Step 2: 全量回归**

Run: `pnpm check && pnpm vitest run && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS。若有测试引用被删 manifest（fixture 路径类），按"改引用到仍存在的 md2pdf/base manifest"修复，不得恢复被删目录。

- [ ] **Step 3: 验收 grep**

```bash
grep -n "sotvault'" src/App.svelte           # 期望：dispatchPlugin 中无 sotvault 分支
grep -rn "share" src/App.svelte | grep -i "bake\|prepareShare"   # 期望：无输出
ls src-tauri/plugins/                        # 期望：README.md base folder... 只剩 md2pdf roam-import openclaw-chat base placeholder
```

（注意 `plugins.enabled` 里六个 id 的历史残值无需清理——manifest 消失后判定路径不再读取。）

- [ ] **Step 4: Commit**

```bash
git add -u src-tauri/plugins/ && git add <修复的测试文件>
git commit -m "feat(core): remove six core-ized plugin manifests and mdshare binaries"
```

---

### Task 8: spec 回写偏离 + 收尾提交

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-plugin-system-v2-design.md` §9 share 行

- [ ] **Step 1: 更新 spec §9 share 行**

`| share | 删 manifest + 删 bin；**mdshare crate 编译进 src-tauri**（依赖仅 ureq/serde/time/rand）；...` 改为：

```
| share | 删 manifest + 删 bin；**桌面/CLI 切换到 src/lib/share 既有 TS 实现（iOS 同源），mdshare crate 与二进制整体退役**（实施勘查修订，优于原"编译进 src-tauri"方案：消除双实现）；菜单/右键/设置页/CLI `share` 全部内化；`share_db.json` 与 vault-homing 前置保持现状（已是 core 语义） |
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-07-16-plugin-system-v2-design.md
git commit -m "docs(specs): record share TS-path deviation in plugin v2 spec §9"
```

---

### Task 9: dev 实机验证（用户执行）→ 发布

GUI/菜单改动，按项目惯例**必须先 dev 实机验证、由用户手测**，不得直接发布。

- [ ] **Step 1: 起 dev 构建**

Run: `pnpm tauri dev`（保持运行，交给用户）。

- [ ] **Step 2: 提供手测清单（用户执行）**

1. File 菜单：可见 Sync to Vault…（无 vault 文件置灰）/ Share Current File…（Cmd+Shift+L）/ Unshare / Copy Share Link（未分享文件后两项置灰）；分享一个 vault 内 md → toast + 剪贴板有 URL；vault 外 md 分享 → 先落 vault 再发布。
2. View 菜单：Folder View（Cmd+Shift+E）/ Sidecar Notes View（Cmd+Shift+O）/ History View（Cmd+Shift+Y，非 vault 文件置灰）三个 toggle 正常开合侧栏。
3. tab 右键 → "分享此标签页…" 可用；空文件置灰。
4. 设置 → 插件页只剩 md2pdf / roam-import / openclaw-chat / base；Share 设置独立成 tab，四字段读写正常（改 baseUrl 保存后重开对话框仍在）。
5. 切中文/日文界面：新菜单项与 Share 设置 tab 标签本地化正确。
6. CLI：`notemd share <vault内md>` 出 URL；`notemd reading-insights report --stdout` 出报告；`notemd plugin list` 不再列六个 core 项。
7. 阅读一篇 vault 文档 1 分钟 → 阅读洞察窗口（View ▸ Reading Insights…）有当日数据（tracker 无插件门后仍工作）。

- [ ] **Step 3: 验证通过后发布**

按既有流程：独立 release worktree + `scripts/release.sh`（版本号按日期规则自动推导）。发布产物照常双架构 dmg。

---

## Self-Review 记录

- **Spec 覆盖**：§9 六行逐一映射——sotvault(T1/T2/T3/T7)、outline-notes/folder-view/git-history(T1/T2/T3/T7)、share(T1/T2/T4/T5/T6/T7/T8)、reading-insights(T3/T6/T7；菜单本就是 core 的 open-insights，无需迁移)；"退出插件设置页与 plugins.enabled 判定"由 manifest 删除自然达成（T7 验证）。
- **占位符**：无 TBD；Task 6 Step 5 的 publish 分支以流程注释表达（bake/publishHtml 签名均在文中给出，virtualTab 构建段明确为"复制既有段"且指明位置）。
- **类型一致性**：CORE_MENU_ENABLED_ITEMS 用 CollectedItem 既有类型；CommandId 四个新增值与 Rust 菜单 id 逐字一致（sync-to-vault/toggle-folder-view/toggle-sidecar-notes/toggle-git-history）；share/unshare/copy-share-link 复用既有 CommandId。
