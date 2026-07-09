# Outline — 高亮优先派生 + 只读可聚焦交互（v5）— Design

**Date:** 2026-07-09
**Status:** Approved，待实现
**关联:** 承接 [2026-07-09-outline-independent-view-design.md](./2026-07-09-outline-independent-view-design.md)，
修订其派生（derive）与节点编辑交互部分。

## 背景 / 问题

当前 `deriveAutoItems` 把**全部标题（TOC）+ 全部高亮**都派生进大纲树，且
`scheduleSyncFromMain` 每次派生都 `markDirty()`，导致：打开任一含标题的文档就把
整份 TOC 计算进大纲并写出 `.notes.md` —— note 创建「太积极」。

用户要求：默认**只处理高亮**；高亮按其所属**顶层 H1** 分组（H1 作只读上下文）；
TOC 只读、高亮在大纲中保持**标黄**显示；只读节点**允许落光标、禁止改字、回车可
建下一节点**。

## 决策（已确认）

1. **TOC 分组粒度：仅顶层 H1。** 高亮挂到其上方最近的 `#` 一级标题；`##`+ 忽略。
2. **落盘：有高亮就写。** 纯 TOC / 无高亮 → 不派生、不写盘。
3. **只读节点回车：** 在其下方建**同级手写兄弟**（`source:'manual'`）。
4. **跳转原文：** 点击 bullet 圆点跳转；点击文字 = 落光标。

---

## D1 — 派生只处理高亮 + 顶层 H1 分组

**文件：** `src/lib/outline/derive.ts`、`src/lib/outline/derive.test.ts`

重写 `deriveAutoItems`：

- 保留 frontmatter（`---`…`---`）与围栏代码（```/~~~）跳过逻辑。
- 只识别 `#`（level 1）标题作为「当前 H1」上下文；`##`–`######` **忽略**
  （既不输出、也不改变当前 H1）。
- 扫描高亮（`HIGHLIGHT_RE` 同现状，匹配 `^^..^^` 与 `==..==`）。对每个高亮：
  - 若存在「当前 H1」且该 H1 尚未输出，先输出一条
    `{ source:'toc', content:<H1 文本>, depth:0, anchorLine:<H1 行> }`（每个 H1 至多一次）。
  - 再输出 `{ source:'highlight', content:<高亮内文，去标记>, depth:(有 H1 ? 1 : 0), anchorLine:<高亮行> }`。
- **没有任何高亮的 H1 不输出。** H1 之前出现的高亮 → depth 0、无父。
- 弃用原 `levelStack`（整段标题相对层级）。

`AutoItem` 接口不变（`source/content/depth/anchorLine`）。

`derive.test.ts` 重写为如下用例：

- 高亮挂到所属 H1 下（H1 先出、depth0，高亮 depth1）。
- 多个高亮共享同一 H1：H1 只输出一次。
- `##`/`###` 被忽略：其下高亮仍挂到上层 H1。
- 无高亮的 H1 不出现（纯标题文档 → 空数组）。
- H1 之前的高亮 → depth 0、无 toc。
- frontmatter 与围栏代码跳过。
- `a==b` 噪声不误判（保留 `(?<![\w=])==…==(?![\w=])` 语义）。
- 一行多个高亮按序输出。

---

## D2 — 高亮标黄显示

**文件：** `src/components/outline/OutlineNode.svelte`

- highlight 节点内容存**纯文本**（不含 `^^`/`==` 标记，与现状一致）。
- 给 `node.source === 'highlight'` 的内容加黄底：
  - 非编辑视图 `<span class="content">`：加 `class:hl={node.source === 'highlight'}`。
  - 只读 textarea（见 D3）同样加该类。
  - CSS：`.content.hl, textarea.hl { background: var(--highlight-bg, #fde68a); border-radius: 2px; }`
- TOC 节点无底色。既有 `.bullet.src-hl` / `.bullet.src-toc` 圆点着色保留。

---

