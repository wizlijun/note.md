# Daily Notes（每日笔记）— 设计文档

日期：2026-07-23
分支：feat/decision-log（将另起 feature 分支实现）

## 1. 背景与目标

现在 tray 菜单里有内置的「今天的日记」项（`tray-today-note`），点击后在**主编辑器**里创建/打开今天的 `vault/{dailynoteDir}/{yyyy}/{yyyy-MM-dd}.note.md`（不弹窗）。

目标：把每日日记升级为一个 Roam Daily Notes 式的**独立、单实例窗口**，让日记常驻在主窗口之外。窗口里连续渲染多天的 `.note.md` 大纲笔记、可上下滚动懒加载切换日期，空白日直接给空大纲即可书写；并能顺着双链在任意大纲笔记间穿梭。整个能力由一个**设置开关**控制启停。

### 关键约束（决定架构）

1. **大纲编辑器无法搬进隔离插件。** `OutlineEditor.svelte`（859 行）深度耦合主程序约 30 个内部模块（tabs / outline stores / sotvault / i18n / backlinks / @moraya/core）。隔离 webview 插件不能 import 主程序，只能走 `window.notemd` 桥读写 vault。→ **Daily Notes 必须作为核心功能**（加载主前端 bundle 的二级窗口），不是市场插件；用一个设置开关代替「插件安装/启用」。

2. **outline store 是全局单例。** `src/lib/outline/store.svelte.ts` 的 `export const outline = $state<OutlineState>({...})` 是模块级单例，只装一份文档的树；OutlineEditor 及其全部子组件直接读它。→ **不能让 N 天各挂一个全功能 OutlineEditor 同时可编辑**。采用「聚焦即激活的单活编辑器」方案（见 §4），不重构该单例。

## 2. 总体架构

与 insights / preview / logs / plugin-market 二级窗口同构：

| 部件 | 文件 |
| --- | --- |
| HTML 入口 | `daily-notes.html` |
| JS 入口 | `src/daily-notes-main.ts`（`mount(DailyNotesApp, …)`) |
| 根组件 | `src/daily-notes-app.svelte`（bootstrap + 布局） |
| 视图组件 | `src/components/daily/DailyFeed.svelte`、`DailyDay.svelte`、`DailyToolbar.svelte`、`DailyPage.svelte` |
| 后端窗口 | `show_daily_notes_window()`（Rust，`get_webview_window("daily-notes").or_else(build)` 保证单实例） |
| Vite 输入 | `vite.config.*` 的 `rollupOptions.input` + `optimizeDeps.entries` 追加 `dailyNotes: 'daily-notes.html'` |
| capabilities | `capabilities/default.json` 的 `windows` 追加 `"daily-notes"`（否则后端命令被静默拒绝） |
| 深浅色 | 根组件自声明 `:global(:root){ color-scheme: light dark }`（WKWebView 系统色否则钉浅色） |

**Bootstrap（同 insights-app）**：`onMount` 中 `await loadSettings(); await loadLocale(); await loadOutlineDirs(); await refreshSotvault();` 设窗口标题，未配置 vault 时给提示。

窗口是主前端 bundle 的一部分，故可**直接 import 并复用** `OutlineEditor.svelte` 及 `src/lib/outline/*` 全套。

## 3. 数据模型（复用现成）

- 某天路径：`dailyNotePath(vaultRoot, outlineDirs.dailynote, 'yyyy-MM-dd')` → `vault/{dailynoteDir}/{yyyy}/{yyyy-MM-dd}.note.md`。
- 今天：`todayStr()`。
- 空白日按意图落盘：复用 `ensureDailyNote` 的语义——**不写就不建文件**（聚焦并输入才落盘），与 `project_outline_intent_save` 一致。
- 双链解析：`parseDateLink` 区分 day/month/year。

## 4. 日记流：滚动懒加载 + 聚焦即激活（方案 A）

`DailyFeed.svelte` 维护一个连续日期区块列表（初始锚定今天，向上是更早、向下是更晚）。

- **懒加载**：`IntersectionObserver` 观察顶/底哨兵；触顶向上追加更早日期、触底向下追加更晚日期。每个区块 `DailyDay.svelte` 只在进入视口附近时才读盘拉取该天 `.note.md`（不存在 → 空树）。
- **单活编辑器**：任一时刻只有**获得焦点的那一天**渲染完整 `OutlineEditor`（绑定全局单例、全功能编辑）；其余天用**轻量只读大纲渲染**（一个递归 Svelte 组件把该天的树渲成静态 bullets，含双链 pill，可点击）。
- **激活/降级**：点击或键盘进入某天 → 冲刷当前活跃天（`serializeDoc` + 落盘 / markSynced，遵循 hash 冲突校验），`detach()` 后对新天 `attachDoc()`，该天变活、旧天降级回只读。
- **空白日**：只读渲染显示占位空大纲；聚焦即变活，输入后按 `ensureDailyNote` 意图落盘。

> 取舍：任一时刻只有一天真正 inline 可编辑（聚焦即激活），换取不动 outline 全局单例、风险可控。用户已确认采用此方案（A）。

## 5. 双链 / 链接路由

窗口内点击拦截（capture 阶段，参考 `reference_moraya_link_click` 的反转手法）：

