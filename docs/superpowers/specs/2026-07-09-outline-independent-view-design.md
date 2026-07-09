# Outline — 独立视图重构（v4）— Design

**Date:** 2026-07-09
**Status:** Approved，待实现
**关联:** 修订 [2026-07-09-outline-notes-design.md](./2026-07-09-outline-notes-design.md) 的 Layout / 编辑 / 样式部分

## Summary

大纲面板从"与当前编辑器 tab 强绑定的右侧面板"改造为**工作区级的独立右侧栏**
（与左侧 Folder View 完全对称），并配套三项体验修整：

1. **R1 独立成一栏** — 无论是否有文档打开，右侧大纲栏位常驻；内容随当前文档切换，
   而非整块出现/消失。
2. **R2 排版跟随主题** — 大纲的字体、字号、行高跟随用户选中的主题。
3. **R3 默认可编辑** — 打开即有可输入的编辑起点；鼠标/键盘均可建节点、子节点；
   移除表头 `+` 按钮。
4. **R4 图标统一** — 表头按钮换成与全局 / Folder View 一致的描边 SVG 风格。

桌面优先；iOS 路径不触碰。不改动 `.notes.md` 伴生文件格式、反链、快捷键配置、
拖拽、`/` 与 `[[` 菜单等既有能力。

## 现状根因

`src/App.svelte` `section.pane` 内，`<OutlinePanel>` 被放在 `{#if current}` **块内**
且以 `tab={current}` 强绑定，gate 含 `current && outlineAppliesTo(current)`，
所以无文档 / 非 markdown / `.notes.md` 时整块消失。左侧 `<FolderView>` 则在
`{#if current}` **之外**，是工作区级常驻视图。二者结构不对称即"嵌入在编辑器内"的根因。

---

## R1 — 独立成一栏

### App.svelte

- 将 `<OutlinePanel>` 移出 `{#if current}`，作为 `.pane` 内
  `{#if current}…{:else}…{/if}` **之后**的兄弟节点渲染。
- gate 改为：`platformName !== 'ios' && outlineGate.enabled && outlineGate.visible`
  （去掉 `current && outlineAppliesTo(current)`）。
- 保留懒加载：`{#await import('./components/outline/OutlinePanel.svelte')}`——
  插件禁用或面板隐藏时依旧不加载代码、不挂监听、零资源。
- 传入 `tab={current ?? null}`。

布局结果（Folder View + 大纲都开、无文档时）：
`[FolderView] [EmptyState] [大纲空态栏]`，左右对称。

### OutlinePanel.svelte

- prop 改为 `tab: Tab | null`。
- 表头（标题 + 隐藏/搜索/重新生成按钮）**始终渲染**，栏位不塌陷。
- `outlineAppliesTo` 从 App.svelte 移入面板内部判定；派生一个
  `applicable = tab != null && outlineAppliesTo(tab)`。
- body 三态：
  - `applicable` → 正常大纲（现有逻辑）。
  - `tab == null` → 占位文案 `outline.noDocument`（"打开一个 markdown 文件以查看大纲"）。
  - `tab` 非 md 或 `.notes.md` → 占位文案 `outline.notApplicable`（"此文件无大纲"）。
- store 生命周期：
  - `applicable` → 现有 `attachTab` / `scheduleSyncFromMain` / `ensureIndex` 逻辑。
  - 非 `applicable`（含 `tab` 从有变无、切到 `.notes.md`）→ `flushSave(); detach(); teardownIndex()`。
  - 现有 unmount 兜底 `$effect(() => () => { flushSave(); detach(); teardownIndex() })` 保留。
- 表头 search / 重新生成按钮在非 `applicable` 时 `disabled`。
- 新增 i18n 键：`outline.noDocument`、`outline.notApplicable`（en 必填，zh/ja 跟随
  现有 outline 键的翻译约定）。

---

## R2 — 排版跟随主题

### 背景

主题编译后作用域为 `[data-theme="<id>"] .moraya-editor`（见
`src-tauri/src/themes/compiler.rs`），基础排版（`font-family` / `font-size` /
`line-height`，源自 Typora `#write` 规则）挂在 `.moraya-editor` 根规则上。
`activeTheme.id`（`src/lib/active-theme.svelte.ts`）为当前生效主题 id。

### 探针法

在 OutlinePanel 内渲染一个隐藏离屏探针：

```html
<div class="typo-probe" data-theme={activeThemeId} aria-hidden="true">
  <div class="moraya-editor"></div>
</div>
```

探针 CSS：`position:absolute; left:-9999px; top:0; visibility:hidden;`（保持可测量，
不进入无障碍树，不影响布局）。

`$effect`（依赖 `activeTheme.id`）在 `requestAnimationFrame` 后读
`getComputedStyle(probeEditor)` 的 `fontFamily` / `fontSize` / `lineHeight`，
写入面板根元素的 CSS 变量：

- `--outline-font-family`
- `--outline-font-size`
- `--outline-line-height`

rAF 用于等主题 slot CSS 应用后再测量（主题切换 / 明暗翻转时 slot 内容异步更新）。

### 消费

