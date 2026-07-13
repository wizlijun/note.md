# 大纲粘贴解析多层次节点 — 设计文档

日期：2026-07-13
分支：feat/recall-perf-linkfix

## 目标

在大纲（Outline）里往一个节点粘贴文本时，解析粘贴内容——如果它是一个大纲层次结构，就以多层次节点的形式粘贴进去，而不是把整段文本连同换行塞进单个节点。

## 背景

现状（探查结论）：

- 大纲节点是扁平存储：`OutlineTree.nodes: Map<string, OutlineNode>`，节点靠 `parentId` + `order`（浮点分数）建立层级。定义在 `src/lib/outline/model.ts`。
- 每个节点在 UI 上是一个原生 `<textarea>`（`src/components/outline/OutlineNode.svelte`），仅有 `oninput` / `onkeydown` / `onblur`，**没有任何自定义 `onpaste`**——所以粘贴目前是原生行为：多行文本会连换行塞进同一个 textarea。
- 已有 `parseOutline()`（`src/lib/outline/markdown.ts`）能把 Markdown 缩进列表解析成树，但它假设固定的 2 空格步长、且面向"整个 .note.md 文件"，不适合直接复用在剪贴板任意文本上。
- 节点操作命令在 `src/lib/outline/commands.ts`（`createSiblingBelow` / `indentNode` / `calculateOrderBetween` 等）。

## 需求（已与用户确认）

1. **识别格式**（解析器要同时吃下这四种）：
   - Markdown 列表：`- ` / `* ` / `+ ` / `1. ` 开头 + 缩进决定层级。
   - 缩进纯文本：无项目符号，仅靠行首空格缩进表示层级。
   - Tab 缩进（大纲工具，如 Workflowy/Logseq/幕布导出）：每个 Tab = 一层。
   - 多行无缩进 = 平级：每行作为一个平级兄弟节点。

2. **粘贴落点（Option A，类 Workflowy/Logseq）**：
   - 第一行进入当前节点（插入到光标处、并入当前节点文本）。
   - 其余各行按**相对缩进**依次变成当前节点之后的兄弟/子节点。

3. **不拦截、退回原生 textarea 粘贴的情形**：
   - 粘贴内容只有单行（无换行）。
   - 当前 textarea 里有选区（`selectionStart !== selectionEnd`）。
   - 剪贴板不是纯文本（无 `text/plain`，例如图片/文件/富文本）。

## 架构（3 个隔离单元）

### 1. 纯解析函数 — 新文件 `src/lib/outline/paste.ts`

```ts
export interface ParsedPasteNode { depth: number; content: string }
export function parseClipboardOutline(text: string): ParsedPasteNode[]
```

- 纯函数、零副作用、可独立单测。
- **缩进栈算法**（不假设固定步长）：
  1. 按行拆分，跳过纯空行。
  2. 每行计算前导空白的"视觉宽度"：空格记 1，Tab 记固定宽度（`TAB_WIDTH = 4`）。
  3. 剥离列表标记：正则匹配行首 `-` / `*` / `+` / `1.`（有序数字点）后跟一个空格；有则去掉、剩余作 `content`，无则整行 trim 后作 `content`。标记本身不计入缩进（缩进按标记前的空白算）。
  4. 维护一个缩进宽度栈 `indentStack: number[]`：
     - 当前行宽度 > 栈顶 → 压栈，`depth = stack.length - 1`（进一层）。
     - 当前行宽度 == 栈中某祖先 → 弹到该层，`depth` 取该层。
     - 都不精确相等时按"最接近且不超过"归一，避免混合 Tab/空格算错层。
  5. 整块 `depth` 归一：最终 depth 以 0 为最小值（第一有效行 depth = 0）。
- 无缩进多行时所有行 depth 都是 0 → 天然平级，覆盖需求 1 的第四种。
- 返回结果为空或长度 < 2 时，调用方视为"不构成层次结构"，退回原生粘贴。

### 2. 插入命令 — 加进 `src/lib/outline/commands.ts`

```ts
export function insertPastedTree(
  tree: OutlineTree,
  currentNodeId: string,
  head: string,          // 当前节点光标前的文本
  tail: string,          // 当前节点光标后的文本
  parsed: ParsedPasteNode[],
): string                // 返回最后一个受影响节点的 id（用于落焦点）
```

实现 **Option A** 挂载：

