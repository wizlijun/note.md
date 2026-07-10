# 大纲多节点选择

日期:2026-07-10

## 目标

大纲面板支持一次选中多个可见节点并批量操作。

## 选择交互

- **拖框选**:在面板空白处(非节点行)按下拖动,矩形与行相交的可见节点选中;移动阈值 4px,未达阈值仍视为点击(保留"点空白建新根节点"行为,但选择集非空时该点击只清除选择)。
- **Shift+点击**:以 `selectionAnchor`(最近一次进入编辑/点击的节点)为锚,选中锚与目标间的可见节点(含端点)。
- **Esc / 点击空白**清除选择;普通点击节点 = 清除选择并进入编辑。

## 批量操作(自动节点跳过写操作)

- Delete/Backspace:删除选中手写节点及子树;若有子节点则先确认(复用 `outline.deleteConfirm`)。
- Tab / Shift+Tab:按父分组整组缩进(挂到组首前一个未选中兄弟下)/反缩进(逆序逐个移出,保持相对顺序)。
- 拖拽任一选中节点 = 整组移动(dataTransfer 传 selection roots id 列表,逗号分隔)。
- Cmd/Ctrl+C(无编辑焦点时):selection roots 的子树序列化为 markdown 复制。

## 结构

- `select.ts`(新):`rangeBetween(tree, a, b)`(visibleNodes 序闭区间)、`selectionRoots(tree, ids)`(剔除祖先已选中的节点,可见序)。
- `commands.ts` 新增纯函数:`deleteNodes` / `indentNodes` / `outdentNodes` / `moveNodesAfter(ids, target)` / `moveNodesToChild(ids, target)` / `nodesToMarkdown`,配单元测试。
- `store.svelte.ts`:`selectedIds: Set<string>`(每次整体重赋值以触发响应)、`selectionAnchor: string | null`;attach/detach 时重置。
- `OutlineNode.svelte`:行加 `data-node-id` 与 `.selected` 样式(浅 accent 背景);content 点击区分 Shift;dragstart 携带整组。
- `OutlinePanel.svelte`:框选 pointer 处理 + fixed 定位选择矩形;`svelte:window` keydown 处理批量快捷键(仅选择集非空且无编辑焦点)。

## UI 不做的事

- 不支持跨折叠展开选择(只对可见节点);搜索过滤态下按过滤后的可见集框选。
- auto 节点可被选中(可复制),但删除/缩进/移动时跳过。
