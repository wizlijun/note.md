# 统一日志查看器设计（unified log viewer）

日期：2026-07-21
分支：feat/attention-intervals（或新开 feat/log-viewer）

## 0. 目标

给 app 一个**集中的日志查看入口**：一个独立窗口 `logs.html`，把后端主进程、前端 webview、git sync、各插件的日志汇入**单一环形缓冲**，同时做三件事：

1. 落地日志文件 `logs/app.log`
2. 实时推给「查看日志」窗口（`log://line`）
3. 窗口打开时回放历史快照（`logs_get_snapshot`）

日志按**双维度**组织：`source`（backend/frontend）+ `category`（core / git-sync / plugin:`<id>` / frontend）。tray 现有「查看日志…」入口改为打开该窗口并预置 category=git-sync 过滤。

参考方案：本次基于一份成熟的 tauri log-bus 方案移植，**唯一实质扩展是增加 `category` 字段**用于功能模块分类。

## 1. 决策记录

| 维度 | 决策 | 理由 |
|---|---|---|
| 界面形态 | 独立窗口 `logs.html`（仿 insights/preview/plugin-market） | 日志是运维视角，独立窗口不干扰编辑、可长期挂着看实时流 |
| 分类 | 双维 `source` + `category` | git sync 要作为一个关键核心功能标签，插件各自一类 |
| 存量 | 只接新日志，不回填历史；不动 git sync 现有 `LogBuffer` 和 tray 状态机 | 低风险，不回归 tray 状态机 |
| git sync 新日志 | emit 一份进总线打 category=git-sync | tray 过滤入口能看到实时/近期日志 |
| 转换范围 | 关键路径优先 | 平衡工作量与价值 |
| View 菜单 | 加通用「查看日志…」入口（不过滤） | 常规发现入口 |
| dlog | 保留 /tmp/mdeditor.log 写入 **且** 同时进总线 | 不破坏现有 dev 排障习惯 |

## 2. 数据契约（Rust ↔ 前端逐字对齐）

`LogLine`（Rust `#[derive(Serialize)]` snake_case ↔ 前端 interface）：

```
ts:       string   // RFC3339 毫秒 UTC，例 2026-07-21T08:12:33.456Z
source:   string   // "backend" | "frontend"
category: string   // "core" | "git-sync" | "plugin:<id>" | "frontend"
level:    string   // "debug" | "info" | "warn" | "error"
message:  string
```

`category` 是本方案相对参考的唯一新增字段。约定值：

- `core` — 后端核心（默认，`log_info!` 等无 category 变体）
- `git-sync` — vault_sync 相关
- `plugin:<publisher.name>` — 具体插件（复用插件 id）
- `frontend` — 前端 console 桥接（`logs_append_frontend` 固定写此值）

## 3. Rust 后端 `src-tauri/src/log_bus.rs`

全局单例总线（`OnceLock<LogBus>`），持有三样：

- `buffer: Mutex<VecDeque<LogLine>>` — 环形缓冲，`MAX_LINES = 3000`
- `app: OnceLock<AppHandle>` — 实时 emit
- `file: Mutex<Option<File>>` — 落地文件句柄

`record(line)` 是唯一写入路径，做三件事：

1. push 进 buffer，超出 `MAX_LINES` 从头 `pop_front`
2. 文件已打开则 `writeln!` 格式 `{ts} [{source}/{category}/{level}] {message}`
3. AppHandle 已绑定则 `app.emit("log://line", &line)`

接入函数：

- `push(level, msg)` → `push_cat("core", "backend", level, msg)`
- `push_cat(category, source, level, msg)`：先 `eprintln!("[{category}] {msg}")` 镜像到 stderr（dev 期 cargo run 控制台仍可见），再 `record(...)`
- `snapshot() -> Vec<LogLine>` / `clear()`

三个 Tauri commands：

- `logs_append_frontend(level, message)` — source=frontend，category=frontend，level 非法值兜底 "info"
- `logs_get_snapshot() -> Vec<LogLine>` — 返回 buffer 克隆
- `logs_clear()` — 只清缓冲，不截断已落地文件

宏（`#[macro_export]`，签名同 `format!`）：

- `log_info! / log_warn! / log_error!` → category 默认 `"core"`, source `"backend"`
- `log_cat!(category, level_str, ...)` → 供 git-sync / 插件带 category 打点（level 传字符串字面量）

`init(app)`（Tauri setup 内**最先**调用，才能捕获启动日志）：

1. 绑定 AppHandle
2. 建 `app_data_dir/logs/` 目录
3. append 打开 `logs/app.log`，存入 file 槽

### 3.1 接入点（关键路径优先）

- **核心（category=core）**：`lib.rs` 的 `dlog` 保留原 /tmp 写入行为，内部**追加**一次 `log_bus::push`（即 dlog 双写：/tmp + 总线）。启动/单实例/open-file/窗口生命周期等经 dlog 的点自然进总线。此外把 sotvault、plugin_host 的关键错误 `eprintln!` 换成 `log_error!`。
- **git-sync（category=git-sync）**：在 `vault_sync` 现有 push 日志处**追加** `log_cat!("git-sync", ...)`。原 `LogBuffer`、tray 状态机、`vault_sync_logs` command **一行不改**。
- **插件（category=plugin:<id>）**：`plugin_runtime/process.rs` 的 `append_plugin_log` 里**追加** record（source=backend，category=`plugin:<id>`，level 透传）。原 `<plugin_id>.log` 文件照写照滚动。

> 关键路径以外的零散 println! 不强制转换，后续自然迸发时再加宏。

### 3.2 单元测试（`log_bus.rs` #[cfg(test)]）

