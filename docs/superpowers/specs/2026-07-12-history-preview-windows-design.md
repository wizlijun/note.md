# 历史版本预览：独立原生窗口设计

日期：2026-07-12

## 目标

给 git-history 插件的历史列表项增加"**预览**"（把某个历史版本的 markdown 用 **rich** 方式只读渲染），并把现有的 **diff** 和 **与当前对比** 从"只读 tab"改成**独立原生窗口**。三类展示（rich 预览 / diff / 与当前对比）统一走一个通用的原生"预览窗口"。**恢复**动作不变（仍写回编辑缓冲，不开窗）。

## 已确认的决策

1. **窗口形式**：独立原生 Tauri 窗口（像 roam/insights），不是应用内浮层。
2. **改造范围**：diff、与当前对比、rich 预览——三者全部用独立窗口；恢复仍写缓冲。
3. **窗口复用**：每个「版本 + 类型」一个窗口，同版本同类型复用并聚焦，不同版本开新窗，可并排对照。
4. **数据传递**：主窗口算好内容（diff 文本 / rich markdown），把字符串传给预览窗口；预览窗口是"哑"渲染器，不自己跑 git（因为"与当前对比"必须用主窗口的编辑缓冲，统一起来最简单）。

## 架构

### 组件划分

- **新增独立窗口 app**：`src/preview-app.svelte` + `src/preview-main.ts` + `preview.html`（仿 `roam-import-*` / `insights-*`）。挂载后读取自身窗口 label，取回 payload，按 `kind` 渲染。
- **新增 Rust 窗口管理模块**：`src-tauri/src/preview_window/mod.rs`
  - Tauri 托管状态：`Mutex<HashMap<String /*label*/, PreviewPayload>>`
  - 命令 `open_preview_window(label, title, kind, content)`：存 payload → 若窗口已存在则聚焦并 emit `preview-updated`，否则 `WebviewWindowBuilder` 新建窗口（指向 `preview.html`）。
  - 命令 `take_preview_payload(label) -> Option<PreviewPayload>`：预览窗口挂载/收到更新事件时取数据。
- **复用**：`src/components/history/DiffView.svelte` + `src/lib/git-history/diff-parse.ts`（diff 渲染）挪到预览窗口内使用；渲染 rich 用现有 `src/lib/plugins/host-render-html.ts` 的 markdown→HTML 管线。
- **改造**：`src/components/history/HistoryPanel.svelte` 的 `onDiff` / `onCompareCurrent` 改为调 `open_preview_window`；新增 `onPreview`。
- **清理**：移除 diff 走 tab 的路径——`src/components/EditorPane.svelte` 的 `isDiffPreviewTab` 分支、`src/lib/tabs.svelte.ts` 的 `openTextTab` 与 `isDiffPreviewTab`（仅 git-history 用过）。

### 数据结构

```ts
type PreviewKind = 'diff' | 'rich'
interface PreviewPayload {
  title: string        // 窗口标题
  kind: PreviewKind
  content: string      // kind='diff' 时是 unified diff 文本；kind='rich' 时是该版本 markdown 源码
}
```

Rust 端对应 `#[derive(Serialize, Deserialize, Clone)] struct PreviewPayload { title, kind, content }`。

### 数据流（三个动作）

HistoryPanel 中，选中某 commit `c` 后：

- **查看 diff**：`git_file_show(repo, c.hash, path)` → `open_preview_window(label=preview-diff-<short>, title=t('history.diffTitle',…), kind='diff', content=diff)`
- **与当前对比**：`git_diff_current(repo, c.hash, path, tab.currentContent)` → `open_preview_window(label=preview-cmp-<short>, kind='diff', …)`。若 diff 为空，仍走"无差异" toast（沿用现有逻辑，不开窗）。
- **预览（新）**：`git_file_at(repo, c.hash, path)` → `open_preview_window(label=preview-rich-<short>, kind='rich', content=markdown)`

`<short>` = commit 短 hash；label 里加类型前缀，保证同版本的三类预览互不覆盖，不同版本各开新窗。

### 预览窗口渲染

`preview-app.svelte` 挂载流程：
1. `const label = getCurrentWindow().label`
2. `const payload = await invoke('take_preview_payload', { label })`
3. 监听 `preview-updated` 事件（同 label 窗口被复用刷新时）→ 重新 `take_preview_payload` 并重渲。
4. 按 `payload.kind` 渲染：
   - `'diff'` → `<DiffView content={payload.content} />`
   - `'rich'` → 用 `renderTabAsInlineBody`（对合成的只读 Tab）或等价 markdown→HTML 管线得到 HTML，放进只读容器 `<div class="rich-preview">{@html html}</div>`；import 应用的 markdown/主题 CSS 使观感与主编辑器 rich 一致。

### 窗口生命周期 / 授权 / 配色（踩过的坑）

- **capabilities**：`src-tauri/capabilities/default.json` 的 `windows` 列表加 `"preview-*"` 通配（Tauri v2 支持 label glob）。不加则预览窗口里的后端命令被静默拒绝。
- **配色**：`preview-app` 的根样式必须自声明 `color-scheme: light dark`，否则 DiffView 用的 Canvas/CanvasText 系统色会卡在浅色。
- **窗口参数**：`title`、`inner_size` 合理默认（如 720×640）、`min_inner_size`、`resizable(true)`、`decorations(true)`、初始 `visible(false)` 后 `show()+set_focus()`（仿现有窗口）。

## 错误处理

- git 命令失败 → 主窗口 `pushToast` 报错，不开窗（沿用现有 `onDiff`/`onCompareCurrent` 的 catch）。
- `take_preview_payload` 拿不到（label 不存在/已被取走）→ 预览窗口显示空状态提示，不崩。
- 与当前对比无差异 → toast「与当前文档无差异」，不开窗。

## 测试策略

- **Rust 单测**：`preview_window` 的 payload stash → take 往返、take 后清除、覆盖更新。
- **前端单测**：`diff-parse` 既有单测继续用。窗口/渲染逻辑靠实机验证。
- **GUI 实机验证**：属独立窗口 + 渲染回归，按项目规矩 dev 实机 + 截图（注意 single-instance/已安装 app 抢实例的坑，用 `System Events tell process` 驱动、确认跑的是 `target/debug`）。验证点：三个动作各开窗、同版本复用、不同版本并排、diff 彩色、rich 观感、深浅色、Esc/关闭。

## 非目标（YAGNI）

- 不做预览窗口内的编辑（只读）。
- 不做窗口位置/尺寸的持久化记忆（首版用默认尺寸）。
- 不做 side-by-side 双栏 diff（沿用现有 unified DiffView）。
- 恢复动作不改（仍写缓冲）。
- 不为预览窗口做多语言以外的额外主题切换 UI（跟随系统深浅色即可）。
