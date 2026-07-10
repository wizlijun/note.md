# 编辑器右键上下文菜单设计（Rich + Source）

日期：2026-07-10
状态：待实现

## 目标

在 **rich 模式**（`@moraya/core` ProseMirror）和 **source 模式**（`<textarea>`）下分别接管系统右键菜单，
提供一致的、以常用编辑功能为主的自定义上下文菜单。选中一段文字右键即可快捷加标记
（高亮、加粗、斜体、删除线、行内代码、WikiLink、链接等），并可做块级转换与内容插入。

## 关键决策（已与用户确认）

- **接管原生菜单**：`contextmenu` 事件 `preventDefault()`，用自绘菜单替换。因此菜单需自己补回
  **剪贴板操作**（剪切/复制/粘贴/全选）。
- **功能范围（四组全要）**：内联标记 / 链接 / 块级转换 / 插入。
- **突出项**：**高亮** 和 **WikiLink** 单独作为根节点项，加重显示（图标 + 描边），置于剪贴板之下、
  其余内联标记之上，方便一眼命中。
- **无选区行为**：内联标记类在光标插入点（collapsed selection）右键时，**自动扩展到当前词**再套用标记
  （符合 Obsidian/Typora 习惯）；若光标不在词上则回退为"插入空标记、光标居中"。
- **块级 / 插入**用二级子菜单（▸ 悬停展开），根节点保持精简。

## 菜单结构

```
┌─ 剪切  复制  粘贴  全选              ← 剪贴板分组
├─ ⭐ 高亮      🔗 WikiLink           ← 突出项（根节点，加重）
├─ 加粗  斜体  删除线  行内代码          ← 其余内联标记
├─ 链接  （有选区时：文字→链接）         ← 链接
├─ 标题▸(H1/H2/H3)  引用  代码块  列表▸(无序/有序/任务)  分割线   ← 块级（子菜单）
└─ 插入▸ (表格 / 图片 / 公式 / Mermaid / 日期)                  ← 插入（子菜单）
```

分组之间用分隔线。子菜单项：标题 = H1/H2/H3；列表 = 无序/有序/任务。

## 架构：统一菜单 + 双适配器（方案 A）

菜单是**数据**（分组 + 项 + 启用条件），执行是**适配器**（rich / source 各一份）。
沿用现有 `slash-items.ts`（item 定义 + `execute`）与 `SlashMenu.svelte`（浮层 + 键盘导航）模式。

### 组件与文件

```
src/lib/context-menu/
  menu-model.ts        # ContextAction / MenuGroup 定义；分组结构（数据，与后端无关）
  EditorContextMenu.svelte  # 浮层渲染 + 键盘/鼠标导航 + 子菜单展开（复用 SlashMenu 样式）
  rich-actions.ts      # ProseMirror 适配器：toggleMark / setBlockType / wrapInList / 插入
  source-actions.ts    # textarea 适配器：复用抽出的 wrap 逻辑
  text-format.ts       # 从 SourceView 抽出的纯函数：智能 wrap/unwrap、扩展到当前词
```

### 接口

```ts
// menu-model.ts
export interface MenuItemSpec {
  id: string
  labelKey: string          // i18n 键，t(labelKey)
  icon?: string
  emphasis?: boolean        // 突出项（高亮 / WikiLink）
  needsSelection?: boolean  // true = 无选区时禁用（如"文字转链接"）
  children?: MenuItemSpec[]  // 子菜单
}
export interface MenuGroup { id: string; items: MenuItemSpec[] }
export function getMenuModel(ctx: MenuContext): MenuGroup[]

export interface MenuContext {
  hasSelection: boolean     // 控制 needsSelection 项的启用/禁用
}

// 适配器：把 item.id 映射到具体执行
export interface EditorActions {
  run(id: string): void | Promise<void>
  canRun(id: string): boolean   // 剪贴板项在无选区时禁用剪切/复制等
}
```

菜单模型只产出结构；`EditorContextMenu.svelte` 接收 `groups` + `actions`，点击项时调 `actions.run(id)`。
rich 与 source 各自 `new` 一个 actions 对象传入。

### rich-actions.ts

- 从 `view.state.schema` 取类型（**不**从 `@moraya/core/commands` 取，identity 不同——沿用 slash-items 的注释教训）。
- 内联标记：`toggleMark(schema.marks[name])`。无选区时先把 selection 扩展到当前词
  （用 `$from.parent.textBetween` + 词边界正则找 word range，再 `TextSelection.create`），再 toggle；
  找不到词则插入空标记文本、光标居中。
