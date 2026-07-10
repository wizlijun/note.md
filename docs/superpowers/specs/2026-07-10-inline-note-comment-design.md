# 行内批注（note/comment）设计

日期：2026-07-10
状态：已确认（用户批准）

## 目标

在 md 编辑中提供插入 note/comment 的统一能力，rich / source 双模式适配：

- 在文档任意位置插入批注：可包裹一段选中文字，也可作为纯插入点角标。
- rich 模式：被批注文字高亮显示，尾部（或插入点处）显示角标；鼠标悬停显示批注内容；点击角标弹出编辑气泡。
- source 模式：批注即一段 md 文本标记，被批注文字直接被标记包裹，可手工编辑。
- note 与 comment 抽象为同一机制，不区分类型。

## 标记语法（CriticMarkup 子集）

采用 CriticMarkup 的 highlight+comment 语法，Pandoc 等工具原生认识，纯文本可读：

```
包裹批注：  这段是{==被标注的文字==}{>>批注内容<<}，后面是正文。
插入点批注：这段话结尾{>>只是一条批注<<}。
```

规则：

- `{==…==}` 与 `{>>…<<}` 必须紧邻（无空白）才构成包裹批注；单独的 `{>>…<<}` 是插入点批注。
- 被标注文字内允许普通 inline 格式（加粗、斜体等），批注内容是纯文本，不跨段落、不嵌套。
- 残缺/未闭合的标记不解析，按普通文本原样显示（fail open，不吞用户内容）。
- 批注内容中的换行在保存时替换为空格；字面量 `<<}` 序列保存时拆开（插入空格）以免提前闭合。

## 架构分层

```
moraya-core                 mdeditor
┌─────────────────────┐    ┌──────────────────────────────────┐
│ markdown-it inline  │    │ rich: 角标 widget 插件            │
│ rule（先于 == 高亮）│    │       NotePopover（hover 预览）   │
│ annotation mark     │◄──►│       NoteEditPopup（点击编辑）   │
│ note_anchor node    │    │ source: 文本包裹插入 + 语法着色   │
│ 序列化回 CriticMarkup│    │ 入口: 右键菜单/快捷键/Slash 菜单  │
└─────────────────────┘    │ 导出: host-render-html 预转换     │
                           └──────────────────────────────────┘
```

## moraya-core 变更

### schema

- **`annotation` mark**：attrs `{ note: string }`，`inclusive: false`，与自身互斥。
  toDOM：`<span class="moraya-annotation" data-note="…">`（淡黄底 + 虚线下划线，具体色值随主题）。
- **`note_anchor` inline atom 节点**：attrs `{ note: string }`，selectable。
  toDOM：`<span class="moraya-note-anchor" data-note="…">`（角标本体）。

### 解析

markdown-it inline rule `critic_annotation`，注册在 `==` highlight 规则之前（否则 `{==x==}` 会被 highlight 抢先拆散成 `{` + highlight + `}`）。匹配两种形态并产出对应 token；被标注文字内部继续走 inline 解析。

### 序列化

- mark：open 输出 `{==`，close 输出 `==}{>>note<<}`（note 取 attr）。
- 节点：输出 `{>>note<<}`。
- mark/node 的输出不经过 esc()，不需要类似 `restoreWikilinks` 的转义补偿。

### 流程约束

改动 moraya-core 后必须 `tsup` + `pnpm sync:core` 再重启，否则 Vite deps 缓存导致不生效。

## mdeditor：rich 模式 UI

- **角标渲染**：新增小型 PM 插件（参照 `wikilink-plugin.ts` 的挂载方式，在 RichEditor 动态 import 后 reconfigure 注入），为每个 `annotation` mark 的结尾位置挂 widget decoration 角标（`contenteditable=false`）。`note_anchor` 节点自身即角标。两者共用一套 CSS，适配深浅色主题。
- **hover 预览**：编辑器容器监听 `mouseover`，`target.closest('[data-note]')` 命中时显示浮动 tooltip 组件 `NotePopover.svelte`（展示批注纯文本，跟随移开消失）。
- **点击编辑**：点击角标弹出锚定气泡 `NoteEditPopup.svelte`：多行 textarea + 删除按钮。
  - 关闭（点击外部 / Esc）即保存：更新 mark attr（该 mark 范围 removeMark + addMark 新 attrs）或 `note_anchor` 的 setNodeMarkup。
  - 删除按钮：包裹批注 → 移除 mark，正文文字保留；插入点批注 → 删除节点。