- **双链 `[[yyyy-MM-dd]]`（日期）**：切到日记流视图并滚动/定位到那一天（不存在也定位到空白日）。
- **双链 `[[普通页面]]`（非日期）**：切到**单页视图** `DailyPage.svelte`，用完整 OutlineEditor 打开该页对应 `.note.md`（单文档，与全局单例天然兼容）。落点解析复用 backlinks 的 `openPageOrCreate` / `pageNameOf`。
- **普通 .md 文件链接**：调用**主 md 编辑窗口**打开——`invoke('editor_show_and_open_path', { path })`（后端 emit `editor://open-path`，主窗口 `App.svelte` 已监听）。
- **外部 http(s) 链接**：`@tauri-apps/plugin-opener` 的 `openUrl` 交给**系统浏览器**。

## 6. 工具栏 `DailyToolbar.svelte`

从左到右：

1. **上一个 / 下一个**：浏览器式导航历史栈。窗口内每次跳转（日记流某天 ↔ 单页某笔记）压栈；上一个/下一个在栈里前后移动并恢复对应视图与滚动位置。
2. **刷新**：`refreshSotvault()` + 重建可见区块（丢弃缓存重新读盘），用于外部（同步/CLI/Obsidian）改动后手动刷新。
3. **日历跳转**：日期选择器；选中 → 切到日记流并定位到那天。
4. **查找过滤**：按内容过滤日记流——命中的天高亮命中片段，非命中天折叠/隐藏（可切「只显含命中的天」）。查找作用于已加载区块 + 触发按需加载扫描（范围与性能细节留待 plan）。

## 7. 开关 + tray 接线 + 命名统一

### 7.1 设置开关
`settings` $state 增加 `dailyNotes: { enabled: boolean }`（默认 `false`，保持现状不惊扰老用户），随 `loadSettings/saveSettings` 持久化。Settings UI 增一行开关「每日笔记 / Daily Notes」。

### 7.2 tray 行为（`build_tray_menu` / 事件处理）
- 开关 **开**：tray 显示「Daily Notes」（中文 **每日笔记**）项 → 点击 `show_daily_notes_window()`；**移除内置「今天的日记」项**。
- 开关 **关**：保留内置「今天的日记」项（现状行为），不显示 Daily Notes 项。
- 开关状态需能被 Rust 侧 `build_tray_menu` 读到：随开关变更 emit 事件触发 `rebuild_menu`/`apply_menu_locale` 重建 tray（参考现有 `plugins-changed` → 菜单重建链路）；开关值经由已有的前端→后端设置通道或一个轻量 `set_daily_notes_enabled` 命令落到一处 Rust 可读的状态。

### 7.3 命名统一 today-note → daily-note
全部内部标识改名（用户明确要求「全部统一为 daily-note」）：
- Rust：tray id `tray-today-note` → `tray-daily-note`；emit 的事件名同改；i18n key `tray.todayNote` → `tray.dailyNote`。
- 前端：`App.svelte` 的 `listen('tray-today-note', …)` → `'tray-daily-note'`；相关变量/注释里的 today-note 命名统一。
- `src/lib/outline/daily.ts` 及其调用点涉及 today-note 的命名统一为 daily-note（`todayStr`/`ensureDailyNote` 等函数名保留，语义未变；仅去除 today-note 字样的 id/事件/键）。

> 注：内置项在开关关时点击仍走「主编辑器打开今天」的旧行为；只是 id/事件/键改名为 daily-note。

## 8. i18n

新增键：`daily.windowTitle`、`daily.toolbar.prev/next/refresh/calendar/find`、`daily.needsVault`、`daily.emptyDay` 等；`tray.dailyNote`（内置项）与 tray 「每日笔记」项标签；Settings 开关标签 `settings.dailyNotes.*`。en.ts 扁平点分键 + zh 覆盖（见 `reference_i18n_system`）。

## 9. 错误处理

- 未配置 vault：窗口显示提示（同 insights.needsVault），工具栏禁用。
- 读盘失败的天：该天区块显示错误占位，不阻塞其余天。
- 写盘 hash 冲突：沿用 OutlineEditor 现有冲突校验（`noteDiskHash` 基线），冲突时提示不覆盖。
- 单活切换时旧天冲刷失败：保留在内存、toast 报错，不静默丢数据（遵循 `outline_store_singleton_wipe_guard`：绝不用空序列化盖非空 note）。

## 10. 测试

- 纯逻辑单测（vitest）：日期区块序列生成/懒加载游标推进、双链路由分类（date / page / .md / external）、查找过滤命中判定、导航历史栈前进后退。
- IO 薄层（读写盘、窗口创建）按仓库惯例不做单测；GUI 回归走 dev 实机验证（`reference_dev_gui_verification`，注意 `feedback_gui_verify_desktop_contention` 桌面争用）。

## 11. 明确不做（YAGNI）

- 不重构 outline 全局单例为 per-instance（方案 B 已否决）。
- 不做跨天的批量编辑/多天同时编辑。
- 不做日记模板、周期回顾、双链反向面板（本窗口内），保持首版聚焦「滚动日记流 + 双链穿梭 + 工具栏导航」。
- 不做历史数据迁移。
