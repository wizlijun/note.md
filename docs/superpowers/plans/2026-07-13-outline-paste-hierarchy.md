# 大纲粘贴解析多层次节点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在大纲里往一个节点粘贴多行文本时，解析其层次结构并以多层次节点的形式插入，而非把整段连换行塞进单个节点。

**Architecture:** 三个隔离单元——(1) 纯函数 `parseClipboardOutline`（新文件 `paste.ts`，缩进栈算法把任意缩进/列表标记归一成离散层级）；(2) 命令 `insertPastedTree`（`commands.ts`，按 Option A 把解析结果挂进现有 `OutlineTree`）；(3) `OutlineNode.svelte` 的 textarea `onpaste` 接线（判定拦截条件后调用前两者）。

**Tech Stack:** TypeScript + Svelte 5 (runes) + Vitest。大纲用原生 `<textarea>`，节点扁平存于 `OutlineTree.nodes: Map`，靠 `parentId` + 浮点 `order` 建层级。

**Spec:** `docs/superpowers/specs/2026-07-13-outline-paste-hierarchy-design.md`

---

## File Structure

- **Create** `src/lib/outline/paste.ts` — 纯解析函数 `parseClipboardOutline` + 类型 `ParsedPasteNode`。单一职责：文本 → 层级列表。
- **Create** `src/lib/outline/paste.test.ts` — `parseClipboardOutline` 单测。
- **Modify** `src/lib/outline/commands.ts` — 追加 `insertPastedTree`（挂载逻辑，复用现有 `childrenOf`/`calculateOrderBetween`/`newId`/`nowIso`/`setNodeContent`）。
- **Modify** `src/lib/outline/commands.test.ts` — 追加 `insertPastedTree` 测试。
- **Modify** `src/components/outline/OutlineNode.svelte` — textarea 加 `onpaste` handler + import。

---

## Task 1: 解析函数 parseClipboardOutline

**Files:**
- Create: `src/lib/outline/paste.ts`
- Test: `src/lib/outline/paste.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/outline/paste.test.ts`:

```ts
// src/lib/outline/paste.test.ts
import { describe, it, expect } from 'vitest'
import { parseClipboardOutline } from './paste'

describe('parseClipboardOutline', () => {
  it('markdown list with 2-space indent → depths', () => {
    const r = parseClipboardOutline('- A\n  - B\n  - C\n- D')
    expect(r).toEqual([
      { depth: 0, content: 'A' },
      { depth: 1, content: 'B' },
      { depth: 1, content: 'C' },
      { depth: 0, content: 'D' },
    ])
  })

  it('strips *, + and numbered markers', () => {
    const r = parseClipboardOutline('* A\n+ B\n1. C\n2) D')
    expect(r.map(n => n.content)).toEqual(['A', 'B', 'C', 'D'])
    expect(r.every(n => n.depth === 0)).toBe(true)
  })

  it('space-indented plain text (no markers)', () => {
    const r = parseClipboardOutline('A\n    B\n        C\n    D')
    expect(r).toEqual([
      { depth: 0, content: 'A' },
      { depth: 1, content: 'B' },
      { depth: 2, content: 'C' },
      { depth: 1, content: 'D' },
    ])
  })

  it('tab-indented plain text (workflowy-style)', () => {
    const r = parseClipboardOutline('A\n\tB\n\t\tC\n\tD')
    expect(r.map(n => n.depth)).toEqual([0, 1, 2, 1])
    expect(r.map(n => n.content)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('mixed tab/space at same visual width collapse to same depth', () => {
    // tab = 4 spaces
    const r = parseClipboardOutline('A\n\tB\n    C')
    expect(r.map(n => n.depth)).toEqual([0, 1, 1])
  })

  it('multi-line with no indentation → all siblings (depth 0)', () => {
    const r = parseClipboardOutline('one\ntwo\nthree')
    expect(r.map(n => n.depth)).toEqual([0, 0, 0])
  })

  it('skips blank lines', () => {
    const r = parseClipboardOutline('- A\n\n  - B\n   \n- C')
    expect(r.map(n => n.content)).toEqual(['A', 'B', 'C'])
    expect(r.map(n => n.depth)).toEqual([0, 1, 0])
  })

  it('normalizes CRLF and lone CR', () => {
    const r = parseClipboardOutline('A\r\n  B\rC')
    expect(r.map(n => n.content)).toEqual(['A', 'B', 'C'])
    expect(r.map(n => n.depth)).toEqual([0, 1, 0])
  })

  it('whole block indented → first line normalized to depth 0', () => {
    const r = parseClipboardOutline('    - A\n      - B')
    expect(r).toEqual([
      { depth: 0, content: 'A' },
      { depth: 1, content: 'B' },
    ])
  })

  it('empty / whitespace-only input → []', () => {
    expect(parseClipboardOutline('')).toEqual([])
    expect(parseClipboardOutline('   \n\n')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/outline/paste.test.ts`
