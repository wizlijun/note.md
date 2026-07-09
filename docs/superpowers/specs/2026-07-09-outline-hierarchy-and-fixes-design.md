# Outline — H2/H3 层级派生 + 高亮下划线 + 自适应图标 + 折叠修复（v6）— Design

**Date:** 2026-07-09
**Status:** Approved，待实现
**关联:** 修订 [2026-07-09-outline-highlights-only-design.md](./2026-07-09-outline-highlights-only-design.md)
的派生与高亮样式；承接独立列/主题探针工作。

## Summary

四项调整，均在大纲派生（`derive.ts`）与节点组件（`OutlineNode.svelte`）内：

1. **D1 派生改用 H2/H3 层级、跳过 H1**：高亮挂到其最近的子标题（H2–H6）路径下，
   H1 不再作为节点；只输出“通往高亮”的标题路径。
2. **D2 高亮样式**：黄底 → 黄色下划线。
3. **D3 前导图标自适应**：折叠三角 + 圆点尺寸随主题字号/行高缩放。
4. **D4 折叠失效修复**：collapse 的 reactivity bug。

---

## D1 — H2/H3 层级派生，跳过 H1

**文件：** `src/lib/outline/derive.ts`、`src/lib/outline/derive.test.ts`

重写 `deriveAutoItems`：

- 保留 frontmatter / 围栏代码跳过。
- **H1（`^#\s`，level 1）跳过**：不输出节点；遇到 H1 时**清空**当前子标题栈。
- 维护 H2–H6 的相对层级栈 `stack`（元素含 `level / content / anchorLine / emitted`）。
  遇标题级别 L（2–6）：`while stack.length && stack.top.level >= L: pop`，再
  `push({ level: L, content, anchorLine, emitted: false })`。
- 遇高亮（`HIGHLIGHT_RE`，`^^..^^` 与 `==..==`，去标记取内文）：
  - **惰性补齐路径**：对 `stack` 从浅到深，凡 `!emitted` 者输出
    `{ source:'toc', content, depth: <栈内下标>, anchorLine }` 并置 `emitted=true`。
  - 再输出 `{ source:'highlight', content, depth: stack.length, anchorLine }`。
  - `stack` 为空 → 高亮 `depth 0`、无父。
- **只输出通往高亮的标题路径**：无高亮子树的标题永不输出（因为只在高亮触发时惰性补齐）。
- 深度语义：H2 = depth 0，H3 = depth 1，…；对应高亮 = 栈深。

`AutoItem` 接口不变。`sync.ts` 的 `parentStack`（按 `it.depth` 建父子）天然兼容新序列，
**不改** sync.ts / store.ts / markdown.ts。

**derive.test.ts 用例：**
- H1 跳过：`# T / ## A / ^^x^^` → `[toc A d0, hl x d1]`（无 T）。
- 相对嵌套：`## A / ### A1 / ^^x^^` → `[toc A d0, toc A1 d1, hl x d2]`。
- 只出通往高亮的标题：`## A / text / ## B / ^^x^^` → `[toc B d0, hl x d1]`（A 不出）。
- 祖先因子孙含高亮而出现：`## B / ### B1 / ^^x^^` → `[toc B d0, toc B1 d1, hl x d2]`。
- 同一标题多个高亮：标题只输出一次。
- 新 H1 重置栈：`# A / ## X / ^^x^^ / # B / ^^y^^` →
  `[toc X d0, hl x d1, hl y d0]`（y 在 B 段、无 H2 → d0 无父）。
- 栈空高亮（任何标题前）→ d0 无父。
- 无高亮文档 → `[]`。
- frontmatter / 围栏跳过；`a==b` 噪声不误判；一行多高亮按序。

---

## D2 — 高亮黄色下划线

**文件：** `src/components/outline/OutlineNode.svelte`

`.content.hl, textarea.hl` 规则：去掉 `background` 与 `border-radius`，改为：

```css
  .content.hl,
  textarea.hl {
    text-decoration: underline;
    text-decoration-color: var(--highlight-underline, #e0a500);
    text-decoration-thickness: 2px;
    text-underline-offset: 2px;
  }
```

渲染视图（`<span class="content">`）与只读 textarea 一致。（InlineRender 内 `<mark>`
用于手写内容里的 `^^`，与高亮节点无关，不动。）

---

## D3 — 前导图标随字号/行高自适应

**文件：** `src/components/outline/OutlineNode.svelte`

固定 px → 相对 `--outline-font-size`（em）+ `--outline-line-height` 对齐首行：

```css
  .tri {
    background: none; border: none; padding: 0;
    width: 1.1em; font-size: 0.7em;
    line-height: var(--outline-line-height, 1.5);
    cursor: pointer; opacity: 0.6; transition: transform 0.1s;
  }
  .tri.closed { transform: rotate(-90deg); }
  .tri-spacer { width: 1.1em; flex-shrink: 0; }
  .bullet {
    font-size: 1em;
    line-height: var(--outline-line-height, 1.5);
    cursor: pointer; opacity: 0.7;
  }
```

`.row` 的 `align-items` 保持 `flex-start`；三角/圆点靠各自 `line-height` 与首行对齐。
字号/行高变化 → 前导图标同步缩放。（`.bullet.src-toc/.src-hl` 着色规则保留。）

---

## D4 — 折叠失效修复（reactivity）

**文件：** `src/components/outline/OutlineNode.svelte`

**根因：** 非搜索态 `{#if visibleIds ? kids.length > 0 : !node.collapsed}` 的实际依赖只有
普通对象属性 `node.collapsed`（Svelte 不追踪其变更）与 `visibleIds`；`bump()`（`outline.version++`）
未被该 `{#if}` 读取（`kids` 分支被三元短路），故折叠不触发重渲染。`class:closed={node.collapsed}`
同样不响应。

**修法：** 引入读 `outline.version` 的派生，与既有 `kids` 派生同款模式：

```svelte
  let isCollapsed = $derived.by(() => { void outline.version; return node.collapsed })
  let showChildren = $derived.by(() => {
    void outline.version
    return visibleIds ? kids.length > 0 : !node.collapsed
  })
```

- 三角：`<button class="tri" class:closed={isCollapsed} ...>`
- 子节点渲染：`{#if showChildren}`

toggle 逻辑 `node.collapsed = !node.collapsed; bump(); markDirty()` 不变；bump 现在
驱动 `isCollapsed`/`showChildren` 重算。

---

## 影响文件

| 文件 | 改动 |
|---|---|
| `src/lib/outline/derive.ts` | 重写：H2/H3 层级、跳过 H1、只出通往高亮的路径 |
| `src/lib/outline/derive.test.ts` | 重写用例 |
| `src/components/outline/OutlineNode.svelte` | 高亮下划线、图标 em/行高自适应、折叠 reactivity 修复 |

不改：`sync.ts`、`store.svelte.ts`、`markdown.ts`、`gate.svelte.ts`、`OutlinePanel.svelte`。

## 测试与验证

- `derive.test.ts`：见 D1 用例清单（纯 TS，vitest）。
- **dev 实机验证**（吸取 v4.1–4.2 教训，见 [[reference-dev-gui-verification]]）：
  - 折叠三角能收合/展开子节点、箭头旋转正确。
  - 高亮显示为黄色下划线（非黄底）。
  - 调整主题字号/行高 → 三角与圆点同步缩放、对齐。
  - 含 `## / ###` + 高亮的文档：H1 不出现，只显示通往高亮的 H2/H3 路径 + 高亮。