- 当前节点内容改为 `head + parsed[0].content`（`parsed[0].depth` 恒为 0，对应当前节点自身这一层）。
- 从 `parsed[1]` 起，按相对 `depth` 依次建节点：
  - `depth === 0` → 当前节点的**兄弟**（`parentId = currentNode.parentId`），紧跟当前节点之后。
  - `depth >= 1` → 父节点是 `levelStack[depth - 1]`（该层最近建出的节点）。
  - 维护 `levelStack: string[]`，`levelStack[0] = currentNodeId`，每建一个节点就 `levelStack[depth] = newId` 并截断更深层。
  - 排序复用现成的 `calculateOrderBetween`：
    - 每个父节点维护一个"上一个已插入子节点的 order"游标；对 `depth === 0`，游标起点是 `currentNode`（新兄弟插到 `currentNode` 与其原下一个兄弟之间，依次递增）。
    - 对 `depth >= 1`，父多为刚建出的空节点（游标从其现有子末尾起）。
- **光标尾巴** `tail` 追加到**最后一个新建节点**内容末尾（若 `parsed` 只有 1 行则不进这里、由调用方处理，见边界）。
- 新节点 `source: 'manual'`，带 `createdAt` / `updatedAt`（与现有创建节点一致）。

### 3. 事件接线 — `src/components/outline/OutlineNode.svelte`

给 textarea 加 `onpaste` handler：

1. 读 `e.clipboardData`；若无 `text/plain` → return（原生，覆盖图片/富文本）。
2. 取 `text = clipboardData.getData('text/plain')`；若不含换行（单行）→ return（原生）。
3. 若 `textarea.selectionStart !== textarea.selectionEnd`（有选区）→ return（原生）。
4. `parsed = parseClipboardOutline(text)`；若 `parsed.length < 2` → return（原生）。
5. 否则 `e.preventDefault()`：
   - `head = value.slice(0, selectionStart)`，`tail = value.slice(selectionStart)`。
   - `lastId = insertPastedTree(outline.tree, nodeId, head, tail, parsed)`。
   - 把焦点/光标落到 `lastId` 对应 textarea 的末尾（沿用组件里已有的聚焦机制）。

## 数据流

```
onpaste → 判定是否拦截
        → parseClipboardOutline(text)          // 纯解析
        → insertPastedTree(tree, ...)           // 改 outline.tree.nodes
        → Svelte 响应式重渲染
        → 聚焦最后一个新建节点
```

## 错误 / 边界处理

- 解析结果为空或仅 1 行 → 不拦截，退回原生。
- 混合 Tab/空格缩进：由缩进栈按"比栈顶深就进一层、相等回到该层"归一，避免因步长不一算错层级。
- 有序列表 `1.` / `2.`：剥标记只留文本（与现有 `parseOutline` 剥 `- ` 行为一致）。
- 当前节点**已有子节点**且粘贴含 `depth >= 1`：新子追加到现有子的**末尾**（可预测、不穿插）。
- **光标在节点文本中间**粘贴：`tail` 追加到最后一个新建节点末尾——符合"光标停在粘贴内容之后"的直觉；此为默认，绝大多数粘贴发生在空节点或行尾，只影响罕见的行中粘贴。

## 测试

- `src/lib/outline/paste.test.ts`：单测 `parseClipboardOutline`，覆盖
  - Markdown 列表（`-` / `*` / `+`）多层缩进
  - 空格缩进纯文本（2 空格、4 空格）
  - Tab 缩进
  - 混合 Tab/空格
  - 有序列表 `1.`
  - 多行无缩进 = 全平级
  - 含空行的输入
- `src/lib/outline/commands.test.ts`（或新增测试文件，沿用现有 recall/commands 测试风格）：`insertPastedTree`
  - Option A 首行并入当前节点
  - depth → parentId 映射正确
  - order 递增、渲染顺序正确
  - tail 追加到末节点
  - 当前节点已有子节点时新子追加到末尾
- 无需 GUI 实机验证（纯逻辑 + textarea 事件）；实现后补一条手动冒烟说明（从 Logseq/纯文本各粘一段）。

## 非目标（YAGNI）

- 不处理富文本/HTML 剪贴板转大纲（只吃 `text/plain`）。
- 不做粘贴时的 wikilink/属性（`type::` 等）识别——粘进来的都是 `manual` 节点纯文本。
- 不改动主编辑器（RichEditor/SourceView）的粘贴逻辑。