- `OutlineNode.svelte` 的 `.row`：将硬编码 `font-size: 13px; line-height: 1.5` 改为
  `font-size: var(--outline-font-size); line-height: var(--outline-line-height);
  font-family: var(--outline-font-family);`。
- 编辑态 `textarea.edit` 已 `font: inherit`，自然继承。
- `.body` 容器设 `font-family: var(--outline-font-family)` 作为兜底继承源。
- **统一套用主题正文排版，不按标题级别放大字号**——大纲是导航/笔记树，
  TOC 项与手写项一致的基准排版更合适。

### 取舍

不复用 `.moraya-editor` 完整作用域（会连带 padding / 标题计数 / 列表 marker /
`::before` 等结构样式，破坏大纲布局）。探针只提取三项排版属性，边界清晰。

---

## R3 — 默认可编辑、鼠标/键盘建节点、去 `+`

### 移除表头 `+`

- 删除表头 `＋` 按钮。`addRootNote` 保留为内部函数（供空白区点击 / 空态复用）。

### 空态即可编辑

- `applicable` 且树内零节点时，不再渲染静态 `<p class="empty">`，改为提供一个
  **待输入空节点**（`source:'manual'`、`content:''`、置于 `outline.editingId`、聚焦）。
- 该空节点由面板在进入"零节点空态"时惰性创建一次（避免重复创建：仅当当前无
  editing 空节点时建）。

### 防止空文档乱写伴生文件

否则"仅打开面板"会给每个无标题/无高亮文档生成 `foo.notes.md`（内容仅 `- `）。

- 空占位节点的**创建不调用 `markDirty`**（仅设 `editingId` + `bump`）。
- `flushSave` 增加护栏：当树内**无 auto 节点**且**所有 manual 节点 `content.trim()===''`**
  时**跳过写盘**（视为空大纲，不落文件）。
- 用户一旦输入非空内容 → 正常 `markDirty` → 800ms debounce 写盘。
- 边界：既有非空 `.notes.md` 被清空至全空的情形不在本次处理范围（保留原文件，
  属罕见手动操作）。

### 鼠标建节点

- `.body` 空白区（最后节点下方）新增 click 处理：命中空白（非节点行）→
  `addRootNote()` 在末尾建根节点并进入编辑。

### 键盘（现已支持，验证保留）

- `Enter`=建兄弟、`Tab`=缩进为子节点、`Shift+Tab`=升级、行首 `Backspace`=合并/删除。
- 确认空态起点节点同样响应上述键位。

### 取舍

采用 Workflowy/Logseq 惯例：**无任何 `+` 按钮**，子节点靠 `Tab` 或拖拽。
不加每行 hover "+建子节点"（如后续需要再增量）。

---

## R4 — 工具栏图标统一

- 大纲表头按钮由文字字形（`«` `⌕` `⟳` `＋` `✕`）换为与 `FolderView.svelte`
  `.hbtn` 一致的描边 SVG 图标：同 `width/height=15`、`viewBox 0 0 24 24`、
  `stroke=currentColor stroke-width=2`、同 `.hbtn` 按钮样式（padding 3px、
  border-radius 4px、opacity 0.7、hover 背景、`.on`/active 态、`:disabled` 态）。
- 图标映射：
  - **隐藏** — 面板 + chevron，镜像 Folder View 的左向版为**右向**
    （大纲在右，隐藏向右收起）。
  - **搜索** — 放大镜（复用 Folder View）。
  - **重新生成** — 刷新双箭头（复用 Folder View refresh）。
  - **搜索清除 `✕`** — 复用 Folder View `.clear` 的描边叉。
- 复用 Folder View 的 `.hbtn` / `.clear` 样式规则（含 `@media (prefers-color-scheme: dark)`
  分支）；抽为面板局部样式即可，无需全局提取。

---

## 影响文件

| 文件 | 改动 |
|---|---|
| `src/App.svelte` | 移 `<OutlinePanel>` 出 `{#if current}`；调整 gate；传 nullable tab |
| `src/components/outline/OutlinePanel.svelte` | nullable tab + 三态 body；探针 + CSS 变量；去 `+`、空白区 click、空态起点节点；表头 SVG 图标 |
| `src/components/outline/OutlineNode.svelte` | `.row` 排版改用 CSS 变量 |
| `src/lib/outline/store.svelte.ts` | `flushSave` 空树护栏 |
| `src/lib/i18n/en.ts`（及 zh/ja partial） | `outline.noDocument` / `outline.notApplicable` |

## 测试

- `store.svelte.ts` 空树护栏：新增单测——全空 manual 树 `flushSave` 不写盘；
  含 auto 节点或非空 manual 内容则写盘。
- 手动验证（跑起来）：
  - 无文档时右侧栏常驻、显占位；开 md → 出大纲；切到 `.notes.md` → 占位。
  - 切换主题 / 明暗 → 大纲字体字号行高随之变化。
  - 空文档打开面板 → 有可输入起点；输入前不生成 `.notes.md`，输入后生成。
  - 空白区点击建节点；`Enter`/`Tab`/`Shift+Tab` 建兄弟/子/升级。
  - 表头图标与 Folder View 视觉一致。