Expected: FAIL — `Failed to resolve import "./paste"` / `parseClipboardOutline is not a function`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/outline/paste.ts`:

```ts
// src/lib/outline/paste.ts
// 把剪贴板纯文本解析成扁平的层级列表（缩进栈算法，depth 0-based）。
// 覆盖：Markdown 列表(-/*/+/数字.)、空格缩进、Tab 缩进、多行无缩进=平级。

export interface ParsedPasteNode {
  depth: number
  content: string
}

const TAB_WIDTH = 4
/** 行首空白 + 列表标记(-,*,+ 或 1./1)) + 至少一个空格 + 正文 */
const LIST_MARKER = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/
/** 行首空白 + 正文（无标记时兜底，永远匹配） */
const INDENT_ONLY = /^(\s*)(.*)$/

function indentWidth(ws: string): number {
  let w = 0
  for (const ch of ws) w += ch === '\t' ? TAB_WIDTH : 1
  return w
}

export function parseClipboardOutline(text: string): ParsedPasteNode[] {
  const rawLines = text.split(/\r\n|\r|\n/)
  const items: { width: number; content: string }[] = []
  for (const line of rawLines) {
    if (line.trim() === '') continue
    const m = LIST_MARKER.exec(line)
    if (m) {
      items.push({ width: indentWidth(m[1]), content: m[2] })
    } else {
      const mm = INDENT_ONLY.exec(line)!
      items.push({ width: indentWidth(mm[1]), content: mm[2] })
    }
  }
  if (items.length === 0) return []

  const out: ParsedPasteNode[] = []
  const stack: number[] = [] // 缩进宽度栈，升序
  for (const it of items) {
    while (stack.length > 0 && it.width < stack[stack.length - 1]) stack.pop()
    if (stack.length === 0 || it.width > stack[stack.length - 1]) stack.push(it.width)
    // 走到这里栈顶宽度 == it.width（相等或刚压入）
    out.push({ depth: stack.length - 1, content: it.content })
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/outline/paste.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/paste.ts src/lib/outline/paste.test.ts
git commit -m "feat(outline): parseClipboardOutline — clipboard text → hierarchy list"
```

---

## Task 2: 插入命令 insertPastedTree

**Files:**
- Modify: `src/lib/outline/commands.ts`
- Test: `src/lib/outline/commands.test.ts`

挂载语义（Option A）：`parsed[0]` 并入当前节点；`parsed[1..]` 按相对 depth 建节点，`depth 0` 为当前节点的兄弟（紧跟其后、在其原下一个兄弟之前），`depth d>=1` 挂到 `levelStack[d-1]` 之下（追加到该父现有子的末尾）；`tail`（光标后文本）追加到最后一个新建节点末尾。

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/outline/commands.test.ts` (add `insertPastedTree` to the existing import from `./commands`, add `ParsedPasteNode`-shaped literals inline, and add these `describe` blocks at end of file):

First extend the import line at top of the file:

```ts
import {
  createSiblingBelow, createSiblingAbove, indentNode, outdentNode,
  moveNodeUp, moveNodeDown, mergeWithPrevious, applyInlineWrap,
  subtreeToMarkdown, deleteNodes, indentNodes, outdentNodes, moveNodesAfter, moveNodesToChild, nodesToMarkdown,
  insertPastedTree,
} from './commands'
```

Then append:

```ts
describe('insertPastedTree (paste hierarchy)', () => {
  // helper: 树按可见序返回 [content, depth]
  function flat(t: OutlineTree) {
    const out: Array<{ content: string; depth: number }> = []
    const walk = (pid: string | null, depth: number) => {
      for (const n of childrenOf(t, pid)) { out.push({ content: n.content, depth }); walk(n.id, depth + 1) }
    }
    walk(null, 0)
    return out
  }

  it('first line merges into current node; rest attach by relative depth', () => {
    const t = manualTree() // roots: a(''=>'A'), b('B') with child b1
    const parsed = [
      { depth: 0, content: 'X0' },
      { depth: 1, content: 'X1' },
      { depth: 0, content: 'X2' },
    ]
    insertPastedTree(t, 'a', '', '', parsed)
    // a becomes 'X0'; X1 is a's child; X2 is a's sibling (after a, before b)
    expect(t.nodes.get('a')!.content).toBe('X0')
    expect(flat(t)).toEqual([
      { content: 'X0', depth: 0 },
      { content: 'X1', depth: 1 },
      { content: 'X2', depth: 0 },
      { content: 'B', depth: 0 },
      { content: 'B1', depth: 1 },
    ])
  })

  it('head is preserved before first pasted line', () => {
    const t = manualTree()
    insertPastedTree(t, 'a', 'HEAD ', '', [{ depth: 0, content: 'first' }, { depth: 0, content: 'second' }])
    expect(t.nodes.get('a')!.content).toBe('HEAD first')
  })

  it('tail is appended to the last created node', () => {
    const t = manualTree()
    const lastId = insertPastedTree(t, 'a', '', ' TAIL', [
      { depth: 0, content: 'p0' },
      { depth: 1, content: 'p1' },
    ])
    expect(t.nodes.get(lastId)!.content).toBe('p1 TAIL')
  })

  it('deeper nodes append AFTER current node existing children', () => {
    const t = manualTree() // b already has child b1
    insertPastedTree(t, 'b', '', '', [
      { depth: 0, content: 'B*' },
      { depth: 1, content: 'newkid' },
    ])
    const kids = childrenOf(t, 'b').map(n => n.content)
    expect(kids).toEqual(['B1', 'newkid']) // existing B1 stays first
  })

  it('returns currentNodeId and only sets content when parsed has a single line', () => {
    const t = manualTree()
    const ret = insertPastedTree(t, 'a', 'H', 'T', [{ depth: 0, content: 'solo' }])
    expect(ret).toBe('a')
    expect(t.nodes.get('a')!.content).toBe('HsoloT')
    expect(childrenOf(t, null).map(n => n.id)).toEqual(['a', 'b']) // no new nodes
  })

  it('new nodes are manual with createdAt', () => {
    const t = manualTree()
    const lastId = insertPastedTree(t, 'a', '', '', [{ depth: 0, content: 'p0' }, { depth: 0, content: 'p1' }])
    const n = t.nodes.get(lastId)!
    expect(n.source).toBe('manual')
    expect(typeof n.createdAt).toBe('string')
  })

  it('multiple same-depth siblings keep paste order and precede original next sibling', () => {
    const t = manualTree()
    insertPastedTree(t, 'a', '', '', [
      { depth: 0, content: 's0' },
      { depth: 0, content: 's1' },
      { depth: 0, content: 's2' },
    ])
    expect(childrenOf(t, null).map(n => n.content)).toEqual(['s0', 's1', 's2', 'B'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/outline/commands.test.ts`
Expected: FAIL — `insertPastedTree is not exported` / `is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/outline/commands.ts` (after `subtreeToMarkdown`, before the `// ---------- 批量操作` section). Also add `ParsedPasteNode` import at top:

Add to the top import block (the `import { ... } from './model'` stays; add a new import line below it):

```ts
import type { ParsedPasteNode } from './paste'
```

Then the function:

```ts
/**
 * 粘贴解析后的层级列表挂进大纲（spec 2026-07-13 Option A）。
 * - parsed[0] 并入当前节点：content = head + parsed[0].content
 * - parsed[1..] 按相对 depth：depth 0 = 当前节点的兄弟（紧跟其后），
 *   depth d>=1 = levelStack[d-1] 之下（追加到该父现有子末尾）
 * - tail 追加到最后一个新建节点末尾
 * 返回最后一个受影响节点 id（用于落焦点）。
 */
export function insertPastedTree(
  tree: OutlineTree,
  currentNodeId: string,
  head: string,
  tail: string,
  parsed: ParsedPasteNode[],
): string {
  const cur = tree.nodes.get(currentNodeId)
  if (!cur || parsed.length === 0) return currentNodeId

  // 单行：并入当前节点，无新节点
  if (parsed.length < 2) {
    setNodeContent(cur, head + parsed[0].content + tail)
    return currentNodeId
  }

  setNodeContent(cur, head + parsed[0].content)

  // levelStack[d] = 该 depth 最近建出的节点 id；index 0 = 当前节点
  const levelStack: string[] = [currentNodeId]
  // 每个父节点的排序游标：{ prev: 上一个已放子节点 order, next: 固定上界 }
  const cursor = new Map<string | null, { prev: number | null; next: number | null }>()
  let lastCreated = currentNodeId

  for (let i = 1; i < parsed.length; i++) {
    const d = parsed[i].depth
    const parentId = d === 0 ? cur.parentId : levelStack[Math.min(d, levelStack.length) - 1]

    if (!cursor.has(parentId)) {
      if (d === 0) {
        // 当前节点的新兄弟：插到 cur 之后、cur 原下一个兄弟之前
        const sibs = childrenOf(tree, parentId)
        const idx = sibs.findIndex(s => s.id === cur.id)
        const nb = idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1] : null
        cursor.set(parentId, { prev: cur.order, next: nb ? nb.order : null })
      } else {
        // 更深层：追加到父现有子的末尾（父多为刚建出的空节点）
        const kids = childrenOf(tree, parentId)
        cursor.set(parentId, { prev: kids.length ? kids[kids.length - 1].order : null, next: null })
      }
    }
    const c = cursor.get(parentId)!
    const order = calculateOrderBetween(c.prev, c.next)
    const node: OutlineNode = {
      id: newId(), parentId, order,
      content: parsed[i].content, collapsed: false, source: 'manual', createdAt: nowIso(),
    }
    tree.nodes.set(node.id, node)
    c.prev = order

    // 维护 levelStack：本层记为该节点，截断更深层
    levelStack[d] = node.id
    levelStack.length = d + 1
    lastCreated = node.id
  }

  if (tail) {
    const last = tree.nodes.get(lastCreated)!
    setNodeContent(last, last.content + tail)
  }
  return lastCreated
}
```

Note: `levelStack[Math.min(d, levelStack.length) - 1]` 防御性处理"depth 跳级"（解析理论上不会产生跳级，但保证父一定存在）。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/outline/commands.test.ts`
Expected: PASS (new `insertPastedTree` block + all pre-existing tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/commands.ts src/lib/outline/commands.test.ts
git commit -m "feat(outline): insertPastedTree — attach parsed hierarchy (Option A)"
```

---

## Task 3: textarea onpaste 接线

**Files:**
- Modify: `src/components/outline/OutlineNode.svelte`

无单元测试（Svelte 组件 + clipboard 事件不易单测）；靠 `pnpm check` 类型校验 + Task 4 手动冒烟。

- [ ] **Step 1: Add imports**

In `src/components/outline/OutlineNode.svelte`, extend the two relevant imports.

Add `insertPastedTree` to the commands import (currently ends at `indentNode, outdentNode, moveNodeUp, moveNodeDown, applyInlineWrap,`):

```ts
  import {
    createSiblingBelow, createSiblingAbove, mergeWithPrevious,
    indentNode, outdentNode, moveNodeUp, moveNodeDown, applyInlineWrap,
    insertPastedTree,
  } from '../../lib/outline/commands'
  import { parseClipboardOutline } from '../../lib/outline/paste'
```

- [ ] **Step 2: Add the onpaste handler function**

In the `<script>` block, add this function next to `onKeydown` (e.g. right after the `onKeydown` function closes, before the drag section):

```ts
  function onPaste(e: ClipboardEvent) {
    if (node.source !== 'manual') return            // 只在手写节点上解析
    const cd = e.clipboardData
    if (!cd) return
    const text = cd.getData('text/plain')
    if (!text || !/\r|\n/.test(text)) return         // 单行/无文本 → 原生
    const el = e.currentTarget as HTMLTextAreaElement
    if (el.selectionStart !== el.selectionEnd) return // 有选区 → 原生
    const parsed = parseClipboardOutline(text)
    if (parsed.length < 2) return                     // 不构成层次 → 原生
    e.preventDefault()
    const head = el.value.slice(0, el.selectionStart)
    const tail = el.value.slice(el.selectionStart)
    el.value = head + parsed[0].content               // 同步 el.value，避免 blur 用旧值回写
    const lastId = insertPastedTree(outline.tree, node.id, head, tail, parsed)
    bump(); markDirty(); focusNode(lastId)
  }
```

- [ ] **Step 3: Wire onpaste onto the textarea**

Add `onpaste={onPaste}` to the `<textarea>` element (alongside `onkeydown={onKeydown}`):

```svelte
      <textarea
        bind:this={textareaEl}
        class="content edit"
        class:hl={node.source === 'highlight' || markLike}
        class:src-toc={node.source === 'toc'}
        rows="1"
        value={content}
        onbeforeinput={(e) => { if (!editable) e.preventDefault() }}
        onblur={(e) => commitEdit((e.currentTarget as HTMLTextAreaElement).value)}
        onkeydown={onKeydown}
        onpaste={onPaste}
        oninput={(e) => {
          const el = e.currentTarget as HTMLTextAreaElement
          el.style.height = 'auto'
          el.style.height = el.scrollHeight + 'px'
          onEditorInput(node, el.value, el.selectionStart, el)
        }}
      ></textarea>
```

- [ ] **Step 4: Type-check**

Run: `pnpm check`
Expected: no new errors from `OutlineNode.svelte` / `paste.ts` / `commands.ts` (pre-existing unrelated warnings, if any, unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/components/outline/OutlineNode.svelte
git commit -m "feat(outline): parse pasted hierarchy into multi-level nodes on paste"
```

---

## Task 4: 全量校验 + 手动冒烟

**Files:** none (verification only)

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: PASS (all suites green, including new `paste.test.ts` and extended `commands.test.ts`).

- [ ] **Step 2: Type-check whole project**

Run: `pnpm check`
Expected: no new errors introduced by this change.

- [ ] **Step 3: Manual smoke (record result, do not skip)**

Start dev (`pnpm tauri dev` or the project's usual dev entry), open a `.note.md` outline, then:
1. 复制一段 **Markdown 列表**（`- A` / 缩进 `  - B`），点进一个空节点粘贴 → 应展开成多层节点，首行入当前节点。
2. 从纯文本编辑器复制一段 **Tab 缩进**文本粘贴 → 应按 Tab 层级展开。
3. 在一个已有文字的节点**行尾**粘贴多行 → 首行接在原文后，其余成节点；节点**行中**粘贴 → 尾巴文本落到最后一个新节点末尾。
4. 粘贴**单行**文本 → 仍是原生行为（不拆节点）。
5. 选中一段文字后粘贴 → 原生替换（不拆节点）。

Record pass/fail for each in the completion summary.

---

## Self-Review Notes

- **Spec coverage:** 四种识别格式 → Task 1 测试逐一覆盖；Option A 挂载 + tail → Task 2；三种不拦截条件（单行/有选区/非纯文本）→ Task 3 handler 前置判断 + Task 4 冒烟 4/5；已有子节点追加到末尾 → Task 2 测试 `deeper nodes append AFTER...`。
- **Type consistency:** `ParsedPasteNode { depth, content }` 在 `paste.ts` 定义，`commands.ts` / test / svelte 全部按此形状使用；`insertPastedTree(tree, currentNodeId, head, tail, parsed): string` 签名三处一致。
- **No placeholders:** 所有步骤含完整代码/命令与预期输出。
