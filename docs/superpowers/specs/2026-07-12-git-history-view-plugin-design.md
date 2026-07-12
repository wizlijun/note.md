# Git 历史视图插件设计

日期：2026-07-12

## 目标

为 mdeditor 新增一个**文件 Git 历史**插件，让用户在编辑 vault 内文件时，能在右侧面板查看该文件的 git 提交历史，并对任一历史版本执行 **查看 diff** 或 **恢复** 操作。插件默认关闭，用户在设置里手动加载才生效。

## 核心约束（已确认）

1. **面板关系**：历史视图是独立面板，独立启用/可见状态，与大纲视图**互斥**——打开一个自动收起另一个，二者共用右侧槽位。
2. **恢复语义**：写入当前编辑器缓冲区（变脏，不落盘），用户自行决定是否 Cmd+S。安全可反悔。
3. **diff 展示**：新开一个只读 tab 显示 commit 的统一 diff。
4. **生效范围**：仅当当前文件位于已配置的 vault 目录（git 仓库）之下时生效。

## 整体思路

镜像现有 `outline-notes` 插件的模式：builtin 插件 manifest + `gate.svelte.ts` 状态 store + 惰性加载的右侧面板组件 + View 菜单 `toggle` 命令。后端复用 `src-tauri/src/vault_sync/git_ops.rs` 的 `run_git()`。改动面小、与既有代码风格一致。

## 组件设计

### 1. 插件 manifest

新增 `src-tauri/plugins/git-history/manifest.json`：

- `id: "git-history"`，`kind: "builtin"`，`default_enabled: false`（用户手动加载才生效）
- `host_capabilities: []`
- 菜单：`location: "view"`，`command: "toggle"`，`shortcut: "Cmd+Shift+Y"`，`enabled_when: "vaultConfigured"`（未配置 vault 时置灰）
- i18n：zh / ja 提供 name、description、`menus.toggle`

菜单项通过 `plugin_host::collect_top_menu_items` 自动出现在 View 菜单（`lib.rs` 已按 `location == "view"` 过滤插件项，无需改 Rust 菜单构建）。

### 2. Gate store

新增 `src/lib/git-history/gate.svelte.ts`，镜像 `src/lib/outline/gate.svelte.ts`：

```
export const PLUGIN_ID = 'git-history'
export const historyGate = $state<{ enabled: boolean; visible: boolean; width: number }>(...)
export async function loadHistoryGate(): Promise<void>   // 从 settings.json 读 history.visible / history.width，enabled 来自 isPluginEnabled
export async function setHistoryVisible(v: boolean): Promise<void>
export function setHistoryWidthLive(w: number): void
export async function setHistoryWidth(w: number): Promise<void>
export function historyAppliesTo(tab, vaultRoot): boolean  // tab.filePath 位于 vaultRoot 之下
```

宽度范围与大纲一致（min 240 / max 640 / default 360）。持久化 key：`history.visible`、`history.width`。

判据 `historyAppliesTo`：复用 `sotvault-logic.ts` 的 `isUnder(path, vaultRoot)` 判断当前文件是否在 vault 仓库下。vaultRoot 来自 `sotvaultStore.vaultRoot`。

### 3. 后端命令

新增模块 `src-tauri/src/git_history/mod.rs`，复用 `vault_sync::git_ops::run_git`。三个 Tauri 命令：

- `git_file_log(repo: String, abs_path: String) -> Vec<GitCommit>`
  - 执行 `git log --follow --format=<%H|%h|%an|%at|%s，用 0x1f 分隔字段、0x1e 分隔记录> -- <rel_path>`
  - `rel_path` = abs_path 去掉 repo 前缀
  - `GitCommit { hash, short, author, timestamp (i64 unix), subject }`
  - git 不可用（`git_ops::version()` 为 None）时返回明确错误，前端转成空状态
- `git_file_show(repo: String, rev: String, abs_path: String) -> String`
  - 执行 `git show <rev> -- <rel_path>`，返回带 commit 头的完整 diff 文本