## D3 — 只读节点可聚焦（光标 / 回车 / bullet 跳转）

**文件：** `src/components/outline/OutlineNode.svelte`

现状：`startEdit()` 对 `source !== 'manual'` 直接 `onJump`；auto 节点不可聚焦；
bullet 仅 manual 可拖拽。

改为：

- **点击文字（`.content`）** → `startEdit()` 无条件设 `outline.editingId = node.id`
  （不再对 auto 分支跳转）。
- **编辑态渲染：** textarea 增加 `readonly={node.source !== 'manual'}`。
  auto 节点得到可见光标但无法改字；manual 节点照旧可编辑。
  highlight 的 textarea 加 `hl` 类（黄底）。
- **回车（Enter，无 shift/meta/ctrl）** 在 `onKeydown` 中：
  - manual：维持现有「行首建上兄弟 / 否则建下兄弟」逻辑。
  - auto（readonly）：`createSiblingBelow(outline.tree, node.id)` → `bump(); markDirty();
    focusNode(newId)`（同级手写兄弟，立即可编辑）。不写回 auto 内容。
- **bullet 圆点点击跳转：** `.bullet` 加 `onclick`：`if (node.anchorLine != null) onJump(node)`。
  （拖拽仍限 manual；点击不触发拖拽。）auto 与 manual 通用，manual 无 anchorLine → no-op。
- **失焦 `commitEdit`：** auto 节点仅清 `editingId`，**不写 content、不 markDirty**
  （readonly，内容未变）；manual 照旧。
- 其余键：readonly 天然拦截字符输入；`mergeWithPrevious`/`indentNode`/`outdentNode`/
  `applyInlineWrap` 对非 manual 已内部返回 false/no-op，无需改。
- ArrowUp/Down 跨节点导航逻辑保留（auto 节点参与）。

---

## D4 — 落盘规则（有高亮就写）

**文件：** 无需改（沿用 v4 的 `isEffectivelyEmpty` 护栏）。

- `isEffectivelyEmpty(tree)`：无 auto 节点且所有 manual 节点为空 → true → `flushSave` 跳过。
- 含高亮 → 树有 auto 节点 → 非空 → 正常写盘（H1 + 高亮以 `type::/line::` 序列化；
  带 manual 子节点的 auto 节点触发 `id::`）。
- 无高亮文档 → 派生空 → 树空 → 不写 `.notes.md`（解决「太积极」）。
- `scheduleSyncFromMain` 仍 `markDirty()`：现在仅在有高亮时才产生实际写盘，符合「有高亮就写」。

---

## 影响文件

| 文件 | 改动 |
|---|---|
| `src/lib/outline/derive.ts` | 重写：仅高亮 + 顶层 H1 分组 |
| `src/lib/outline/derive.test.ts` | 重写用例 |
| `src/components/outline/OutlineNode.svelte` | 只读可聚焦 textarea、回车建同级兄弟、bullet 跳转、highlight 黄底、auto 失焦不脏 |

不改：`sync.ts`（既有 depth/parentStack + reparentOrphans 兼容更稀疏的 auto 序列）、
`store.svelte.ts`、`markdown.ts`、`gate.svelte.ts`、`OutlinePanel.svelte`（v4 的独立列/主题
探针/图标不动）。

## 测试

- `derive.test.ts`：见 D1 用例清单（纯 TS，vitest）。
- 手动验证（跑起来）：
  - 打开无高亮文档 → 大纲空、磁盘无 `.notes.md`。
  - 打开含 `^^..^^`/`==..==` 文档 → 仅显示含高亮的 H1（只读）+ 其下高亮（黄底）；
    磁盘出现 `.notes.md`。
  - `##` 下的高亮挂到上层 H1。
  - 点高亮文字 → 出现光标、打字无效；回车 → 下方多一个可编辑手写兄弟。
  - 点 bullet 圆点 → 跳转到原文对应行。
  - manual 节点仍可正常编辑/缩进/拖拽。