- 缓冲累积到 `MAX_LINES + N` 后 `snapshot().len() == MAX_LINES`，末尾是最新
- `clear()` 后 snapshot 为空
- category 透传（`push_cat` 写入的 category 原样回读）
- `logs_append_frontend` 非法 level 兜底 "info"，category 恒为 "frontend"

## 4. Tauri 接线（`src-tauri/src/lib.rs`）

- setup 内**第一件事**：`log_bus::init(app.handle().clone())`（早于其它子系统）
- `invoke_handler` 注册：`logs_append_frontend / logs_get_snapshot / logs_clear`
- 新增 `open_logs_window(app, filter: Option<&str>)`：仿 `show_insights_window` 建/复用 label=`logs` 窗口，加载 `logs.html`；若带 filter，窗口就绪后 `emit("nav://logs-filter", filter)`
- **tray「查看日志…」（`tray-sync-log`）**：从原「生成 vault-sync.log 塞编辑器」改为 `open_logs_window(app, Some("git-sync"))`。删除/停用旧 `open_sync_log_window`（保留函数体亦可，先不删源码以降风险，仅改 tray 分支调用）。
- **View 菜单**：在 Insights/Plugin Market 附近加「查看日志…」（menu id `open-logs`）→ `open_logs_window(app, None)`
- capabilities：`logs` 窗口加入 `capabilities/default.json` 的 windows allowlist（见记忆 capabilities_window_allowlist 坑），否则后端命令被静默拒绝

## 5. 前端（Svelte 5 runes）

### 5.1 窗口入口

- 新文件：`logs.html`、`src/logs-main.ts`、`src/logs-app.svelte`
- `vite.config.ts`：rollupOptions.input 加 `logs: 'logs.html'`；optimizeDeps.entries 加 `'logs.html'`
- `logs.html`/`logs-app.svelte` 自声明 `color-scheme: light dark`（独立窗口系统色坑，见记忆 webview_color_scheme）

### 5.2 平台层 `src/lib/logs/`

`console-bridge.ts`：

```ts
export interface LogLine { ts: string; source: string; category: string; level: string; message: string }
export function installConsoleBridge(): void  // 幂等
```

- patch `console.debug/info/log/warn/error` → `invoke("logs_append_frontend", {level, message})`
- **硬约束**：先调原生 console，再上报；上报 `.catch(() => {})` 静默（否则前端报错经桥接再触发上报 → 无限回环）
- 在主窗口 `main.ts` 启动时装一次

`logs-store.svelte.ts`（Svelte 5 runes，非 React hook）：

- `$state` lines
- 构造时 `invoke("logs_get_snapshot")` 回放
- `listen("log://line", e => append(e.payload))`，前端也 cap 3000
- `listen("nav://logs-filter", e => categoryFilter = e.payload)`
- `clear()`：清本地 + `invoke("logs_clear")`

### 5.3 `logs-app.svelte` UI

- **三层筛选下拉**：source（all/backend/frontend）+ **category**（all/core/git-sync/plugin/frontend，plugin 归并显示）+ level（all/debug/info/warn/error）+ 关键字搜索框（match message）
- autoScroll 复选框，勾选时新行 `scrollIntoView({ block: "end" })`
- clear 按钮
- 每行：ts（灰）+ `[category]`（着色）+ `[source]` + level（着色）+ message（`white-space: pre-wrap; word-break: break-all`）
- 着色：level → error 红 / warn 琥珀 / debug 灰 / info 中性；category → git-sync 蓝 / plugin 紫 / core 绿 / frontend 青
- 等宽字体、深色底
- 空集 → "暂无日志"

## 6. i18n（en/zh 同步，样例文档/keywords 不译，见记忆 i18n_system）

- `nav.logs`
- `logs.{title,source,category,level,search,autoScroll,clear,empty}`
- `logs.categories.{all,core,gitSync,plugin,frontend}`
- `logs.sources.{all,backend,frontend}`
- `logs.levels.{all,debug,info,warn,error}`
- tray 复用现有 `tray.viewLog`；View 菜单新增 `view.logs`（在 native 菜单 catalog `menu_label` 里加四语条目）

## 7. 前端测试

- `logs-store` 追加 cap 3000（push 3001 条只留 3000，末尾最新）
- `console-bridge` 幂等（装两次只 patch 一次）& 不回环（mock invoke，上报抛错不再触发上报）

## 8. GUI 实机验证（不做 UI 自动化，见记忆 no_ui_automation_user_tests / dev_gui_verification）

给用户手动步骤：dev 构建 → View▸查看日志 打开窗口 → 触发一次 git sync → 观察 category=git-sync 行 → tray「查看日志…」点开确认预置 git-sync 过滤 → 前端 console.warn 一条确认 frontend 行出现 → clear 后再 emit 确认实时流。

## 9. 移植检查清单

- [ ] 事件名 `log://line`、`nav://logs-filter` 与 command 名 `logs_append_frontend`/`logs_get_snapshot`/`logs_clear` 三处（Rust `#[tauri::command]`、lib.rs 注册、前端 invoke/listen）逐字一致
- [ ] `MAX_LINES = 3000` Rust 与前端两处相同
- [ ] `log_bus::init` 在 setup 最前
- [ ] console 桥接：先原生后上报 + 失败静默
- [ ] `logs_clear` 只清缓冲不删文件
- [ ] `LogLine` 五字段两端命名对齐（snake_case）
- [ ] `logs` 窗口进 capabilities allowlist
- [ ] `logs.html` 进 vite input + optimizeDeps.entries
- [ ] 独立窗口声明 color-scheme
- [ ] git sync / 插件接入是**追加** record，不删原有 LogBuffer / .log 文件逻辑