- `git_file_at(repo: String, rev: String, abs_path: String) -> String`
  - 执行 `git show <rev>:<rel_path>`，返回该版本文件内容

`rel_path` 用 forward slash。命令在 `lib.rs` 的 `invoke_handler` 注册。

### 4. 面板组件

新增 `src/components/history/HistoryPanel.svelte`，复刻 `OutlinePanel.svelte` 的头部与 splitter 结构：

- **顶部工具栏**：标题「历史」+ **刷新**按钮（重新拉 log）+ **隐藏**按钮（`setHistoryVisible(false)`）
- **左边缘 splitter**：拖拽调宽，实时 `setHistoryWidthLive`，松手 `setHistoryWidth` 持久化
- **commit 列表**：每行显示 短 hash / 提交信息(subject) / 相对时间 / 作者
- **点击某条 commit** → 该行展开两个内联操作按钮：
  - **查看 diff**：调 `git_file_show`，新开只读 code tab（标题如 `abc123 · file.md.diff`）
  - **恢复此版本**：调 `git_file_at` 取内容 → 写入当前 tab 的编辑缓冲区（`currentContent`，变脏）
- **空状态**：
  - 当前文件不在 vault 下 → 提示「当前文件不在 vault 中，无 git 历史」
  - git 不可用 → 提示「未检测到 git」
  - 有 vault 但该文件无提交记录 → 提示「暂无历史记录」

数据加载：面板挂载、活动 tab 变化、点刷新时调 `git_file_log`。commit 列表存组件本地 `$state`。

交互取舍：点击行内展开操作按钮（比右键上下文菜单更易发现），是推荐方案；不做右键菜单。

### 5. 接线（App.svelte）

- `dispatchPlugin` 加分支：
  ```
  if (pluginId === 'git-history' && command === 'toggle') {
    const next = !historyGate.visible
    await setHistoryVisible(next)
    if (next) await setOutlineVisible(false)   // 互斥
    return
  }
  ```
  同时在 outline 分支里：打开大纲时 `if (next) await setHistoryVisible(false)`。
- `.pane` 内在 OutlinePanel 旁惰性渲染 HistoryPanel，`showHistoryPanel` 派生守卫：
  `platformName !== 'ios' && historyGate.enabled && historyGate.visible && current?.filePath 在 vaultRoot 下`
- 启动时调 `loadHistoryGate()`（与 `loadOutlineGate()` 同时机）。
- float-toggle 右偏移量兼顾两个面板：`showHistoryPanel ? historyGate.width : showOutlinePanel ? outlineGate.width : 0`。

### 6. 只读 diff tab

diff 用一个临时只读 tab 承载：kind `code`，无 filePath（untitled），内容为 `git show` 输出。需在实现时确认 tab 数据结构是否支持只读标记；若无，则以 untitled code tab 呈现（用户即使误改也不影响真实文件）。

### 7. i18n

按现有自研 i18n 系统，在 `en.ts` 加 `history.*` 扁平点分键（面板标题、刷新、隐藏、diff、恢复、各空状态、恢复后的 toast），zh/ja partial 补对应翻译。

## 测试策略

- **Rust 单测**：在临时 git repo 里初始化几次提交，验证 `git_file_log` 解析、rel-path 计算、`git_file_at`/`git_file_show` 输出。
- **前端单测**：`historyAppliesTo`（在/不在 vault 下）、toggle 互斥逻辑。
- **GUI 实机验证**：属窗口/布局改动，按项目规矩做 dev 构建 + osascript 驱动 + 截图验证（面板显示/隐藏、与大纲互斥、diff tab、恢复变脏）。

## 非目标（YAGNI）

- 不做跨版本任意两点 diff（只做某 commit 相对上一版）。
- 不做直接写盘恢复（只写缓冲区）。
- 不做非 vault 的任意 git 仓库支持。
- 不做右键上下文菜单。
- 不做 blame / 图形化分支树。