- 标记名映射：加粗=`strong`，斜体=`em`，高亮=`highlight`，删除线=`strikethrough`，行内代码=`code`。
- WikiLink：把选中文字（或当前词）包成 `[[...]]` 文本（保持与 source 一致，走文本而非 mark）。
- 链接：`toggleMark(schema.marks.link, { href })`；无 href 时插入 `[text](url)` 占位。
- 块级：`setBlockType` / `wrapIn` / `wrapInList`（复用 slash-items 的 helper，考虑从 slash-items 抽公共 helper 避免重复）。
- 插入：表格/图片/公式/Mermaid 复用 slash-items 已有逻辑；日期插入当前日期文本。
- 剪贴板：`document.execCommand('cut'|'copy'|'paste')` 或 Tauri clipboard plugin；全选 = 选中全文档。

### source-actions.ts + text-format.ts

- 把 `SourceView.onTextareaKeydown` 里已有的智能 wrap/unwrap（`**`/`*`/`^^` 的三种情况：选区内含标记、
  标记在选区外、无标记则包裹）抽成 `text-format.ts` 的纯函数 `applyWrap(value, start, end, open, close)`，
  返回 `{ value, selStart, selEnd }`。SourceView 的快捷键与 source-actions 都调它，去重。
- 标记映射（source 用 markdown 符号）：加粗=`**`，斜体=`*`，高亮=`==`（或与现有 `^^` 一致——**采用现有 `^^`**
  以保持与 Cmd+H 一致），删除线=`~~`，行内代码=`` ` ``。
- 无选区时 `expandToWord(value, cursor)` 找当前词范围再 wrap。
- WikiLink：`[[selected]]`；链接：`[selected](url)`。
- 块级：在行首插入/替换前缀（`# `、`> `、`- `、`1. `、`- [ ] `）或包裹代码围栏 ```` ``` ````；
  分割线插入 `\n---\n`。
- 插入：表格插入 markdown 表格骨架；图片走 `slash` 的文件选择后插 `![](path)`；公式 `$$\n\n$$`；
  Mermaid ```` ```mermaid ````；日期插当前日期。
- 剪贴板：textarea 原生 execCommand / setRangeText。

### 事件接管

- **RichEditor.svelte**：`_pmEl.addEventListener('contextmenu', handler, true)`；`preventDefault`，
  用 `view.state.selection.empty` 判 `hasSelection`，用鼠标坐标定位菜单，`showContextMenu = true`。
  onDestroy 移除监听（与现有 listener 清理一致）。
- **SourceView.svelte**：`textarea.oncontextmenu`；`preventDefault`，`selectionStart !== selectionEnd`
  判 hasSelection。
- 菜单在点击外部 / Escape / 选中项后关闭；键盘上下导航 + Enter 执行（复用 SlashMenu 逻辑）。

## i18n

新增 `ctxmenu.*` 扁平点分键到 `src/lib/i18n/en.ts`（英文基线），中文等其它语言按现有 Partial 目录机制补。
标签复用已有 `slash.*` 处直接引用，不重复定义。

## 测试

- `text-format.test.ts`：`applyWrap` 三种 wrap/unwrap 情况 + `expandToWord` 边界（词首/词尾/空行/中文词）。
- `menu-model.test.ts`：`getMenuModel` 在 hasSelection true/false 下 `needsSelection` 项的启用态；突出项存在且顺序正确。
- rich-actions/source-actions 的纯逻辑部分尽量抽成可单测函数；ProseMirror 交互部分靠现有 dev GUI 实机验证
  （见 memory `reference_dev_gui_verification`）。
- 手动验证矩阵：rich/source × 有选区/无选区 × 每个突出项 + 每组一项。

## 非目标（YAGNI）

- 不做 source 换 CodeMirror。
- 不做菜单项自定义/用户配置。
- 不做嵌套超过两级的子菜单。
- 图片工具栏、slash 菜单等现有交互保持不变。

## 复用与改进

- 从 `slash-items.ts` 抽出 `setBlock/wrap/wrapList/insertTable/insertSpreadsheet` 等 helper 到共享模块，
  供 slash 菜单与右键菜单共用，避免两份实现漂移。
- 从 `SourceView.svelte` 抽出 wrap 逻辑到 `text-format.ts`，快捷键与右键共用。
