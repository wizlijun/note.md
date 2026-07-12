# 历史行布局 + 预览单窗多 tab 设计

日期：2026-07-12

## 目标

对刚发布的 git-history 预览功能做两处改进：

1. **历史行布局**：每个历史项以**时间 + 作者**为主信息醒目显示，提交备注/短 hash 等降为次要信息。
2. **预览窗口合并**：把"每个版本+类型开一个独立原生窗口"改为**一个 `preview` 窗口 + 顶部 tab 栏**，可 tab 切换/关闭。

## 已确认的决策

- 时间格式：本地**绝对日期时间** `yyyy-MM-dd HH:mm`（如 `2026-07-12 17:36`）。auto-sync 提交多，绝对时间比相对时间更有用。
- 单窗内 tab：同一「版本+类型」（如 `diff-abc123`）**复用已有 tab 并激活**，不重复；不同版本/类型开新 tab；每个 tab 可单独关闭；**关掉最后一个 tab 时自动关窗**。

## 功能 1：历史行布局

`src/components/history/HistoryPanel.svelte` 的 commit 行，从当前：
- 主：`{c.subject}`（13px）
- 次：`{c.short} · {relTime(c.timestamp)} · {c.author}`（11px，灰）

改为：
- **主行**：`{formatDateTime(c.timestamp)} · {c.author}`（醒目：13px、正常/半粗）
- **次行**：`{c.subject} · {c.short}`（11px、opacity 0.6）

新增纯函数 `formatDateTime(ts: number): string` → 本地 `yyyy-MM-dd HH:mm`，放进 `src/lib/git-history/applies.ts`（无 runes/tauri 依赖，可单测）。

`relTime` 目前仅在此处使用；改造后不再引用，**连同其单测一并删除**（若 grep 确认无其它引用）。

CSS：现有 `.subject`/`.meta` 类改名/调整为 `.primary`/`.secondary`（primary 全不透明、secondary 灰）。

## 功能 2：预览单窗多 tab

### Rust (`src-tauri/src/preview_window/mod.rs`)

- 单窗固定 label 常量 `PREVIEW_LABEL = "preview"`。
- 状态复用 `PreviewStore(Mutex<HashMap<String, PreviewPayload>>)`，键从"窗口 label"改为 **tabId**（`diff-<short>` / `rich-<short>` / `cmp-<short>`）。`PreviewPayload` 增加 `id` 字段（或 drain 时带上 key）——采用返回 `PreviewTab { id, title, kind, content }`。
- 命令 `open_preview_tab(app, tab_id, title, kind, content) -> Result<(),String>`：
  1. stash：`payloads.insert(tab_id, {title,kind,content})`。
  2. 确保单窗存在：`get_webview_window("preview")` 有则 `show/unminimize/set_focus`，无则 `WebviewWindowBuilder`（title "Preview"，760×680，min 420×320，resizable，decorations，visible(false) 后 show+focus）。
  3. `emit("preview-add-tab", ())`（窗口收到后 drain）。
- 命令 `drain_preview_tabs(app) -> Result<Vec<PreviewTab>, String>`：把当前 `payloads` 全部取出并清空，返回 `Vec<PreviewTab{id,title,kind,content}>`。未消费的 payload 即"待打开的 tab"，省掉单独队列。
- 移除旧的 `open_preview_window` / `take_preview_payload`（被上面两个取代）。纯 helper（stash/drain over `&mut HashMap`）保留并单测。

### 前端 `src/preview-app.svelte`（tab 容器）

- 从 `../lib/git-history/preview-tabs` import `PreviewTab` 接口与 `upsertTab`（不在组件内另定义类型）。
- `let tabs = $state<PreviewTab[]>([])`，`let activeId = $state<string | null>(null)`。
- `drainTabs()`：`invoke<PreviewTab[]>('drain_preview_tabs')` → 对每个结果调纯函数 `upsertTab`（见下）合并进 `tabs` 并把 `activeId` 设为最新加入/激活的那个；随后 `setTitle` 为 active tab 标题。
- `$effect` 挂载：`drainTabs()`；注册 `listen('preview-add-tab', drainTabs)`；listener promise resolve 后再 `drainTabs()` 一次（沿用竞态兜底）；cleanup unlisten。
- 顶部 tab 栏：每个 tab 显示截断标题 + × 关闭按钮；点 tab 切 `activeId`；× 调 `closeTab(id)` 从 `tabs` 移除（若移除后为空 → `getCurrentWindow().close()`，否则激活相邻 tab）。
- tab 内容区按 active tab 的 kind 渲染：`'diff'` → `<DiffView content={active.content} />`；`'rich'` → `<iframe srcdoc={active.content} sandbox="allow-same-origin">`。
- 空状态（drain 后仍无 tab，例如 payload 已被取走）：显示占位提示。
- 独立窗口配色：保留 `:global(:root){ color-scheme: light dark; }`。

### 纯函数 `upsertTab`

放进新文件 `src/lib/git-history/preview-tabs.ts`（可单测，无 runes）。同一个 `PreviewTab` 接口在此定义并被 `preview-app.svelte` 复用（不要两处各定义一份）：
```ts
export interface PreviewTab { id: string; title: string; kind: 'diff' | 'rich'; content: string }
/** 合并一个 tab：若 id 已存在则原地更新内容/标题，否则追加；返回新数组 + 应激活的 id。 */
export function upsertTab(tabs: PreviewTab[], tab: PreviewTab): { tabs: PreviewTab[]; activeId: string }
```

### 前端 `src/lib/git-history/preview.ts`

- 私有 `open(tabId, title, kind, content)` → `invoke('open_preview_tab', { tabId, title, kind, content })`。
- `openDiffPreview(short,title,diff)` → tabId `diff-${short}`；`openComparePreview` → `cmp-${short}`；`openRichPreview` → `rich-${short}`（rich 仍在主窗口 `renderTabAsInlineBody`+`wrapPrintHtml` 生成 HTML 后传入）。

### capabilities

`src-tauri/capabilities/default.json` 的 `windows`：把 `"preview-*"` 改为单个 `"preview"`。

## 错误处理

- 主窗口 git 命令失败 → `pushToast`（沿用现有 catch）。
- drain 拿到空且 tabs 为空 → 预览窗显示占位提示，不崩。
- 关最后一个 tab → 关窗。

## 测试策略

- **Rust 单测**：stash → drain（返回全部并清空）、多次 drain（第二次空）、drain 保序/去重由前端负责。
- **前端单测**：`formatDateTime`（固定时间戳→字符串）、`upsertTab`（新增、同 id 更新+激活、激活 id 正确）。
- **GUI 实机验证**：历史行新布局；预览/diff/对比进入同一窗口的不同 tab；同版本同类型复用 tab；切换/关闭 tab；关最后一个 tab 关窗；深浅色。

## 非目标（YAGNI）

- 不做 tab 拖拽重排、tab 持久化。
- 不做窗口尺寸记忆。
- 恢复动作不变（仍写编辑缓冲、不开窗/ tab）。
- 历史行不加头像、不加相对时间副标（只用绝对时间）。