- **插入命令**：
  - 有选区 → 对选区 addMark `annotation`（note 为空字符串），立即弹编辑气泡；
  - 无选区 → 在光标处插入 `note_anchor`（note 为空），立即弹气泡。
  - 注意：气泡等 UI 状态更新遵循 `$effect` 内 store 调用 untrack 的既有教训。

## mdeditor：source 模式

- **插入**：走 SourceView 现有 textarea + `setContent` 机制：
  - 有选区 → 替换为 `{==选中文字==}{>><<}`，光标定位到 `>>` 与 `<<` 之间；
  - 无选区 → 插入 `{>><<}`，光标居中。
- **语法着色**：高亮层 pre 中对 CriticMarkup 两种形态加淡黄着色，便于辨认。文本本身原样保留（满足"文本直接被标记包裹"）。

## 插入入口（三个）

| 入口 | rich | source |
|---|---|---|
| 右键菜单 | menu-model 加 `note` 项，rich-actions 映射插入命令 | source-actions 映射文本包裹 |
| 快捷键 `Cmd+Shift+N` | RichEditor keydown 表 | SourceView onTextareaKeydown |
| Slash 菜单 | slash-menu 加"插入批注"项 | 不适用 |

i18n：`en.ts` 加扁平键（如 `ctxmenu.note`、`notepopup.delete` 等），中文目录补翻译；沿用现有 i18n 系统约定。

## 导出 / 分享（默认保留批注）

`host-render-html` 管线在 md 进渲染器之前做预转换：

```
{==x==}{>>y<<}  →  <mark class="crit-anno">x</mark><sup class="crit-badge" title="y转义后"></sup>
{>>y<<}         →  <sup class="crit-badge" title="y转义后"></sup>
```

批注内容做 HTML 属性转义。配套 CSS 进入导出模板。效果：

- 分享出去的 HTML 页面（mdshare）：高亮 + 角标，hover 角标显示批注。
- 打印 PDF：保留高亮与角标；PDF 无 hover，批注内容本期不可见。
- 未来按需增加"导出时剥离批注"的参数，本期不做。

## 错误处理

- 残缺标记（缺 `<<}`、嵌套、跨段落）：解析规则不匹配，原样显示为文本，不报错不吞字。
- 批注内容非法字符：保存时换行 → 空格、`<<}` → `< <}`。
- 编辑气泡打开期间文档被外部修改（file-watcher）：气泡随内容重建关闭，放弃未保存的气泡输入（与现有外部变更行为一致）。

## 测试

- **moraya-core**：CriticMarkup 解析/序列化 round-trip 单测；残缺标记 fail-open 用例；`{==**bold**==}{>>n<<}` 内嵌格式用例。
- **mdeditor**：source 插入函数（选区/无选区/光标位置）单测；menu-model 结构单测扩展；导出预转换（含转义）单测。
- **GUI**：角标/气泡/hover 属 GUI 改动，发布前按惯例 dev 实机验证（osascript 驱动 + 截图）。

## 决策记录

| 决策 | 结论 | 备注 |
|---|---|---|
| 标记语法 | CriticMarkup | 用户选定 |
| 导出可见性 | 默认保留批注，未来加隐藏参数 | 用户选定 |
| 插入入口 | 右键菜单 + 快捷键 + Slash 菜单 | 用户选定 |
| 实现方案 | 方案 B：moraya-core schema 扩展 | 用户选定；A（纯 decoration）因 highlight 抢解析、转义、隐藏文本光标三处 hack 被否 |
