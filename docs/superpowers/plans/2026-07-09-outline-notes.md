# Outline Notes（大纲笔记插件）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 mdeditor 增加 builtin 前端插件 "Outline Notes"：右侧 Outliner View 面板，TOC/`^^高亮^^` 实时同步 + 手写大纲 + 反向跳转，存伴生文件 `<stem>.notes.md`，永不改原文。

**Architecture:** 纯逻辑放 `src/lib/outline/`（每文件配 vitest），UI 放 `src/components/outline/`；经 `import()` 懒加载，关闭插件零资源。集成模式完全照抄 folder-view builtin 插件（manifest + plugins.enabled + dispatchPlugin 拦截 + Store 持久化）。

**Tech Stack:** Svelte 5 (runes)、TypeScript、vitest、@tauri-apps/plugin-fs、Tauri Store (`settings.json`)。

**Spec:** `docs/superpowers/specs/2026-07-09-outline-notes-design.md`  
**移植来源:** `/Users/bruce/git/hulunote/hulunote`（`src/cljs/hulunote/` 下 render.cljs / db.cljs / parser.cljc / shortcuts.cljs / single_note.cljs）

**约定（全计划通用）:**

- 测试命令：`pnpm vitest run src/lib/outline/<file>.test.ts`；全量 `pnpm test`；类型检查 `pnpm check`。
- 提交频率：每个 Task 至少一次 commit，消息前缀 `feat(outline):` / `test(outline):`。
- 所有新增 i18n key 必须同时加到 `src/lib/i18n/en.ts`、`zh.ts`、`ja.ts`（Messages 是同构类型，缺一个编不过）。

---

## File Map（全部新增/修改文件）

**新增：**

```
src-tauri/plugins/outline-notes/manifest.json    builtin 插件清单
src/lib/outline/gate.svelte.ts                   轻量门面：enabled/visible/width 状态+持久化（App 直接 import，不拉重模块）
src/lib/outline/model.ts        节点树模型 + 分数排序          ← hulunote db.cljs + render.cljs 559-648
src/lib/outline/markdown.ts     伴生文件 ↔ 树 双向转换
src/lib/outline/parser.ts       hulunote 行内文法 → AST        ← parser.cljc
src/lib/outline/derive.ts       主文 md → auto 节点序列（toc/highlight + anchorLine）
src/lib/outline/sync.ts         diff 匹配保 id + 手写子树重挂 + 重新生成
src/lib/outline/commands.ts     结构编辑命令                    ← render.cljs 806-989、1003-1027
src/lib/outline/shortcuts.ts    快捷键引擎                      ← shortcuts.cljs
src/lib/outline/backlinks.ts    文件夹级 [[链接]]/#标签 索引
src/lib/outline/completion.ts   / 菜单项 + [[ 补全过滤          ← render.cljs 60-260
src/lib/outline/store.svelte.ts 面板运行时状态：树、编辑焦点、脏标记、加载/保存/同步管线
src/lib/outline/reveal.ts       反向跳转请求总线
src/components/outline/OutlinePanel.svelte
src/components/outline/OutlineNode.svelte
src/components/outline/InlineRender.svelte
src/components/outline/SlashMenu.svelte
src/components/outline/LinkAutocomplete.svelte
src/components/outline/NodeContextMenu.svelte
src/components/outline/BacklinksSection.svelte
（各 lib 文件同名 .test.ts）
```

**修改：**

```
src/App.svelte                  面板挂载（懒加载）+ dispatchPlugin 分支 + gate 状态加载
src/components/EditorPane.svelte  source/rich 两模式的 reveal 消费（滚动定位）
src/lib/i18n/en.ts zh.ts ja.ts  新增 outline.* 文案
src/components/SettingsDialog.svelte  大纲快捷键改绑区（gated on 插件启用）
```

---

### Task 1: 插件清单 + gate 门面 + App 挂载（空面板可开关）

**Files:**

- Create: `src-tauri/plugins/outline-notes/manifest.json`
- Create: `src/lib/outline/gate.svelte.ts`
- Create: `src/components/outline/OutlinePanel.svelte`（本任务先做壳，后续任务填充）
- Modify: `src/App.svelte`
- [ ] **Step 1: 写插件清单**

`src-tauri/plugins/outline-notes/manifest.json`（格式照抄 `src-tauri/plugins/folder-view/manifest.json`）：

```json
{
  "id": "outline-notes",
  "name": "Outline Notes",
  "version": "0.1.0",
  "description": "Outliner view on the right: syncs the document TOC and ^^highlights^^ into an editable outline saved as a companion .notes.md file.",
  "kind": "builtin",
  "default_enabled": false,
  "host_capabilities": [],
  "menus": [
    {
      "location": "view",
      "label": "Outliner View",
      "shortcut": "Cmd+Shift+O",
      "command": "toggle"
    }
  ],
  "i18n": {
    "zh": {
      "name": "大纲笔记",
      "description": "右侧大纲视图：将文档目录结构与 ^^高亮^^ 实时同步为可编辑大纲，存为伴生 .notes.md 文件。",
      "menus": { "toggle": "大纲视图" }
    },
    "ja": {
      "name": "アウトラインノート",
      "description": "右側のアウトラインビュー：文書の見出しと ^^ハイライト^^ を編集可能なアウトラインに同期し、.notes.md ファイルに保存します。",
      "menus": { "toggle": "アウトラインビュー" }
    }
  }
}
```

- [ ] **Step 2: 写 gate 门面（轻量，App 直接 import）**

`src/lib/outline/gate.svelte.ts`（持久化模式照抄 `folder-view.svelte.ts` 263-293）：

```ts
import { Store } from '@tauri-apps/plugin-store'
import { isPluginEnabled } from '../settings.svelte'

export const PLUGIN_ID = 'outline-notes'
export const DEFAULT_WIDTH = 360
export const MIN_WIDTH = 240
export const MAX_WIDTH = 640

export const outlineGate = $state<{ enabled: boolean; visible: boolean; width: number }>({
  enabled: false,
  visible: false,
  width: DEFAULT_WIDTH,
})

let store: Awaited<ReturnType<typeof Store.load>> | null = null
async function getStore() {
  if (!store) store = await Store.load('settings.json')
  return store
}

/** Call after settings hydration (same timing as loadFolderViewState). */
export async function loadOutlineGate(): Promise<void> {
  outlineGate.enabled = isPluginEnabled(PLUGIN_ID)
  const s = await getStore()
  outlineGate.visible = (await s.get<boolean>('outline.visible')) ?? false
  outlineGate.width = (await s.get<number>('outline.width')) ?? DEFAULT_WIDTH
}

export async function setOutlineVisible(v: boolean): Promise<void> {
  outlineGate.visible = v
  const s = await getStore()
  await s.set('outline.visible', v)
  await s.save()
}

export async function setOutlineWidth(w: number): Promise<void> {
  const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)))
  outlineGate.width = clamped
  const s = await getStore()
  await s.set('outline.width', clamped)
  await s.save()
}
```

- [ ] **Step 3: 写面板壳组件**

`src/components/outline/OutlinePanel.svelte`（本任务只做：容器 + splitter + 标题；树渲染 Task 11 填）：

```svelte
<script lang="ts">
  import type { Tab } from '../../lib/tabs.svelte'
  import { outlineGate, setOutlineWidth, MIN_WIDTH, MAX_WIDTH } from '../../lib/outline/gate.svelte'
  import { t } from '../../lib/i18n/store.svelte'

  let { tab }: { tab: Tab } = $props()

  let dragging = false
  function onSplitterDown(e: PointerEvent) {
    dragging = true
    const startX = e.clientX
    const startW = outlineGate.width
    const move = (ev: PointerEvent) => {
      if (!dragging) return
      const w = startW + (startX - ev.clientX)
      outlineGate.width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w))
    }
    const up = () => {
      dragging = false
      void setOutlineWidth(outlineGate.width)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
</script>

<aside class="outline-panel" style="width: {outlineGate.width}px">
  <div class="splitter" onpointerdown={onSplitterDown}></div>
  <header>
    <span class="title">{t('outline.title')}</span>
  </header>
  <div class="body">
    <!-- tree mounts here in Task 11 -->
    <p class="empty">{tab.title}</p>
  </div>
</aside>

<style>
  .outline-panel {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border-color, #3333);
    overflow: hidden;
  }
  .splitter {
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 4px;
    cursor: col-resize;
    z-index: 5;
  }
  header {
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 600;
    border-bottom: 1px solid var(--border-color, #3333);
  }
  .body { flex: 1; overflow-y: auto; padding: 8px; }
  .empty { opacity: 0.5; font-size: 12px; }
</style>
```

- [ ] **Step 4: i18n 增加 `outline.title`**

在 `src/lib/i18n/en.ts`、`zh.ts`、`ja.ts` 的 Messages 对象中各加一行（后续任务的 key 同样三份都加）：

```ts
// en.ts
'outline.title': 'Outline',
// zh.ts
'outline.title': '大纲',
// ja.ts
'outline.title': 'アウトライン',
```

- [ ] **Step 5: App.svelte 集成**

三处修改（对照现有 folder-view 用法）：

a) script 顶部 import gate：

```ts
import { outlineGate, loadOutlineGate, setOutlineVisible } from './lib/outline/gate.svelte'
```

b) 启动序列中，紧跟 `loadFolderViewState()` 调用处，加：

```ts
await loadOutlineGate()
```

c) `dispatchPlugin` 内，`folder-view` 分支之后加：

```ts
if (pluginId === 'outline-notes') {
  if (command === 'toggle') await setOutlineVisible(!outlineGate.visible)
  return
}
```

d) 模板 `section.pane` 内，`<EditorPane tab={current} />` 之后（右侧）加懒加载挂载：

```svelte
{#if platformName !== 'ios' && outlineGate.enabled && outlineGate.visible && current && current.kind === 'markdown' && !(current.filePath ?? '').endsWith('.notes.md')}
  {#await import('./components/outline/OutlinePanel.svelte') then Panel}
    <Panel.default tab={current} />
  {/await}
{/if}
```

- [ ] **Step 6: 验证**

Run: `pnpm check`  
Expected: 0 errors（新增文件通过 svelte-check）。

手动：`pnpm tauri dev` → 设置→插件页出现 "Outline Notes"（默认关）→ 启用 → View 菜单出现 "Outliner View"（Cmd+Shift+O）→ 打开 .md 切换显示空面板，拖 splitter 改宽 → 重启后宽度/可见性恢复 → 插件关闭后按钮与面板消失。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/plugins/outline-notes src/lib/outline/gate.svelte.ts src/components/outline/OutlinePanel.svelte src/App.svelte src/lib/i18n
git commit -m "feat(outline): builtin plugin scaffold — manifest, gate state, empty panel"
```

### Task 2: model.ts — 节点树 + 分数排序

**Files:**

- Create: `src/lib/outline/model.ts`
- Test: `src/lib/outline/model.test.ts`

移植来源：hulunote `render.cljs:612-629`（calculate-order-between）、`591-610`（normalize）、`639-669`（descendants/valid-drop）、`748-802`（visible list）。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/outline/model.test.ts
import { describe, it, expect } from 'vitest'
import {
  createTree, addNode, childrenOf, calculateOrderBetween,
  normalizeSiblingOrders, collectDescendantIds, isValidDropTarget,
  visibleNodes, removeSubtree, type OutlineTree,
} from './model'

function sampleTree(): OutlineTree {
  // a(0) ── b(100) ── c(200)；b 有子 b1(0)、b2(100)
  const t = createTree()
  addNode(t, { id: 'a', parentId: null, order: 0, content: 'A', collapsed: false, source: 'manual' })
  addNode(t, { id: 'b', parentId: null, order: 100, content: 'B', collapsed: false, source: 'manual' })
  addNode(t, { id: 'c', parentId: null, order: 200, content: 'C', collapsed: false, source: 'manual' })
  addNode(t, { id: 'b1', parentId: 'b', order: 0, content: 'B1', collapsed: false, source: 'manual' })
  addNode(t, { id: 'b2', parentId: 'b', order: 100, content: 'B2', collapsed: false, source: 'manual' })
  return t
}

describe('calculateOrderBetween (hulunote render.cljs:612)', () => {
  it('midpoint when both defined', () => expect(calculateOrderBetween(0, 100)).toBe(50))
  it('prev+100 when next null', () => expect(calculateOrderBetween(200, null)).toBe(300))
  it('next/2 when prev null', () => expect(calculateOrderBetween(null, 100)).toBe(50))
  it('0 when both null', () => expect(calculateOrderBetween(null, null)).toBe(0))
})

describe('tree basics', () => {
  it('childrenOf sorts by order', () => {
    const t = sampleTree()
    expect(childrenOf(t, null).map(n => n.id)).toEqual(['a', 'b', 'c'])
    expect(childrenOf(t, 'b').map(n => n.id)).toEqual(['b1', 'b2'])
  })
  it('normalizeSiblingOrders re-assigns idx*100', () => {
    const t = sampleTree()
    t.nodes.get('a')!.order = 5
    t.nodes.get('b')!.order = 5   // duplicate
    normalizeSiblingOrders(t, null)
    expect(childrenOf(t, null).map(n => n.order)).toEqual([0, 100, 200])
  })
  it('collectDescendantIds', () => {
    expect([...collectDescendantIds(sampleTree(), 'b')].sort()).toEqual(['b1', 'b2'])
  })
  it('isValidDropTarget rejects self and own descendant', () => {
    const t = sampleTree()
    expect(isValidDropTarget(t, 'b', 'b')).toBe(false)
    expect(isValidDropTarget(t, 'b', 'b1')).toBe(false)
    expect(isValidDropTarget(t, 'b', 'c')).toBe(true)
  })
  it('visibleNodes hides children of collapsed parents', () => {
    const t = sampleTree()
    expect(visibleNodes(t).map(n => n.id)).toEqual(['a', 'b', 'b1', 'b2', 'c'])
    t.nodes.get('b')!.collapsed = true
    expect(visibleNodes(t).map(n => n.id)).toEqual(['a', 'b', 'c'])
  })
  it('removeSubtree removes node and descendants', () => {
    const t = sampleTree()
    removeSubtree(t, 'b')
    expect([...t.nodes.keys()].sort()).toEqual(['a', 'c'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/model.test.ts`  
Expected: FAIL — Cannot find module './model'

- [ ] **Step 3: 实现**

```ts
// src/lib/outline/model.ts
export type NodeSource = 'toc' | 'highlight' | 'manual'

export interface OutlineNode {
  id: string
  parentId: string | null // null = 根层
  order: number           // 同级分数排序（hulunote same-deep-order）
  content: string
  collapsed: boolean
  source: NodeSource
  anchorLine?: number     // auto 节点：主文档 1-based 行号
}

export interface OutlineTree { nodes: Map<string, OutlineNode> }

export function createTree(): OutlineTree { return { nodes: new Map() } }

export function addNode(tree: OutlineTree, node: OutlineNode): void {
  tree.nodes.set(node.id, node)
}

export function childrenOf(tree: OutlineTree, parentId: string | null): OutlineNode[] {
  const out: OutlineNode[] = []
  for (const n of tree.nodes.values()) if (n.parentId === parentId) out.push(n)
  return out.sort((a, b) => a.order - b.order)
}

/** hulunote render.cljs:612 calculate-order-between */
export function calculateOrderBetween(prev: number | null, next: number | null): number {
  if (prev != null && next != null) return (prev + next) / 2
  if (prev != null) return prev + 100
  if (next != null) return next / 2
  return 0
}

/** hulunote render.cljs:591 normalize-sibling-orders! — idx*100 */
export function normalizeSiblingOrders(tree: OutlineTree, parentId: string | null): void {
  childrenOf(tree, parentId).forEach((n, idx) => { n.order = idx * 100 })
}

/** hulunote render.cljs:639 collect-descendant-ids */
export function collectDescendantIds(tree: OutlineTree, id: string): Set<string> {
  const acc = new Set<string>()
  const walk = (pid: string) => {
    for (const c of childrenOf(tree, pid)) { acc.add(c.id); walk(c.id) }
  }
  walk(id)
  return acc
}

/** hulunote render.cljs:663 valid-drop-target? */
export function isValidDropTarget(tree: OutlineTree, dragId: string, targetId: string): boolean {
  return !!dragId && !!targetId && dragId !== targetId
    && !collectDescendantIds(tree, dragId).has(targetId)
}

/** hulunote render.cljs:748 collect-visible-navs — 折叠节点不展开其子树 */
export function visibleNodes(tree: OutlineTree): OutlineNode[] {
  const out: OutlineNode[] = []
  const walk = (pid: string | null) => {
    for (const n of childrenOf(tree, pid)) {
      out.push(n)
      if (!n.collapsed) walk(n.id)
    }
  }
  walk(null)
  return out
}

export function removeSubtree(tree: OutlineTree, id: string): void {
  for (const d of collectDescendantIds(tree, id)) tree.nodes.delete(d)
  tree.nodes.delete(id)
}

export function newId(): string {
  return crypto.randomUUID()
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/outline/model.test.ts`  
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/model.ts src/lib/outline/model.test.ts
git commit -m "feat(outline): tree model with fractional ordering (ported from hulunote db.cljs/render.cljs)"
```

---

### Task 3: markdown.ts — 伴生文件 ↔ 树，往返无损

**Files:**

- Create: `src/lib/outline/markdown.ts`
- Test: `src/lib/outline/markdown.test.ts`

格式（spec"伴生文件格式"节）：`- content` 起行、2 空格/层缩进；续行与属性行在 content 列（即 `indent + 2`）；属性行 `type::` / `line::` / `id::` / `collapsed::` 仅非默认值写入；属性 key 集合封闭，续行中恰好形如已知属性的文本行属于已知限制（测试注明）。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/outline/markdown.test.ts
import { describe, it, expect } from 'vitest'
import { serializeOutline, parseOutline } from './markdown'
import { createTree, addNode, type OutlineTree } from './model'

function roundTrip(md: string): string {
  return serializeOutline(parseOutline(md))
}

describe('parseOutline', () => {
  it('parses nesting by 2-space indent', () => {
    const t = parseOutline('- A\n  - A1\n    - A1a\n- B\n')
    const ids = [...t.nodes.values()]
    expect(ids).toHaveLength(4)
    const a = ids.find(n => n.content === 'A')!
    const a1 = ids.find(n => n.content === 'A1')!
    const a1a = ids.find(n => n.content === 'A1a')!
    expect(a.parentId).toBeNull()
    expect(a1.parentId).toBe(a.id)
    expect(a1a.parentId).toBe(a1.id)
  })
  it('reads property lines', () => {
    const md = '- Chapter\n  type:: toc\n  line:: 12\n  collapsed:: true\n  id:: abc-123\n'
    const n = [...parseOutline(md).nodes.values()][0]
    expect(n.source).toBe('toc')
    expect(n.anchorLine).toBe(12)
    expect(n.collapsed).toBe(true)
    expect(n.id).toBe('abc-123')
  })
  it('joins continuation lines into multi-line content', () => {
    const md = '- ```js\n  const x = 1\n  ```\n- next\n'
    const nodes = [...parseOutline(md).nodes.values()]
    expect(nodes[0].content).toBe('```js\nconst x = 1\n```')
    expect(nodes[1].content).toBe('next')
  })
  it('degrades unparseable lines to plain manual nodes (spec: 不丢内容)', () => {
    const t = parseOutline('stray text no bullet\n- ok\n')
    const contents = [...t.nodes.values()].map(n => n.content)
    expect(contents).toContain('stray text no bullet')
    expect(contents).toContain('ok')
  })
})

describe('serializeOutline', () => {
  it('writes only non-default props', () => {
    const t = createTree()
    addNode(t, { id: 'm', parentId: null, order: 0, content: 'hand', collapsed: false, source: 'manual' })
    addNode(t, { id: 'h', parentId: null, order: 100, content: 'marked', collapsed: false, source: 'highlight', anchorLine: 3 })
    const md = serializeOutline(t)
    expect(md).toBe('- hand\n- marked\n  type:: highlight\n  line:: 3\n')
  })
  it('persists manual node id only when flagged', () => {
    const t = createTree()
    addNode(t, { id: 'x-1', parentId: null, order: 0, content: 'ref target', collapsed: false, source: 'manual' })
    expect(serializeOutline(t)).not.toContain('id::')
    expect(serializeOutline(t, new Set(['x-1']))).toContain('id:: x-1')
  })
})

describe('round-trip（验收标准 2）', () => {
  it('lossless: nesting + props + multi-line + special chars', () => {
    const md = [
      '- Title',
      '  type:: toc',
      '  line:: 1',
      '  - ^^note^^ with [[link]] and #tag',
      '    type:: highlight',
      '    line:: 4',
      '    id:: h-1',
      '    collapsed:: true',
      '    - my thought **bold** `code`',
      '- ```py',
      '  print("hi :: not a prop")',
      '  ```',
      '',
    ].join('\n')
    expect(roundTrip(md)).toBe(md)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/markdown.test.ts`  
Expected: FAIL — Cannot find module './markdown'

- [ ] **Step 3: 实现**

```ts
// src/lib/outline/markdown.ts
import { createTree, addNode, childrenOf, newId, type OutlineTree, type OutlineNode, type NodeSource } from './model'

const PROP_RE = /^(type|line|id|collapsed):: (.*)$/

/**
 * Serialize the tree to companion-file markdown.
 * `persistIds`: manual-node ids that must be written (block-ref targets /
 * auto nodes with manual children). Auto nodes always write type::/line::.
 */
export function serializeOutline(tree: OutlineTree, persistIds: Set<string> = new Set()): string {
  const lines: string[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const n of childrenOf(tree, parentId)) {
      const indent = '  '.repeat(depth)
      const contentLines = n.content.split('\n')
      lines.push(`${indent}- ${contentLines[0]}`)
      for (const cont of contentLines.slice(1)) lines.push(`${indent}  ${cont}`)
      if (n.source !== 'manual') {
        lines.push(`${indent}  type:: ${n.source}`)
        if (n.anchorLine != null) lines.push(`${indent}  line:: ${n.anchorLine}`)
      }
      if (n.source !== 'manual' ? persistIds.has(n.id) : persistIds.has(n.id)) {
        lines.push(`${indent}  id:: ${n.id}`)
      }
      if (n.collapsed) lines.push(`${indent}  collapsed:: true`)
      walk(n.id, depth + 1)
    }
  }
  walk(null, 0)
  return lines.length ? lines.join('\n') + '\n' : ''
}

export function parseOutline(text: string): OutlineTree {
  const tree = createTree()
  // 每层的“当前节点”栈：stack[d] = 深度 d 的最近节点
  const stack: OutlineNode[] = []
  let current: OutlineNode | null = null
  let currentDepth = -1
  let orderCounters: number[] = []

  const nextOrder = (depth: number): number => {
    orderCounters.length = depth + 1
    orderCounters[depth] = (orderCounters[depth] ?? -100) + 100
    return orderCounters[depth]
  }

  const push = (depth: number, content: string): OutlineNode => {
    const parent = depth > 0 ? stack[depth - 1] ?? null : null
    const node: OutlineNode = {
      id: newId(),
      parentId: parent ? parent.id : null,
      order: nextOrder(depth),
      content,
      collapsed: false,
      source: 'manual',
    }
    addNode(tree, node)
    stack.length = depth
    stack[depth] = node
    current = node
    currentDepth = depth
    return node
  }

  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    const bullet = raw.match(/^((?:  )*)- (.*)$/)
    if (bullet) {
      push(bullet[1].length / 2, bullet[2])
      continue
    }
    if (current) {
      // 续行或属性行：期望缩进 = 节点缩进 + 2
      const contIndent = '  '.repeat(currentDepth) + '  '
      if (raw.startsWith(contIndent)) {
        const body = raw.slice(contIndent.length)
        const prop = body.match(PROP_RE)
        if (prop) {
          const [, key, value] = prop
          if (key === 'type' && (value === 'toc' || value === 'highlight')) current.source = value as NodeSource
          else if (key === 'line') current.anchorLine = parseInt(value, 10)
          else if (key === 'collapsed') current.collapsed = value === 'true'
          else if (key === 'id') {
            // 重键：换 id 需迁移 map 与子引用（此时尚无子节点，直接迁移 map）
            tree.nodes.delete(current.id)
            current.id = value
            tree.nodes.set(value, current)
            for (const n of tree.nodes.values()) if (n.parentId && !tree.nodes.has(n.parentId)) n.parentId = current.id
          }
        } else {
          current.content += '\n' + body
        }
        continue
      }
    }
    // 无法归类的行：降级为根层手写节点（spec: 不丢内容）
    push(0, raw.trim())
  }
  return tree
}
```

**实现注意（parse 中 id 迁移）**：`id::` 属性总是紧跟节点行之后（serialize 顺序保证：先续行、再 type/line/id/collapsed，然后才走子节点），因此重设 id 时该节点必然还没有子节点，父引用修复循环只兜底畸形输入。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/outline/markdown.test.ts`  
Expected: PASS。若 round-trip 用例 diff 不为空，逐行对比 serialize 输出顺序（续行 → type → line → id → collapsed）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/markdown.ts src/lib/outline/markdown.test.ts
git commit -m "feat(outline): companion-file markdown round-trip (props + multi-line nodes)"
```

### Task 4: parser.ts — hulunote 行内文法

**Files:**

- Create: `src/lib/outline/parser.ts`
- Test: `src/lib/outline/parser.test.ts`

移植来源：hulunote `parser.cljc` Instaparse 文法（完全按其语义，不用 mdeditor wikilink-plugin 的 `|alias` 语法）。翻译为单遍扫描 + 嵌套平衡匹配（页面链接可嵌套）。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/outline/parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseInline } from './parser'

describe('parseInline (hulunote parser.cljc grammar)', () => {
  it('plain text', () => {
    expect(parseInline('hello world')).toEqual([{ t: 'text', text: 'hello world' }])
  })
  it('page link', () => {
    expect(parseInline('[[hulunote]] is best')).toEqual([
      { t: 'page-link', target: 'hulunote' },
      { t: 'text', text: ' is best' },
    ])
  })
  it('nested page link keeps full target', () => {
    expect(parseInline('[[a [[b]] c]]')).toEqual([{ t: 'page-link', target: 'a [[b]] c' }])
  })
  it('block ref', () => {
    expect(parseInline('see ((abc_12-3))')).toEqual([
      { t: 'text', text: 'see ' },
      { t: 'block-ref', refId: 'abc_12-3' },
    ])
  })
  it('bare hashtag stops at space/punct; delimited hashtag', () => {
    expect(parseInline('#tag rest')).toEqual([
      { t: 'hashtag', tag: 'tag' },
      { t: 'text', text: ' rest' },
    ])
    expect(parseInline('#[[multi word]]')).toEqual([{ t: 'hashtag', tag: 'multi word' }])
  })
  it('emphasis family', () => {
    expect(parseInline('**b** __i__ ~~s~~ ^^h^^ `c`')).toEqual([
      { t: 'bold', text: 'b' }, { t: 'text', text: ' ' },
      { t: 'italics', text: 'i' }, { t: 'text', text: ' ' },
      { t: 'strikethrough', text: 's' }, { t: 'text', text: ' ' },
      { t: 'highlight', text: 'h' }, { t: 'text', text: ' ' },
      { t: 'code', text: 'c' },
    ])
  })
  it('md link / image / bare url', () => {
    expect(parseInline('[x](https://a.b)')).toEqual([{ t: 'link', text: 'x', url: 'https://a.b' }])
    expect(parseInline('![y](img.png)')).toEqual([{ t: 'image', alt: 'y', url: 'img.png' }])
    expect(parseInline('go https://a.b/c now')).toEqual([
      { t: 'text', text: 'go ' },
      { t: 'url', url: 'https://a.b/c' },
      { t: 'text', text: ' now' },
    ])
  })
  it('unclosed markers degrade to text', () => {
    expect(parseInline('**not closed')).toEqual([{ t: 'text', text: '**not closed' }])
    expect(parseInline('[[no close')).toEqual([{ t: 'text', text: '[[no close' }])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/parser.test.ts`  
Expected: FAIL — Cannot find module './parser'

- [ ] **Step 3: 实现**

```ts
// src/lib/outline/parser.ts
export type Inline =
  | { t: 'text'; text: string }
  | { t: 'page-link'; target: string }
  | { t: 'hashtag'; tag: string }
  | { t: 'block-ref'; refId: string }
  | { t: 'bold'; text: string }
  | { t: 'italics'; text: string }
  | { t: 'strikethrough'; text: string }
  | { t: 'highlight'; text: string }
  | { t: 'code'; text: string }
  | { t: 'link'; text: string; url: string }
  | { t: 'image'; alt: string; url: string }
  | { t: 'url'; url: string }

const BLOCK_REF_RE = /^\(\(([a-zA-Z0-9_-]+)\)\)/
// hulunote hashtag-bare：到空格或标点为止
const HASHTAG_RE = /^#([^\s+!@#$%^&*()?";:\][]+)/
const MD_LINK_RE = /^\[([^\]\n]*)\]\(([^)\s][^)]*)\)/
const URL_RE = /^https?:\/\/[^\s[\]()*^{}]+/

/** 找嵌套平衡的 ]]，返回 target 结束位置（hulunote any-page-link-content 可嵌套） */
function findPageLinkEnd(s: string, from: number): number {
  let depth = 1
  for (let i = from; i < s.length - 1; i++) {
    if (s[i] === '[' && s[i + 1] === '[') { depth++; i++ }
    else if (s[i] === ']' && s[i + 1] === ']') { depth--; i++; if (depth === 0) return i - 1 }
  }
  return -1
}

function pairSpan(s: string, i: number, marker: string): string | null {
  const start = i + marker.length
  const end = s.indexOf(marker, start)
  if (end < 0 || end === start) return null
  const inner = s.slice(start, end)
  if (inner.includes('\n')) return null
  return inner
}

export function parseInline(input: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = () => { if (text) { out.push({ t: 'text', text }); text = '' } }

  let i = 0
  while (i < input.length) {
    const rest = input.slice(i)
    const two = rest.slice(0, 2)

    if (two === '[[') {
      const end = findPageLinkEnd(input, i + 2)
      if (end >= 0) { flush(); out.push({ t: 'page-link', target: input.slice(i + 2, end) }); i = end + 2; continue }
    }
    if (two === '((') {
      const m = rest.match(BLOCK_REF_RE)
      if (m) { flush(); out.push({ t: 'block-ref', refId: m[1] }); i += m[0].length; continue }
    }
    if (input[i] === '#') {
      if (rest.startsWith('#[[')) {
        const end = findPageLinkEnd(input, i + 3)
        if (end >= 0) { flush(); out.push({ t: 'hashtag', tag: input.slice(i + 3, end) }); i = end + 2; continue }
      }
      const m = rest.match(HASHTAG_RE)
      if (m) { flush(); out.push({ t: 'hashtag', tag: m[1] }); i += m[0].length; continue }
    }
    if (input[i] === '!') {
      const m = rest.slice(1).match(MD_LINK_RE)
      if (m) { flush(); out.push({ t: 'image', alt: m[1], url: m[2] }); i += 1 + m[0].length; continue }
    }
    if (input[i] === '[' && two !== '[[') {
      const m = rest.match(MD_LINK_RE)
      if (m) { flush(); out.push({ t: 'link', text: m[1], url: m[2] }); i += m[0].length; continue }
    }
    let matched = false
    for (const [marker, kind] of [['**', 'bold'], ['__', 'italics'], ['~~', 'strikethrough'], ['^^', 'highlight']] as const) {
      if (two === marker) {
        const inner = pairSpan(input, i, marker)
        if (inner != null) {
          flush()
          out.push({ t: kind, text: inner })
          i += marker.length * 2 + inner.length
          matched = true
        }
        break
      }
    }
    if (matched) continue
    if (input[i] === '`') {
      const inner = pairSpan(input, i, '`')
      if (inner != null) { flush(); out.push({ t: 'code', text: inner }); i += inner.length + 2; continue }
    }
    if (input[i] === 'h') {
      const m = rest.match(URL_RE)
      if (m) { flush(); out.push({ t: 'url', url: m[0] }); i += m[0].length; continue }
    }
    text += input[i]
    i++
  }
  flush()
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/outline/parser.test.ts`  
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/parser.ts src/lib/outline/parser.test.ts
git commit -m "feat(outline): hulunote inline grammar parser (page-links, tags, block-refs, emphasis)"
```

---

### Task 5: derive.ts — 主文 → auto 节点序列

**Files:**

- Create: `src/lib/outline/derive.ts`
- Test: `src/lib/outline/derive.test.ts`
- [ ] **Step 1: 写失败测试**

```ts
// src/lib/outline/derive.test.ts
import { describe, it, expect } from 'vitest'
import { deriveAutoItems, type AutoItem } from './derive'

const strip = (items: AutoItem[]) => items.map(({ source, content, depth, anchorLine }) => ({ source, content, depth, anchorLine }))

describe('deriveAutoItems', () => {
  it('headings nest relatively; anchorLine 1-based', () => {
    const md = '# A\n\ntext\n\n### B\n\n## C\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 1 },
      { source: 'toc', content: 'B', depth: 1, anchorLine: 5 },
      { source: 'toc', content: 'C', depth: 1, anchorLine: 7 },
    ])
  })
  it('highlights attach under nearest heading; before any heading → depth 0', () => {
    const md = 'intro ^^first^^\n\n# A\n\nsome ==second== here\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'highlight', content: 'first', depth: 0, anchorLine: 1 },
      { source: 'toc', content: 'A', depth: 0, anchorLine: 3 },
      { source: 'highlight', content: 'second', depth: 1, anchorLine: 5 },
    ])
  })
  it('skips frontmatter and fenced code', () => {
    const md = '---\ntitle: x\n---\n# Real\n```\n# not a heading\n^^not a highlight^^\n```\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'Real', depth: 0, anchorLine: 4 },
    ])
  })
  it('multiple highlights on one line, in order', () => {
    const md = '# H\n^^a^^ and ^^b^^\n'
    expect(strip(deriveAutoItems(md)).map(i => i.content)).toEqual(['H', 'a', 'b'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/derive.test.ts`  
Expected: FAIL — Cannot find module './derive'

- [ ] **Step 3: 实现**

```ts
// src/lib/outline/derive.ts
export interface AutoItem {
  source: 'toc' | 'highlight'
  content: string
  /** 树深度：toc 按标题级别相对嵌套；highlight = 所属 toc 深度 + 1（无标题时 0） */
  depth: number
  anchorLine: number
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const HIGHLIGHT_RE = /\^\^([^^\n]+?)\^\^|==([^=\n]+?)==/g

export function deriveAutoItems(md: string): AutoItem[] {
  const lines = md.split('\n')
  const items: AutoItem[] = []
  // levelStack: 祖先链的标题级别（如 [1,3] = h1 下的 h3），深度 = 栈长-1
  const levelStack: number[] = []
  let inFence = false
  let start = 0

  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1)
    if (close > 0) start = close + 1
  }

  for (let li = start; li < lines.length; li++) {
    const line = lines[li]
    if (/^(```|~~~)/.test(line.trim())) { inFence = !inFence; continue }
    if (inFence) continue

    const h = line.match(HEADING_RE)
    if (h) {
      const level = h[1].length
      while (levelStack.length && levelStack[levelStack.length - 1] >= level) levelStack.pop()
      levelStack.push(level)
      items.push({ source: 'toc', content: h[2].trim(), depth: levelStack.length - 1, anchorLine: li + 1 })
      continue
    }
    HIGHLIGHT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HIGHLIGHT_RE.exec(line)) !== null) {
      const text = (m[1] ?? m[2]).trim()
      if (!text) continue
      items.push({ source: 'highlight', content: text, depth: levelStack.length, anchorLine: li + 1 })
    }
  }
  return items
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/outline/derive.test.ts`  
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/derive.ts src/lib/outline/derive.test.ts
git commit -m "feat(outline): derive TOC + highlight auto items with line anchors"
```

---

### Task 6: sync.ts — diff 匹配、手写保护、重新生成

**Files:**

- Create: `src/lib/outline/sync.ts`
- Test: `src/lib/outline/sync.test.ts`

语义（spec"派生与实时同步"节）：新派生序列与树中现有 auto 节点 LCS 匹配（key = `source + content`）；命中者保 id/collapsed/手写子节点，刷新 content/anchorLine/结构位置；未命中的旧 auto 删除，其手写子树重挂**最近存活祖先**（兜底根）；手写兄弟排在同级 auto 之后、保持相对序。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/outline/sync.test.ts
import { describe, it, expect } from 'vitest'
import { syncAutoItems, regenerate } from './sync'
import { deriveAutoItems } from './derive'
import { createTree, addNode, childrenOf } from './model'

const md1 = '# A\n## B\n^^hl^^\n'

function build(md: string) {
  const tree = createTree()
  syncAutoItems(tree, deriveAutoItems(md))
  return tree
}

describe('syncAutoItems', () => {
  it('builds initial auto tree', () => {
    const t = build(md1)
    const roots = childrenOf(t, null)
    expect(roots.map(n => [n.source, n.content])).toEqual([['toc', 'A']])
    const bs = childrenOf(t, roots[0].id)
    expect(bs.map(n => [n.source, n.content])).toEqual([['toc', 'B']])
    expect(childrenOf(t, bs[0].id).map(n => [n.source, n.content])).toEqual([['highlight', 'hl']])
  })
  it('keeps id + collapsed + manual children across re-derive (diff match)', () => {
    const t = build(md1)
    const b = [...t.nodes.values()].find(n => n.content === 'B')!
    b.collapsed = true
    addNode(t, { id: 'note1', parentId: b.id, order: 500, content: 'my note', collapsed: false, source: 'manual' })
    syncAutoItems(t, deriveAutoItems('# A\n## B\n^^hl^^\nnew text\n'))
    const b2 = [...t.nodes.values()].find(n => n.content === 'B')!
    expect(b2.id).toBe(b.id)
    expect(b2.collapsed).toBe(true)
    expect(childrenOf(t, b2.id).some(n => n.id === 'note1')).toBe(true)
  })
  it('removing highlight deletes its node; manual children reparent to nearest survivor', () => {
    const t = build(md1)
    const hl = [...t.nodes.values()].find(n => n.source === 'highlight')!
    addNode(t, { id: 'child', parentId: hl.id, order: 0, content: 'attached', collapsed: false, source: 'manual' })
    syncAutoItems(t, deriveAutoItems('# A\n## B\n'))
    expect([...t.nodes.values()].some(n => n.source === 'highlight')).toBe(false)
    const child = t.nodes.get('child')!
    const b = [...t.nodes.values()].find(n => n.content === 'B')!
    expect(child.parentId).toBe(b.id)
  })
  it('anchorLine refreshes on match', () => {
    const t = build(md1)
    syncAutoItems(t, deriveAutoItems('intro\n\n# A\n## B\n^^hl^^\n'))
    expect([...t.nodes.values()].find(n => n.content === 'A')!.anchorLine).toBe(3)
  })
  it('root-level manual node survives and stays at root', () => {
    const t = build(md1)
    addNode(t, { id: 'root-note', parentId: null, order: 950, content: 'root note', collapsed: false, source: 'manual' })
    syncAutoItems(t, deriveAutoItems('# A2\n'))
    expect(t.nodes.get('root-note')!.parentId).toBeNull()
  })
})

describe('regenerate', () => {
  it('rebuilds autos fresh but keeps manual nodes (spec 验收 5)', () => {
    const t = build(md1)
    const a = [...t.nodes.values()].find(n => n.content === 'A')!
    addNode(t, { id: 'keep', parentId: a.id, order: 999, content: 'keep me', collapsed: false, source: 'manual' })
    regenerate(t, deriveAutoItems(md1))
    expect(t.nodes.get('keep')).toBeDefined()
    expect([...t.nodes.values()].filter(n => n.source === 'toc')).toHaveLength(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/sync.test.ts`  
Expected: FAIL — Cannot find module './sync'

- [ ] **Step 3: 实现**

```ts
// src/lib/outline/sync.ts
import { childrenOf, newId, calculateOrderBetween, type OutlineTree, type OutlineNode } from './model'
import type { AutoItem } from './derive'

const keyOf = (source: string, content: string) => source + ' ' + content

/** 树中 auto 节点按先序遍历（= 派生序）拍平 */
function autoSequence(tree: OutlineTree): OutlineNode[] {
  const out: OutlineNode[] = []
  const walk = (pid: string | null) => {
    for (const n of childrenOf(tree, pid)) {
      if (n.source !== 'manual') out.push(n)
      walk(n.id)
    }
  }
  walk(null)
  return out
}

/** 经典 LCS，返回 [oldIdx, newIdx] 配对 */
function lcsPairs(oldKeys: string[], newKeys: string[]): Array<[number, number]> {
  const m = oldKeys.length, n = newKeys.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = oldKeys[i] === newKeys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const pairs: Array<[number, number]> = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (oldKeys[i] === newKeys[j]) { pairs.push([i, j]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return pairs
}

/** 孤儿手写子树重挂：沿被删父链向上找第一个仍存活的节点 */
function reparentOrphans(tree: OutlineTree, removedParents: Map<string, string | null>): void {
  const resolve = (pid: string | null): string | null => {
    while (pid != null && !tree.nodes.has(pid)) pid = removedParents.get(pid) ?? null
    return pid
  }
  for (const n of tree.nodes.values()) {
    if (n.parentId != null && !tree.nodes.has(n.parentId)) n.parentId = resolve(n.parentId)
  }
}

export function syncAutoItems(tree: OutlineTree, items: AutoItem[]): void {
  const oldSeq = autoSequence(tree)
  const pairs = lcsPairs(oldSeq.map(n => keyOf(n.source, n.content)), items.map(it => keyOf(it.source, it.content)))
  const matchedOld = new Map<number, number>(pairs)
  const matchedNew = new Map<number, OutlineNode>(pairs.map(([o, nw]) => [nw, oldSeq[o]]))

  // 1) 删除未匹配的旧 auto（记录父链供重挂）
  const removedParents = new Map<string, string | null>()
  oldSeq.forEach((node, idx) => {
    if (!matchedOld.has(idx)) { removedParents.set(node.id, node.parentId); tree.nodes.delete(node.id) }
  })

  // 2) 按新序列重建 auto 结构
  const parentStack: OutlineNode[] = []
  const autoOrderCounter = new Map<string | null, number>()
  const nextAutoOrder = (pid: string | null): number => {
    const v = (autoOrderCounter.get(pid) ?? -100) + 100
    autoOrderCounter.set(pid, v)
    return v
  }

  items.forEach((it, idx) => {
    parentStack.length = it.depth
    const parent = it.depth > 0 ? parentStack[it.depth - 1] ?? null : null
    const pid = parent ? parent.id : null
    let node = matchedNew.get(idx)
    if (node) {
      node.content = it.content
      node.anchorLine = it.anchorLine
      node.parentId = pid
      node.order = nextAutoOrder(pid)
    } else {
      node = {
        id: newId(), parentId: pid, order: nextAutoOrder(pid),
        content: it.content, collapsed: false, source: it.source, anchorLine: it.anchorLine,
      }
      tree.nodes.set(node.id, node)
    }
    if (it.source === 'toc') parentStack[it.depth] = node
  })

  // 3) 孤儿手写子树重挂
  reparentOrphans(tree, removedParents)

  // 4) 手写兄弟排到同级 auto 之后，保持相对序
  for (const pid of new Set([...tree.nodes.values()].map(n => n.parentId))) {
    const siblings = childrenOf(tree, pid)
    const lastAuto = siblings.filter(n => n.source !== 'manual').pop()
    let prev = lastAuto ? lastAuto.order : null
    for (const mnode of siblings.filter(n => n.source === 'manual')) {
      mnode.order = calculateOrderBetween(prev, null)
      prev = mnode.order
    }
  }
}

/** 强制全量重建 auto（绕过 diff 保 id），手写节点保留并重挂 */
export function regenerate(tree: OutlineTree, items: AutoItem[]): void {
  const removedParents = new Map<string, string | null>()
  for (const n of [...tree.nodes.values()]) {
    if (n.source !== 'manual') { removedParents.set(n.id, n.parentId); tree.nodes.delete(n.id) }
  }
  reparentOrphans(tree, removedParents)
  syncAutoItems(tree, items)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/outline/sync.test.ts`  
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/sync.ts src/lib/outline/sync.test.ts
git commit -m "feat(outline): diff-matched sync preserving ids and manual subtrees"
```

### Task 7: commands.ts — 结构编辑命令（仅手写节点）

**Files:**

- Create: `src/lib/outline/commands.ts`
- Test: `src/lib/outline/commands.test.ts`

移植来源：hulunote `render.cljs:806-989`（create-sibling/create-sibling-above/indent/outdent）、`render.cljs:1003-1027`（apply-inline-wrap!）。约束：结构操作只允许 manual 节点（spec"编辑权限"）；折叠对所有节点开放。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/outline/commands.test.ts
import { describe, it, expect } from 'vitest'
import {
  createSiblingBelow, createSiblingAbove, indentNode, outdentNode,
  moveNodeUp, moveNodeDown, mergeWithPrevious, applyInlineWrap,
} from './commands'
import { createTree, addNode, childrenOf, type OutlineTree } from './model'

function manualTree(): OutlineTree {
  const t = createTree()
  addNode(t, { id: 'a', parentId: null, order: 0, content: 'A', collapsed: false, source: 'manual' })
  addNode(t, { id: 'b', parentId: null, order: 100, content: 'B', collapsed: false, source: 'manual' })
  addNode(t, { id: 'b1', parentId: 'b', order: 0, content: 'B1', collapsed: false, source: 'manual' })
  return t
}

describe('create siblings (hulunote render.cljs:806/846)', () => {
  it('below: inserts between b and next; returns new id', () => {
    const t = manualTree()
    const id = createSiblingBelow(t, 'a')!
    const roots = childrenOf(t, null).map(n => n.id)
    expect(roots).toEqual(['a', id, 'b'])
  })
  it('above: first sibling gets order before current', () => {
    const t = manualTree()
    const id = createSiblingAbove(t, 'a')!
    expect(childrenOf(t, null)[0].id).toBe(id)
  })
})

describe('indent / outdent (render.cljs:918/952)', () => {
  it('indent moves under prev sibling as last child; no prev sibling → no-op', () => {
    const t = manualTree()
    expect(indentNode(t, 'a')).toBe(false)     // 无前兄弟
    expect(indentNode(t, 'b')).toBe(true)
    expect(t.nodes.get('b')!.parentId).toBe('a')
  })
  it('outdent makes node next sibling of its parent', () => {
    const t = manualTree()
    expect(outdentNode(t, 'b1')).toBe(true)
    expect(t.nodes.get('b1')!.parentId).toBeNull()
    expect(childrenOf(t, null).map(n => n.id)).toEqual(['a', 'b', 'b1'])
  })
  it('structure ops refuse auto nodes', () => {
    const t = manualTree()
    addNode(t, { id: 'toc1', parentId: null, order: 200, content: 'T', collapsed: false, source: 'toc', anchorLine: 1 })
    expect(indentNode(t, 'toc1')).toBe(false)
    expect(outdentNode(t, 'toc1')).toBe(false)
    expect(createSiblingBelow(t, 'toc1')).not.toBeNull() // 在 auto 节点旁新建手写节点是允许的
  })
})

describe('move up/down', () => {
  it('swaps order with adjacent sibling', () => {
    const t = manualTree()
    expect(moveNodeDown(t, 'a')).toBe(true)
    expect(childrenOf(t, null).map(n => n.id)).toEqual(['b', 'a'])
    expect(moveNodeUp(t, 'a')).toBe(true)
    expect(childrenOf(t, null).map(n => n.id)).toEqual(['a', 'b'])
  })
})

describe('mergeWithPrevious', () => {
  it('appends content to previous visible node and removes current (childless)', () => {
    const t = manualTree()
    const res = mergeWithPrevious(t, 'b1')   // prev visible = b
    expect(res).toEqual({ mergedInto: 'b', joinAt: 1 })  // joinAt = 原内容长度
    expect(t.nodes.get('b')!.content).toBe('BB1')
    expect(t.nodes.get('b1')).toBeUndefined()
  })
  it('refuses when node has children', () => {
    const t = manualTree()
    expect(mergeWithPrevious(t, 'b')).toBeNull()
  })
})

describe('applyInlineWrap (render.cljs:1003)', () => {
  it('wraps selection', () => {
    expect(applyInlineWrap('hello world', 6, 11, '**')).toEqual({ text: 'hello **world**', selStart: 8, selEnd: 13 })
  })
  it('inserts paired markers at collapsed caret, caret centered', () => {
    expect(applyInlineWrap('ab', 1, 1, '__')).toEqual({ text: 'a____b', selStart: 3, selEnd: 3 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/commands.test.ts`  
Expected: FAIL — Cannot find module './commands'

- [ ] **Step 3: 实现**

```ts
// src/lib/outline/commands.ts
import {
  childrenOf, calculateOrderBetween, normalizeSiblingOrders, newId,
  visibleNodes, removeSubtree, collectDescendantIds, isValidDropTarget,
  type OutlineTree, type OutlineNode,
} from './model'

const isManual = (n: OutlineNode | undefined): n is OutlineNode => !!n && n.source === 'manual'

function siblingIndex(tree: OutlineTree, node: OutlineNode): { siblings: OutlineNode[]; idx: number } {
  const siblings = childrenOf(tree, node.parentId)
  return { siblings, idx: siblings.findIndex(s => s.id === node.id) }
}

/** render.cljs:806 create-sibling-nav! — normalize 后取中点 */
export function createSiblingBelow(tree: OutlineTree, currentId: string): string | null {
  const cur = tree.nodes.get(currentId)
  if (!cur) return null
  normalizeSiblingOrders(tree, cur.parentId)
  const { siblings, idx } = siblingIndex(tree, cur)
  const nextOrder = idx < siblings.length - 1 ? (idx + 1) * 100 : null
  const node: OutlineNode = {
    id: newId(), parentId: cur.parentId, order: calculateOrderBetween(idx * 100, nextOrder),
    content: '', collapsed: false, source: 'manual',
  }
  tree.nodes.set(node.id, node)
  return node.id
}

/** render.cljs:846 create-sibling-above! — 首位时用 current-100 */
export function createSiblingAbove(tree: OutlineTree, currentId: string): string | null {
  const cur = tree.nodes.get(currentId)
  if (!cur) return null
  normalizeSiblingOrders(tree, cur.parentId)
  const { idx } = siblingIndex(tree, cur)
  const order = idx > 0 ? calculateOrderBetween((idx - 1) * 100, idx * 100) : idx * 100 - 100
  const node: OutlineNode = {
    id: newId(), parentId: cur.parentId, order,
    content: '', collapsed: false, source: 'manual',
  }
  tree.nodes.set(node.id, node)
  return node.id
}

/** render.cljs:918 indent-nav! — 成为前兄弟的最后一个子节点 */
export function indentNode(tree: OutlineTree, id: string): boolean {
  const node = tree.nodes.get(id)
  if (!isManual(node)) return false
  const { siblings, idx } = siblingIndex(tree, node)
  if (idx <= 0) return false
  const newParent = siblings[idx - 1]
  const lastChild = childrenOf(tree, newParent.id).pop()
  node.parentId = newParent.id
  node.order = calculateOrderBetween(lastChild ? lastChild.order : null, null)
  newParent.collapsed = false // render.cljs:941 确保新父展开
  return true
}

/** render.cljs:952 outdent-nav! — 成为父节点的下一个兄弟 */
export function outdentNode(tree: OutlineTree, id: string): boolean {
  const node = tree.nodes.get(id)
  if (!isManual(node) || node.parentId == null) return false
  const parent = tree.nodes.get(node.parentId)
  if (!parent) return false
  const { siblings: parentSibs, idx: pIdx } = siblingIndex(tree, parent)
  const next = pIdx < parentSibs.length - 1 ? parentSibs[pIdx + 1] : null
  node.parentId = parent.parentId
  node.order = calculateOrderBetween(parent.order, next ? next.order : null)
  return true
}

export function moveNodeUp(tree: OutlineTree, id: string): boolean {
  const node = tree.nodes.get(id)
  if (!isManual(node)) return false
  const { siblings, idx } = siblingIndex(tree, node)
  if (idx <= 0) return false
  const prev = siblings[idx - 1]
  ;[node.order, prev.order] = [prev.order, node.order]
  return true
}

export function moveNodeDown(tree: OutlineTree, id: string): boolean {
  const node = tree.nodes.get(id)
  if (!isManual(node)) return false
  const { siblings, idx } = siblingIndex(tree, node)
  if (idx < 0 || idx >= siblings.length - 1) return false
  const next = siblings[idx + 1]
  ;[node.order, next.order] = [next.order, node.order]
  return true
}

/** 行首 Backspace：并入上一可见节点尾部。返回目标节点与光标落点。 */
export function mergeWithPrevious(tree: OutlineTree, id: string): { mergedInto: string; joinAt: number } | null {
  const node = tree.nodes.get(id)
  if (!isManual(node)) return null
  if (childrenOf(tree, id).length > 0) return null
  const vis = visibleNodes(tree)
  const idx = vis.findIndex(n => n.id === id)
  if (idx <= 0) return null
  const prev = vis[idx - 1]
  if (prev.source !== 'manual') {
    // 上一节点是 auto（只读）：仅当当前为空节点时允许删除
    if (node.content !== '') return null
    tree.nodes.delete(id)
    return { mergedInto: prev.id, joinAt: prev.content.length }
  }
  const joinAt = prev.content.length
  prev.content += node.content
  tree.nodes.delete(id)
  return { mergedInto: prev.id, joinAt }
}

/** render.cljs:1003 apply-inline-wrap! — 纯文本版本，UI 层套用 selection */
export function applyInlineWrap(text: string, selStart: number, selEnd: number, marker: string):
  { text: string; selStart: number; selEnd: number } {
  const before = text.slice(0, selStart)
  const selected = text.slice(selStart, selEnd)
  const after = text.slice(selEnd)
  if (selected.length > 0) {
    return {
      text: before + marker + selected + marker + after,
      selStart: selStart + marker.length,
      selEnd: selEnd + marker.length,
    }
  }
  return {
    text: before + marker + marker + after,
    selStart: selStart + marker.length,
    selEnd: selStart + marker.length,
  }
}

/** 拖拽：render.cljs:671 move-nav-after! */
export function moveNodeAfter(tree: OutlineTree, dragId: string, targetId: string): boolean {
  const drag = tree.nodes.get(dragId)
  const target = tree.nodes.get(targetId)
  if (!isManual(drag) || !target || !isValidDropTarget(tree, dragId, targetId)) return false
  const { siblings, idx } = siblingIndex(tree, target)
  const next = idx < siblings.length - 1 ? siblings[idx + 1] : null
  drag.parentId = target.parentId
  drag.order = calculateOrderBetween(target.order, next ? next.order : null)
  return true
}

/** 拖拽：render.cljs:700 move-nav-to-child! — 成为最后一个子节点 */
export function moveNodeToChild(tree: OutlineTree, dragId: string, targetId: string): boolean {
  const drag = tree.nodes.get(dragId)
  const target = tree.nodes.get(targetId)
  if (!isManual(drag) || !target || !isValidDropTarget(tree, dragId, targetId)) return false
  const lastChild = childrenOf(tree, targetId).pop()
  drag.parentId = targetId
  drag.order = calculateOrderBetween(lastChild ? lastChild.order : null, null)
  target.collapsed = false
  return true
}

/** 删除（含子树）。auto 节点不可删（其生命周期由派生管理）。 */
export function deleteNode(tree: OutlineTree, id: string): boolean {
  const node = tree.nodes.get(id)
  if (!isManual(node)) return false
  removeSubtree(tree, id)
  return true
}

/** 子树 → markdown（hulunote single_note.cljs:189 get-all-navs-content） */
export function subtreeToMarkdown(tree: OutlineTree, id: string, depth = 0): string {
  const node = tree.nodes.get(id)
  if (!node) return ''
  const indent = '  '.repeat(depth)
  let out = `${indent}- ${node.content}\n`
  for (const c of childrenOf(tree, id)) out += subtreeToMarkdown(tree, c.id, depth + 1)
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/outline/commands.test.ts`  
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/commands.ts src/lib/outline/commands.test.ts
git commit -m "feat(outline): structure commands ported from hulunote render.cljs (manual-only guard)"
```

---

### Task 8: shortcuts.ts — 快捷键引擎

**Files:**

- Create: `src/lib/outline/shortcuts.ts`
- Test: `src/lib/outline/shortcuts.test.ts`

移植来源：hulunote `shortcuts.cljs`（normalize-key / normalize-shortcut / display-shortcut / event->shortcut）。`isMac` 作为参数注入（测试可控）。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/outline/shortcuts.test.ts
import { describe, it, expect } from 'vitest'
import {
  normalizeShortcut, displayShortcut, eventToShortcut,
  DEFAULT_SHORTCUTS, resolveShortcuts, findConflict,
} from './shortcuts'

describe('normalizeShortcut (shortcuts.cljs:51)', () => {
  it('canonical order Mod>Alt>Shift, upper-cases single keys', () => {
    expect(normalizeShortcut('shift+cmd+o')).toBe('Mod+Shift+O')
    expect(normalizeShortcut('Ctrl + b')).toBe('Mod+B')
    expect(normalizeShortcut('option+ArrowUp')).toBe('Alt+ArrowUp')
  })
  it('null without a main key', () => {
    expect(normalizeShortcut('cmd+shift')).toBeNull()
    expect(normalizeShortcut('')).toBeNull()
  })
})

describe('displayShortcut (shortcuts.cljs:76)', () => {
  it('mac symbols, no separator', () => {
    expect(displayShortcut('Mod+Shift+O', true)).toBe('⌘⇧O')
    expect(displayShortcut('Alt+ArrowUp', true)).toBe('⌥↑')
  })
  it('win names with separator', () => {
    expect(displayShortcut('Mod+Shift+O', false)).toBe('Ctrl + Shift + O')
  })
})

describe('eventToShortcut (shortcuts.cljs:99)', () => {
  const ev = (o: Partial<KeyboardEvent>) => o as KeyboardEvent
  it('builds from modifiers + key', () => {
    expect(eventToShortcut(ev({ key: 'o', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false }))).toBe('Mod+Shift+O')
    expect(eventToShortcut(ev({ key: 'Tab', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false }))).toBe('Shift+Tab')
  })
  it('bare modifier key → null', () => {
    expect(eventToShortcut(ev({ key: 'Meta', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }))).toBeNull()
  })
})

describe('resolve + conflicts', () => {
  it('user overrides beat defaults', () => {
    const r = resolveShortcuts({ 'outline.indent': 'Mod+]' })
    expect(r['outline.indent']).toBe('Mod+]')
    expect(r['outline.outdent']).toBe(DEFAULT_SHORTCUTS['outline.outdent'])
  })
  it('findConflict detects duplicate binding', () => {
    const r = resolveShortcuts({ 'outline.indent': DEFAULT_SHORTCUTS['outline.outdent'] })
    expect(findConflict(r, 'outline.indent')).toBe('outline.outdent')
    expect(findConflict(resolveShortcuts({}), 'outline.indent')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/shortcuts.test.ts`  
Expected: FAIL — Cannot find module './shortcuts'

- [ ] **Step 3: 实现**

```ts
// src/lib/outline/shortcuts.ts
export type OutlineCommandId =
  | 'outline.indent' | 'outline.outdent' | 'outline.toggleCollapse'
  | 'outline.moveUp' | 'outline.moveDown' | 'outline.bold' | 'outline.italic'

export const DEFAULT_SHORTCUTS: Record<OutlineCommandId, string> = {
  'outline.indent': 'Tab',
  'outline.outdent': 'Shift+Tab',
  'outline.toggleCollapse': 'Mod+ArrowUp',
  'outline.moveUp': 'Alt+ArrowUp',
  'outline.moveDown': 'Alt+ArrowDown',
  'outline.bold': 'Mod+B',
  'outline.italic': 'Mod+I',
}

const MODIFIER_ORDER = ['Mod', 'Alt', 'Shift']

/** shortcuts.cljs:27 normalize-key */
function normalizeKey(key: string): string | null {
  if (!key) return null
  const map: Record<string, string> = { Esc: 'Escape', Spacebar: 'Space', ' ': 'Space' }
  const k = map[key] ?? key
  return k.length === 1 ? k.toUpperCase() : k
}

/** shortcuts.cljs:51 normalize-shortcut */
export function normalizeShortcut(shortcut: string): string | null {
  if (!shortcut) return null
  const parts = shortcut.split('+').map(p => p.trim()).filter(Boolean)
  const normalized = parts.map(p => {
    const lower = p.toLowerCase()
    if (['cmd', 'command', 'meta', 'ctrl', 'control', 'mod'].includes(lower)) return 'Mod'
    if (['alt', 'option'].includes(lower)) return 'Alt'
    if (lower === 'shift') return 'Shift'
    return normalizeKey(p)
  })
  const mods = [...new Set(normalized.filter(p => MODIFIER_ORDER.includes(p!)))] as string[]
  mods.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))
  const main = normalized.find(p => p && !MODIFIER_ORDER.includes(p))
  if (!main) return null
  return [...mods, main].join('+')
}

/** shortcuts.cljs:76 display-shortcut */
export function displayShortcut(shortcut: string, isMac: boolean): string {
  const normalized = normalizeShortcut(shortcut)
  if (!normalized) return ''
  const sym: Record<string, [string, string]> = {
    Mod: ['⌘', 'Ctrl'], Alt: ['⌥', 'Alt'], Shift: ['⇧', 'Shift'],
    ArrowUp: ['↑', '↑'], ArrowDown: ['↓', '↓'], ArrowLeft: ['←', '←'], ArrowRight: ['→', '→'],
    Escape: ['Esc', 'Esc'], Backspace: ['⌫', '⌫'], Delete: ['Del', 'Del'],
  }
  const parts = normalized.split('+').map(p => (sym[p] ? sym[p][isMac ? 0 : 1] : p))
  return parts.join(isMac ? '' : ' + ')
}

/** shortcuts.cljs:99 event->shortcut */
export function eventToShortcut(e: KeyboardEvent): string | null {
  const key = normalizeKey(e.key)
  if (!key || ['Meta', 'Control', 'Shift', 'Alt'].includes(key)) return null
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('Mod')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return normalizeShortcut(parts.join('+'))
}

export function resolveShortcuts(overrides: Partial<Record<OutlineCommandId, string>>): Record<OutlineCommandId, string> {
  const out = { ...DEFAULT_SHORTCUTS }
  for (const [id, sc] of Object.entries(overrides)) {
    const n = sc ? normalizeShortcut(sc) : null
    if (n && id in out) out[id as OutlineCommandId] = n
  }
  return out
}

/** 同表内冲突检测（shortcuts.cljs:133 conflicting-command 语义） */
export function findConflict(resolved: Record<OutlineCommandId, string>, id: OutlineCommandId): OutlineCommandId | null {
  const target = normalizeShortcut(resolved[id])
  for (const [other, sc] of Object.entries(resolved)) {
    if (other !== id && normalizeShortcut(sc) === target) return other as OutlineCommandId
  }
  return null
}

/** 事件 → 命令 id（编辑器 keydown 用） */
export function matchCommand(e: KeyboardEvent, resolved: Record<OutlineCommandId, string>): OutlineCommandId | null {
  const sc = eventToShortcut(e)
  if (!sc) return null
  for (const [id, bound] of Object.entries(resolved)) {
    if (bound === sc) return id as OutlineCommandId
  }
  return null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/outline/shortcuts.test.ts`  
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/shortcuts.ts src/lib/outline/shortcuts.test.ts
git commit -m "feat(outline): shortcut engine ported from hulunote shortcuts.cljs"
```

### Task 9: backlinks.ts — 文件夹级反链索引

**Files:**

- Create: `src/lib/outline/backlinks.ts`
- Test: `src/lib/outline/backlinks.test.ts`

设计：纯逻辑（索引数据结构 + 单文件更新）与 IO（读目录/读文件）分离，测试只测纯逻辑。IO 走 `@tauri-apps/plugin-fs` 的 `readDir`/`readTextFile`，目录递归模式照抄 `folder-view.svelte.ts:128`。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/outline/backlinks.test.ts
import { describe, it, expect } from 'vitest'
import { createIndex, indexFileContent, removeFileFromIndex, backlinksFor, pageNameOf, pageCandidates } from './backlinks'

describe('pageNameOf', () => {
  it('strips extension and .notes suffix', () => {
    expect(pageNameOf('/dir/Foo.md')).toBe('Foo')
    expect(pageNameOf('/dir/Foo.notes.md')).toBe('Foo')
    expect(pageNameOf('/dir/a.b.md')).toBe('a.b')
  })
})

describe('index', () => {
  it('collects [[links]] and #tags with node text and line', () => {
    const idx = createIndex()
    indexFileContent(idx, '/d/one.notes.md', '- see [[Target]] here\n- #Target tagged\n- nothing\n')
    expect(backlinksFor(idx, 'target')).toEqual([
      { file: '/d/one.notes.md', text: 'see [[Target]] here', line: 1 },
      { file: '/d/one.notes.md', text: '#Target tagged', line: 2 },
    ])
  })
  it('re-indexing a file replaces its old entries', () => {
    const idx = createIndex()
    indexFileContent(idx, '/d/a.md', 'x [[T]]\n')
    indexFileContent(idx, '/d/a.md', 'no links now\n')
    expect(backlinksFor(idx, 't')).toEqual([])
  })
  it('removeFileFromIndex drops entries', () => {
    const idx = createIndex()
    indexFileContent(idx, '/d/a.md', '[[T]]\n')
    removeFileFromIndex(idx, '/d/a.md')
    expect(backlinksFor(idx, 't')).toEqual([])
  })
  it('pageCandidates lists indexed file pages, unique', () => {
    const idx = createIndex()
    indexFileContent(idx, '/d/Alpha.md', 'x\n')
    indexFileContent(idx, '/d/Alpha.notes.md', 'y\n')
    indexFileContent(idx, '/d/Beta.md', 'z\n')
    expect(pageCandidates(idx).sort()).toEqual(['Alpha', 'Beta'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/backlinks.test.ts`
Expected: FAIL — Cannot find module './backlinks'

- [ ] **Step 3: 实现**

```ts
// src/lib/outline/backlinks.ts
import { parseInline } from './parser'

export interface BacklinkHit { file: string; text: string; line: number }

export interface BacklinkIndex {
  /** lowercased target → hits */
  byTarget: Map<string, BacklinkHit[]>
  /** file → its targets（增量更新用） */
  fileTargets: Map<string, Set<string>>
  /** 已索引文件的页面名（[[ 补全候选） */
  filePages: Map<string, string>
}

export function createIndex(): BacklinkIndex {
  return { byTarget: new Map(), fileTargets: new Map(), filePages: new Map() }
}

export function pageNameOf(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.notes\.md$/i, '').replace(/\.md$/i, '')
}

export function removeFileFromIndex(idx: BacklinkIndex, file: string): void {
  const targets = idx.fileTargets.get(file)
  if (targets) {
    for (const t of targets) {
      const hits = idx.byTarget.get(t)?.filter(h => h.file !== file) ?? []
      if (hits.length) idx.byTarget.set(t, hits)
      else idx.byTarget.delete(t)
    }
  }
  idx.fileTargets.delete(file)
  idx.filePages.delete(file)
}

/** 单文件（重新）索引：逐行提取 [[..]] 与 #tag */
export function indexFileContent(idx: BacklinkIndex, file: string, content: string): void {
  removeFileFromIndex(idx, file)
  idx.filePages.set(file, pageNameOf(file))
  const targets = new Set<string>()
  content.split('\n').forEach((rawLine, i) => {
    const text = rawLine.replace(/^\s*- /, '').trim()
    if (!text) return
    for (const node of parseInline(text)) {
      let target: string | null = null
      if (node.t === 'page-link') target = node.target
      else if (node.t === 'hashtag') target = node.tag
      if (!target) continue
      const key = target.toLowerCase()
      targets.add(key)
      const hits = idx.byTarget.get(key) ?? []
      hits.push({ file, text, line: i + 1 })
      idx.byTarget.set(key, hits)
    }
  })
  idx.fileTargets.set(file, targets)
}

export function backlinksFor(idx: BacklinkIndex, page: string): BacklinkHit[] {
  return idx.byTarget.get(page.toLowerCase()) ?? []
}

export function pageCandidates(idx: BacklinkIndex): string[] {
  return [...new Set(idx.filePages.values())]
}

// ---------- IO（组件层调用；vitest 不覆盖，走手动验证） ----------

const MAX_FILE_BYTES = 1024 * 1024 // spec 性能护栏：仅解析 ≤1MB

/** 扫描 rootDir 下所有 .md 建全量索引（递归、跳过点目录/点文件） */
export async function buildFolderIndex(rootDir: string): Promise<BacklinkIndex> {
  const { readDir, readTextFile, stat } = await import('@tauri-apps/plugin-fs')
  const idx = createIndex()
  const walk = async (dir: string): Promise<void> => {
    const entries = await readDir(dir).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const path = (dir.endsWith('/') ? dir.slice(0, -1) : dir) + '/' + e.name
      if (e.isDirectory) { await walk(path); continue }
      if (!/\.md$/i.test(e.name)) continue
      const info = await stat(path).catch(() => null)
      if (info && info.size > MAX_FILE_BYTES) continue
      const content = await readTextFile(path).catch(() => null)
      if (content != null) indexFileContent(idx, path, content)
    }
  }
  await walk(rootDir)
  return idx
}

/** file-watcher 事件驱动的单文件增量重扫 */
export async function refreshFileInIndex(idx: BacklinkIndex, path: string): Promise<void> {
  if (!/\.md$/i.test(path)) return
  const { readTextFile } = await import('@tauri-apps/plugin-fs')
  const content = await readTextFile(path).catch(() => null)
  if (content == null) removeFileFromIndex(idx, path)
  else indexFileContent(idx, path, content)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/outline/backlinks.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/backlinks.ts src/lib/outline/backlinks.test.ts
git commit -m "feat(outline): folder-scoped backlink index for [[links]] and #tags"
```

---

### Task 10: completion.ts — `/` 菜单项 + `[[` 补全过滤

**Files:**

- Create: `src/lib/outline/completion.ts`
- Test: `src/lib/outline/completion.test.ts`

移植来源：hulunote `render.cljs:60-113`（slash-commands 表）、`render.cljs:115-123`（filtered-slash-commands）、`render.cljs:166-242`（page-link 菜单查询/确认语义）。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/outline/completion.test.ts
import { describe, it, expect } from 'vitest'
import { SLASH_ITEMS, filterSlashItems, applySlashItem, pageLinkQueryAt, confirmPageLink, filterPages } from './completion'

describe('slash items (render.cljs:60)', () => {
  it('filter matches id and label, case-insensitive', () => {
    expect(filterSlashItems('bold').map(i => i.id)).toEqual(['bold'])
    expect(filterSlashItems('').length).toBe(SLASH_ITEMS.length)
    expect(filterSlashItems('zzz')).toEqual([])
  })
  it('applySlashItem replaces /query and positions cursor', () => {
    // content: "note /bo"，slash 起点 5，光标 8
    const r = applySlashItem('note /bo', 5, 8, SLASH_ITEMS.find(i => i.id === 'bold')!)
    expect(r.text).toBe('note ****')
    expect(r.cursor).toBe(7)
  })
  it('link item inserts [[]] with cursor inside', () => {
    const r = applySlashItem('/li', 0, 3, SLASH_ITEMS.find(i => i.id === 'link')!)
    expect(r.text).toBe('[[]]')
    expect(r.cursor).toBe(2)
  })
})

describe('page-link query (render.cljs:166)', () => {
  it('extracts open [[query before cursor', () => {
    expect(pageLinkQueryAt('see [[abc', 9)).toEqual({ start: 4, query: 'abc' })
    expect(pageLinkQueryAt('see [[abc]]', 11)).toBeNull()  // 已闭合
    expect(pageLinkQueryAt('no link', 7)).toBeNull()
  })
  it('confirmPageLink replaces query with selection (render.cljs:211)', () => {
    const r = confirmPageLink('see [[abc]] x', 4, 'abc', 'Actual Page')
    expect(r.text).toBe('see [[Actual Page]] x')
    expect(r.cursor).toBe(19)
  })
  it('confirmPageLink keeps typed text when no selection (render.cljs:232)', () => {
    const r = confirmPageLink('see [[abc]] x', 4, 'abc', null)
    expect(r.text).toBe('see [[abc]] x')
    expect(r.cursor).toBe(11)
  })
})

describe('filterPages', () => {
  it('prefix matches first, then substring, case-insensitive', () => {
    expect(filterPages(['Beta', 'alpha', 'Alphabet', 'Gamma'], 'al')).toEqual(['alpha', 'Alphabet'])
    expect(filterPages(['Beta', 'Tabla'], 'ab')).toEqual(['Tabla'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/completion.test.ts`
Expected: FAIL — Cannot find module './completion'

- [ ] **Step 3: 实现**

```ts
// src/lib/outline/completion.ts
export interface SlashItem {
  id: string
  label: string
  icon: string
  /** 插入片段与光标在片段内的偏移 */
  insert: () => { snippet: string; cursorOffset: number }
}

/** hulunote render.cljs:60 slash-commands 表（面板适用子集） */
export const SLASH_ITEMS: SlashItem[] = [
  { id: 'link', label: '[[]]  Page Link', icon: '🔗', insert: () => ({ snippet: '[[]]', cursorOffset: 2 }) },
  { id: 'bold', label: '**Bold**', icon: 'B', insert: () => ({ snippet: '****', cursorOffset: 2 }) },
  { id: 'italic', label: '__Italic__', icon: 'I', insert: () => ({ snippet: '____', cursorOffset: 2 }) },
  { id: 'strikethrough', label: '~~Strikethrough~~', icon: 'S', insert: () => ({ snippet: '~~~~', cursorOffset: 2 }) },
  { id: 'highlight', label: '^^Highlight^^', icon: 'H', insert: () => ({ snippet: '^^^^', cursorOffset: 2 }) },
  { id: 'code', label: '`Code`', icon: '<>', insert: () => ({ snippet: '``', cursorOffset: 1 }) },
  { id: 'codeblock', label: '``` Code Block', icon: '{}', insert: () => ({ snippet: '```\n\n```', cursorOffset: 4 }) },
]

/** hulunote render.cljs:115 filtered-slash-commands */
export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return SLASH_ITEMS
  return SLASH_ITEMS.filter(i => i.id.includes(q) || i.label.toLowerCase().includes(q))
}

/** 用所选项替换 content 中 slashStart..cursor 的 `/query` 段 */
export function applySlashItem(content: string, slashStart: number, cursor: number, item: SlashItem):
  { text: string; cursor: number } {
  const { snippet, cursorOffset } = item.insert()
  const text = content.slice(0, slashStart) + snippet + content.slice(cursor)
  return { text, cursor: slashStart + cursorOffset }
}

/** hulunote render.cljs:166 — 光标前最近的未闭合 [[ */
export function pageLinkQueryAt(content: string, cursor: number): { start: number; query: string } | null {
  const before = content.slice(0, cursor)
  const open = before.lastIndexOf('[[')
  if (open < 0) return null
  const between = before.slice(open + 2)
  if (between.includes(']]')) return null
  return { start: open, query: between }
}

/**
 * hulunote render.cljs:211/232 — 确认 [[query]]：
 * selection 非空替换 query，否则保留手输文字；光标移到 ]] 之后。
 * `start` = `[[` 的位置；假设 query 后紧跟自动补出的 `]]`。
 */
export function confirmPageLink(content: string, start: number, query: string, selection: string | null):
  { text: string; cursor: number } {
  const target = selection ?? query
  const closeAt = start + 2 + query.length
  const text = content.slice(0, start) + '[[' + target + ']]' + content.slice(closeAt + 2)
  return { text, cursor: start + 2 + target.length + 2 }
}

/** 前缀命中排前，其余子串命中排后 */
export function filterPages(pages: string[], query: string): string[] {
  const q = query.toLowerCase()
  const prefix: string[] = []
  const substr: string[] = []
  for (const p of pages) {
    const lower = p.toLowerCase()
    if (lower.startsWith(q)) prefix.push(p)
    else if (lower.includes(q)) substr.push(p)
  }
  return [...prefix, ...substr]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/outline/completion.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/completion.ts src/lib/outline/completion.test.ts
git commit -m "feat(outline): slash items and page-link completion semantics from hulunote"
```

### Task 11: store.svelte.ts — 面板运行时状态与加载/保存/同步管线

**Files:**

- Create: `src/lib/outline/store.svelte.ts`
- Test: `src/lib/outline/store.test.ts`（仅纯逻辑：companionPathFor、persistIdsFor）

职责：当前主文件的伴生树、编辑焦点、脏标记；`attachTab()` 加载伴生文件（无则由主文派生）；主文变化 debounce 300ms → `syncAutoItems`；树变更 debounce 800ms → 序列化写伴生文件；伴生文件外部变更处理。**任何路径不写主文件。**

- [ ] **Step 1: 写失败测试（纯逻辑部分）**

```ts
// src/lib/outline/store.test.ts
import { describe, it, expect } from 'vitest'
import { companionPathFor, persistIdsFor } from './store.svelte'
import { createTree, addNode } from './model'

describe('companionPathFor', () => {
  it('maps main file to sibling .notes.md', () => {
    expect(companionPathFor('/d/foo.md')).toBe('/d/foo.notes.md')
    expect(companionPathFor('/d/bar.markdown')).toBe('/d/bar.notes.md')
  })
  it('null for companion files themselves and non-md', () => {
    expect(companionPathFor('/d/foo.notes.md')).toBeNull()
    expect(companionPathFor('/d/x.png')).toBeNull()
  })
})

describe('persistIdsFor', () => {
  it('collects block-ref targets and auto nodes with manual children', () => {
    const t = createTree()
    addNode(t, { id: 'toc1', parentId: null, order: 0, content: 'T', collapsed: false, source: 'toc', anchorLine: 1 })
    addNode(t, { id: 'm1', parentId: 'toc1', order: 0, content: 'child', collapsed: false, source: 'manual' })
    addNode(t, { id: 'm2', parentId: null, order: 100, content: 'see ((m1))', collapsed: false, source: 'manual' })
    const ids = persistIdsFor(t)
    expect(ids.has('toc1')).toBe(true)   // auto 带手写子节点 → 保 id
    expect(ids.has('m1')).toBe(true)     // 被 ((m1)) 引用
    expect(ids.has('m2')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/store.test.ts`
Expected: FAIL — Cannot find module './store.svelte'

- [ ] **Step 3: 实现**

```ts
// src/lib/outline/store.svelte.ts
import { SvelteMap } from 'svelte/reactivity'
import { createTree, childrenOf, type OutlineTree, type OutlineNode } from './model'
import { serializeOutline, parseOutline } from './markdown'
import { deriveAutoItems } from './derive'
import { syncAutoItems, regenerate as regenerateTree } from './sync'
import { parseInline } from './parser'
import type { BacklinkIndex } from './backlinks'

export interface OutlineState {
  /** 主文件路径（当前面板绑定的 tab 文件） */
  mainPath: string | null
  companionPath: string | null
  tree: OutlineTree
  /** 触发 Svelte 重渲染的版本号：任何树结构/内容变更后 bump */
  version: number
  editingId: string | null
  dirty: boolean
  /** 伴生文件被外部改且本地有未存改动 */
  externalConflict: boolean
  backlinkIndex: BacklinkIndex | null
}

export const outline = $state<OutlineState>({
  mainPath: null,
  companionPath: null,
  tree: createTree(),
  version: 0,
  editingId: null,
  dirty: false,
  externalConflict: false,
  backlinkIndex: null,
})

export function bump(): void { outline.version++ }

export function companionPathFor(mainPath: string): string | null {
  if (/\.notes\.md$/i.test(mainPath)) return null
  const m = mainPath.match(/^(.*)\.(md|markdown|mdown|mkd)$/i)
  return m ? `${m[1]}.notes.md` : null
}

/** 需要写 id:: 的节点：被 ((ref)) 引用的 + 带手写子节点的 auto 节点 */
export function persistIdsFor(tree: OutlineTree): Set<string> {
  const ids = new Set<string>()
  for (const n of tree.nodes.values()) {
    for (const seg of parseInline(n.content)) {
      if (seg.t === 'block-ref' && tree.nodes.has(seg.refId)) ids.add(seg.refId)
    }
    if (n.source !== 'manual' && childrenOf(tree, n.id).some(c => c.source === 'manual')) ids.add(n.id)
  }
  return ids
}

// ---------- IO 管线（组件层通过这些函数驱动；手动验证覆盖） ----------

let ourLastWrite = ''   // 识别自写事件，避免 file-watcher 回环

export async function attachTab(mainPath: string, mainContent: string): Promise<void> {
  const companion = companionPathFor(mainPath)
  if (!companion) { detach(); return }
  if (outline.mainPath === mainPath) return
  outline.mainPath = mainPath
  outline.companionPath = companion
  outline.editingId = null
  outline.dirty = false
  outline.externalConflict = false
  const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
  if (await exists(companion).catch(() => false)) {
    const text = await readTextFile(companion).catch(() => null)
    outline.tree = text != null ? parseOutline(text) : createTree()
  } else {
    outline.tree = createTree()
  }
  // 附加后立刻对当前主文内容跑一次同步（含首开派生）
  syncAutoItems(outline.tree, deriveAutoItems(mainContent))
  bump()
}

export function detach(): void {
  outline.mainPath = null
  outline.companionPath = null
  outline.tree = createTree()
  outline.editingId = null
  outline.dirty = false
  bump()
}

// -- 主文变化 → debounce 300ms 同步（spec"实时同步"）
let syncTimer: ReturnType<typeof setTimeout> | null = null
export function scheduleSyncFromMain(mainContent: string): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncAutoItems(outline.tree, deriveAutoItems(mainContent))
    bump()
    markDirty()
  }, 300)
}

export function regenerate(mainContent: string): void {
  regenerateTree(outline.tree, deriveAutoItems(mainContent))
  bump()
  markDirty()
}

// -- 树变更 → debounce 800ms 写伴生文件；关面板/换 tab 前调 flushSave()
let saveTimer: ReturnType<typeof setTimeout> | null = null
export function markDirty(): void {
  outline.dirty = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void flushSave() }, 800)
}

export async function flushSave(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  if (!outline.dirty || !outline.companionPath) return
  const text = serializeOutline(outline.tree, persistIdsFor(outline.tree))
  ourLastWrite = text
  const { writeTextFile } = await import('@tauri-apps/plugin-fs')
  try {
    await writeTextFile(outline.companionPath, text)
    outline.dirty = false
  } catch (e) {
    console.warn('[outline] save failed:', e)
    const { pushToast } = await import('../toast.svelte')
    pushToast({ level: 'error', message: String(e) })
  }
}

/** 伴生文件外部变更：无未存改动 → 静默重载；有 → 标记冲突条（spec"保存与错误处理"） */
export async function onCompanionExternalChange(): Promise<void> {
  if (!outline.companionPath) return
  const { readTextFile } = await import('@tauri-apps/plugin-fs')
  const text = await readTextFile(outline.companionPath).catch(() => null)
  if (text == null || text === ourLastWrite) return
  if (outline.dirty) { outline.externalConflict = true; return }
  outline.tree = parseOutline(text)
  bump()
}

export function resolveConflictKeepMine(): void {
  outline.externalConflict = false
  markDirty()
}

export async function resolveConflictReload(): Promise<void> {
  outline.externalConflict = false
  outline.dirty = false
  await onCompanionExternalChange()
}
```

**实现注意**：
- `pushToast` 的导入路径以实际为准（`grep -rn "export function pushToast" src/lib/` 确认，现有代码在 App.svelte 中使用，模块通常是 `src/lib/toast.svelte.ts`；若不同请改成实际路径）。
- `SvelteMap` import 如未用到可删（tree 是普通 Map + version bump 驱动重渲染，这是刻意选择：避免深层响应式开销）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/outline/store.test.ts`
Expected: PASS (3 tests)。注意 vitest 对 `.svelte.ts` 文件 runes 的支持：本仓库 vitest 配置已处理（`themes.test.ts` 等先例）；若 `$state` 报错，检查测试是否只 import 纯函数——`companionPathFor`/`persistIdsFor` 不触发 `$state` 执行即可（顶层 `$state` 调用需要 svelte 编译；若报错，把这两个纯函数移到 `store-utils.ts` 再由 store 引用，测试改 import `./store-utils`）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/store.svelte.ts src/lib/outline/store.test.ts
git commit -m "feat(outline): runtime store — attach/sync/save pipeline, external change handling"
```

### Task 12: 树 UI — InlineRender / OutlineNode / OutlinePanel 填充

**Files:**

- Create: `src/components/outline/InlineRender.svelte`
- Create: `src/components/outline/OutlineNode.svelte`
- Modify: `src/components/outline/OutlinePanel.svelte`（替换 Task 1 的壳 body）
- Modify: `src/lib/i18n/en.ts` `zh.ts` `ja.ts`

行为（hulunote render.cljs nav-input/nav-bullet）：非编辑态渲染 AST；点击进入编辑（textarea 显示原始文本）；失焦保存回节点。固定键 + 可配置键在 textarea keydown 处理。auto 节点只读（无编辑态，点击走跳转，Task 15 接线）。

- [ ] **Step 1: InlineRender.svelte**

```svelte
<script lang="ts">
  import { parseInline } from '../../lib/outline/parser'
  let { content, onPageClick }: { content: string; onPageClick?: (target: string) => void } = $props()
  let segments = $derived(parseInline(content))
</script>

{#each segments as seg}
  {#if seg.t === 'text'}{seg.text}
  {:else if seg.t === 'page-link'}<button class="pl" onclick={() => onPageClick?.(seg.target)}>[[{seg.target}]]</button>
  {:else if seg.t === 'hashtag'}<button class="pl tag" onclick={() => onPageClick?.(seg.tag)}>#{seg.tag}</button>
  {:else if seg.t === 'block-ref'}<span class="block-ref" title={seg.refId}>(({seg.refId}))</span>
  {:else if seg.t === 'bold'}<strong>{seg.text}</strong>
  {:else if seg.t === 'italics'}<em>{seg.text}</em>
  {:else if seg.t === 'strikethrough'}<s>{seg.text}</s>
  {:else if seg.t === 'highlight'}<mark>{seg.text}</mark>
  {:else if seg.t === 'code'}<code>{seg.text}</code>
  {:else if seg.t === 'link'}<a href={seg.url} target="_blank" rel="noreferrer">{seg.text}</a>
  {:else if seg.t === 'image'}<img src={seg.url} alt={seg.alt} />
  {:else if seg.t === 'url'}<a href={seg.url} target="_blank" rel="noreferrer">{seg.url}</a>
  {/if}
{/each}

<style>
  .pl { background: none; border: none; padding: 0; color: var(--accent-color, #4a80d4); cursor: pointer; font: inherit; }
  .block-ref { border-bottom: 1px dashed currentColor; opacity: 0.8; }
  mark { background: var(--highlight-bg, #fde68a); border-radius: 2px; }
  img { max-width: 100%; }
</style>
```

- [ ] **Step 2: OutlineNode.svelte（递归组件）**

```svelte
<script lang="ts">
  import OutlineNode from './OutlineNode.svelte'
  import InlineRender from './InlineRender.svelte'
  import { outline, bump, markDirty } from '../../lib/outline/store.svelte'
  import { childrenOf, type OutlineNode as NodeT } from '../../lib/outline/model'
  import {
    createSiblingBelow, createSiblingAbove, mergeWithPrevious,
    indentNode, outdentNode, moveNodeUp, moveNodeDown, applyInlineWrap,
  } from '../../lib/outline/commands'
  import { visibleNodes } from '../../lib/outline/model'
  import { matchCommand, type OutlineCommandId } from '../../lib/outline/shortcuts'

  let {
    node, depth, resolved, onJump, onPageClick, onEditorInput, onContextMenu, onDragOp,
  }: {
    node: NodeT
    depth: number
    resolved: Record<OutlineCommandId, string>
    onJump: (n: NodeT) => void
    onPageClick: (target: string) => void
    /** 编辑态每次 input：内容、光标、textarea 元素（菜单锚定用，Task 13） */
    onEditorInput: (node: NodeT, value: string, cursor: number, el: HTMLTextAreaElement, e?: KeyboardEvent) => boolean
    onContextMenu: (e: MouseEvent, n: NodeT) => void
    onDragOp: (drag: string, target: string, mode: 'sibling' | 'child') => void
  } = $props()

  let kids = $derived.by(() => { void outline.version; return childrenOf(outline.tree, node.id) })
  let editing = $derived(outline.editingId === node.id)
  let textareaEl: HTMLTextAreaElement | undefined = $state()

  $effect(() => { if (editing && textareaEl) textareaEl.focus() })

  function startEdit() {
    if (node.source !== 'manual') { onJump(node); return }
    outline.editingId = node.id
  }
  function commitEdit(value: string) {
    node.content = value
    outline.editingId = null
    bump(); markDirty()
  }

  function focusNode(id: string | null) {
    outline.editingId = id
  }

  function onKeydown(e: KeyboardEvent) {
    const el = e.currentTarget as HTMLTextAreaElement
    // 先给菜单层机会（/ 与 [[ 菜单打开时接管 ↑↓/Enter/Esc）
    if (onEditorInput(node, el.value, el.selectionStart, el, e)) { e.preventDefault(); return }

    const atStart = el.selectionStart === 0 && el.selectionEnd === 0
    const atEnd = el.selectionStart === el.value.length

    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      node.content = el.value
      // 行首 Enter → 上方建兄弟（render.cljs handle-key-down 语义）
      const id = atStart && el.value.length > 0
        ? createSiblingAbove(outline.tree, node.id)
        : createSiblingBelow(outline.tree, node.id)
      bump(); markDirty(); focusNode(id)
      return
    }
    if (e.key === 'Backspace' && atStart) {
      const res = mergeWithPrevious(outline.tree, node.id)
      if (res) { e.preventDefault(); bump(); markDirty(); focusNode(res.mergedInto) }
      return
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.altKey) {
      const vis = visibleNodes(outline.tree)
      const idx = vis.findIndex(n => n.id === node.id)
      const nb = e.key === 'ArrowUp' ? (atStart ? vis[idx - 1] : null) : (atEnd ? vis[idx + 1] : null)
      if (nb) {
        e.preventDefault()
        node.content = el.value
        bump(); markDirty()
        focusNode(nb.source === 'manual' ? nb.id : null)
      }
      return
    }
    const cmd = matchCommand(e, resolved)
    if (!cmd) return
    e.preventDefault()
    node.content = el.value
    if (cmd === 'outline.indent') indentNode(outline.tree, node.id)
    else if (cmd === 'outline.outdent') outdentNode(outline.tree, node.id)
    else if (cmd === 'outline.toggleCollapse') node.collapsed = !node.collapsed
    else if (cmd === 'outline.moveUp') moveNodeUp(outline.tree, node.id)
    else if (cmd === 'outline.moveDown') moveNodeDown(outline.tree, node.id)
    else if (cmd === 'outline.bold' || cmd === 'outline.italic') {
      const r = applyInlineWrap(el.value, el.selectionStart, el.selectionEnd, cmd === 'outline.bold' ? '**' : '__')
      el.value = r.text
      el.setSelectionRange(r.selStart, r.selEnd)
      node.content = r.text
    }
    bump(); markDirty()
  }

  // 拖拽（render.cljs:733 detect-drop-mode：落点 X 在文本左缘右侧 → child）
  let dropMode: 'sibling' | 'child' | null = $state(null)
  function onDragStart(e: DragEvent) {
    if (node.source !== 'manual') { e.preventDefault(); return }
    e.dataTransfer?.setData('text/outline-node', node.id)
  }
  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('text/outline-node')) return
    e.preventDefault()
    const row = e.currentTarget as HTMLElement
    const contentEl = row.querySelector('.content')
    const textLeft = contentEl?.getBoundingClientRect().left ?? 0
    dropMode = e.clientX >= textLeft ? 'child' : 'sibling'
  }
  function onDrop(e: DragEvent) {
    const dragId = e.dataTransfer?.getData('text/outline-node')
    if (dragId && dropMode) onDragOp(dragId, node.id, dropMode)
    dropMode = null
  }
</script>

<div class="node" style="--depth: {depth}">
  <div
    class="row"
    class:auto={node.source !== 'manual'}
    class:drop-sibling={dropMode === 'sibling'}
    class:drop-child={dropMode === 'child'}
    role="treeitem"
    aria-selected={editing}
    ondragover={onDragOver}
    ondragleave={() => (dropMode = null)}
    ondrop={onDrop}
    oncontextmenu={(e) => { e.preventDefault(); onContextMenu(e, node) }}
  >
    {#if kids.length > 0}
      <button class="tri" class:closed={node.collapsed}
        onclick={() => { node.collapsed = !node.collapsed; bump(); markDirty() }}>▾</button>
    {:else}<span class="tri-spacer"></span>{/if}
    <span
      class="bullet"
      class:src-toc={node.source === 'toc'}
      class:src-hl={node.source === 'highlight'}
      draggable={node.source === 'manual'}
      ondragstart={onDragStart}
    >•</span>
    {#if editing}
      <textarea
        bind:this={textareaEl}
        class="content edit"
        rows="1"
        value={node.content}
        onblur={(e) => commitEdit((e.currentTarget as HTMLTextAreaElement).value)}
        onkeydown={onKeydown}
        oninput={(e) => {
          const el = e.currentTarget as HTMLTextAreaElement
          el.style.height = 'auto'
          el.style.height = el.scrollHeight + 'px'
          onEditorInput(node, el.value, el.selectionStart, el)
        }}
      ></textarea>
    {:else}
      <span class="content" onclick={startEdit} role="button" tabindex="0"
        onkeydown={(e) => { if (e.key === 'Enter') startEdit() }}>
        <InlineRender content={node.content} onPageClick={onPageClick} />
      </span>
    {/if}
  </div>
  {#if !node.collapsed}
    {#each kids as child (child.id)}
      <OutlineNode node={child} depth={depth + 1} {resolved} {onJump} {onPageClick} {onEditorInput} {onContextMenu} {onDragOp} />
    {/each}
  {/if}
</div>

<style>
  .node { margin-left: calc(var(--depth) * 0px); }
  .row {
    display: flex; align-items: flex-start; gap: 4px;
    padding: 1px 4px 1px calc(var(--depth) * 16px + 4px);
    border-radius: 4px; font-size: 13px; line-height: 1.5;
  }
  .row:hover { background: var(--hover-bg, #8881); }
  .row.drop-sibling { box-shadow: 0 2px 0 var(--accent-color, #4a80d4); }
  .row.drop-child { box-shadow: inset 2px 0 0 var(--accent-color, #4a80d4); background: #4a80d411; }
  .row.auto .content { opacity: 0.92; }
  .tri { background: none; border: none; padding: 0; width: 14px; cursor: pointer; font-size: 10px; opacity: 0.6; transition: transform 0.1s; }
  .tri.closed { transform: rotate(-90deg); }
  .tri-spacer { width: 14px; flex-shrink: 0; }
  .bullet { cursor: grab; opacity: 0.7; }
  .bullet.src-toc { color: var(--accent-color, #4a80d4); }
  .bullet.src-hl { color: #d4a94a; }
  .content { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; cursor: text; }
  textarea.edit {
    resize: none; overflow: hidden; border: none; outline: 1px solid var(--accent-color, #4a80d4);
    border-radius: 3px; background: transparent; color: inherit; font: inherit; padding: 0 2px;
  }
</style>
```

- [ ] **Step 3: OutlinePanel.svelte body 填充**

替换 Task 1 壳的 `<div class="body">` 与 script（保留 splitter）。新增职责：attach 当前 tab、监听主文内容变化、根层渲染、重新生成按钮、根层"添加笔记"按钮、卸载时 flushSave。

```svelte
<script lang="ts">
  import type { Tab } from '../../lib/tabs.svelte'
  import { outlineGate, setOutlineWidth, MIN_WIDTH, MAX_WIDTH } from '../../lib/outline/gate.svelte'
  import { t } from '../../lib/i18n/store.svelte'
  import OutlineNode from './OutlineNode.svelte'
  import {
    outline, attachTab, detach, scheduleSyncFromMain, regenerate,
    flushSave, bump, markDirty,
  } from '../../lib/outline/store.svelte'
  import { childrenOf, newId, calculateOrderBetween, type OutlineNode as NodeT } from '../../lib/outline/model'
  import { moveNodeAfter, moveNodeToChild } from '../../lib/outline/commands'
  import { resolveShortcuts, type OutlineCommandId } from '../../lib/outline/shortcuts'
  import { requestReveal } from '../../lib/outline/reveal'   // Task 15
  import { openPageOrCreate } from '../../lib/outline/backlinks-io'  // Task 16 提供；之前先注释

  let { tab }: { tab: Tab } = $props()

  // resolved shortcuts：Task 17 接设置覆盖；先用默认表
  let resolved = $state(resolveShortcuts({}))

  // 绑定当前 tab + 主文内容变化驱动同步
  $effect(() => {
    if (tab.filePath) void attachTab(tab.filePath, tab.currentContent)
  })
  $effect(() => {
    const content = tab.currentContent
    if (outline.mainPath === tab.filePath) scheduleSyncFromMain(content)
  })
  $effect(() => () => { void flushSave(); detach() })  // unmount 兜底保存

  let roots = $derived.by(() => { void outline.version; return childrenOf(outline.tree, null) })

  function onJump(n: NodeT) { if (n.anchorLine != null) requestReveal(n.anchorLine, n.content) }
  function onPageClick(target: string) { void openPageOrCreate(target) }
  function onDragOp(drag: string, target: string, mode: 'sibling' | 'child') {
    const ok = mode === 'child' ? moveNodeToChild(outline.tree, drag, target) : moveNodeAfter(outline.tree, drag, target)
    if (ok) { bump(); markDirty() }
  }
  function addRootNote() {
    const last = roots[roots.length - 1]
    const node: NodeT = {
      id: newId(), parentId: null, order: calculateOrderBetween(last ? last.order : null, null),
      content: '', collapsed: false, source: 'manual',
    }
    outline.tree.nodes.set(node.id, node)
    outline.editingId = node.id
    bump(); markDirty()
  }
  async function onRegenerate() {
    const { confirm } = await import('@tauri-apps/plugin-dialog')
    if (await confirm(t('outline.regenerateConfirm'), { title: t('outline.regenerate') })) {
      regenerate(tab.currentContent)
    }
  }
  // Task 13 填充：菜单接线；本任务先永远返回 false
  function onEditorInput(): boolean { return false }
  function onContextMenu(): void {}   // Task 14 填充
</script>
```

模板 body 部分：

```svelte
  <header>
    <span class="title">{t('outline.title')}</span>
    <button class="hbtn" title={t('outline.regenerate')} onclick={onRegenerate}>⟳</button>
    <button class="hbtn" title={t('outline.addNote')} onclick={addRootNote}>＋</button>
  </header>
  {#if outline.externalConflict}
    <div class="conflict">{t('outline.externalChanged')}</div>
  {/if}
  <div class="body" role="tree">
    {#each roots as node (node.id)}
      <OutlineNode {node} depth={0} {resolved} {onJump} {onPageClick} {onEditorInput} {onContextMenu} {onDragOp} />
    {/each}
    {#if roots.length === 0}
      <p class="empty">{t('outline.empty')}</p>
    {/if}
  </div>
```

（`openPageOrCreate` 与 `requestReveal` 在 Task 15/16 落地前，可临时用空实现占位常量以保编译，任务完成后替换成真实 import——两个 Task 紧随其后。）

- [ ] **Step 4: i18n key**

en/zh/ja 各加：`outline.regenerate`（Regenerate from source / 重新从原文提取 / 原文から再生成）、`outline.regenerateConfirm`（Rebuild auto items from the source document? Manual notes are kept. / 从原文重建自动项？手写笔记会保留。/ 原文から自動項目を再構築しますか？手書きノートは保持されます。）、`outline.addNote`（Add note / 添加笔记 / ノートを追加）、`outline.empty`（No outline yet / 暂无大纲 / アウトラインはまだありません）、`outline.externalChanged`（Companion file changed on disk / 伴生文件在磁盘上已被修改 / ノートファイルが外部で変更されました）。

- [ ] **Step 5: 验证**

Run: `pnpm check && pnpm test`
Expected: 全绿。

手动：打开含标题+高亮的 .md → 面板出现 toc/highlight 节点（bullet 颜色区分）→ ＋ 添加手写节点，Enter/Tab/Shift+Tab/⌘↑/Alt↑↓ 全部生效 → 拖拽手写节点到目标（左缘=兄弟线、文本区=子块高亮）→ 编辑主文标题 ≤1s 面板跟随 → 删除 `^^..^^` 对应节点消失 → `.notes.md` 文件生成且原文件未变（`git diff` 或 mtime 验证）。

- [ ] **Step 6: Commit**

```bash
git add src/components/outline src/lib/i18n
git commit -m "feat(outline): tree UI — inline render, node editing, keyboard, drag-drop"
```

### Task 13: SlashMenu + LinkAutocomplete 浮层

**Files:**

- Create: `src/components/outline/SlashMenu.svelte`
- Create: `src/components/outline/LinkAutocomplete.svelte`
- Modify: `src/components/outline/OutlinePanel.svelte`（实装 `onEditorInput`）
- Modify: `src/components/outline/OutlineNode.svelte`（`[` 自动补对）

菜单状态放 Panel（同一时刻至多一个菜单）。锚定：以 textarea 元素的 boundingRect 底部为菜单位置（逐字符光标定位是加分项，不做）。

- [ ] **Step 1: 两个浮层组件**

`SlashMenu.svelte`：

```svelte
<script lang="ts">
  import type { SlashItem } from '../../lib/outline/completion'
  let { items, selected, x, y, onPick }: {
    items: SlashItem[]; selected: number; x: number; y: number; onPick: (item: SlashItem) => void
  } = $props()
</script>

<div class="menu" style="left: {x}px; top: {y}px" role="listbox">
  {#each items as item, i}
    <button class="item" class:sel={i === selected} role="option" aria-selected={i === selected}
      onmousedown={(e) => { e.preventDefault(); onPick(item) }}>
      <span class="icon">{item.icon}</span>{item.label}
    </button>
  {/each}
  {#if items.length === 0}<div class="item none">—</div>{/if}
</div>

<style>
  .menu {
    position: fixed; z-index: 100; min-width: 180px; max-height: 240px; overflow-y: auto;
    background: var(--panel-bg, #fff); border: 1px solid var(--border-color, #ccc);
    border-radius: 6px; box-shadow: 0 4px 16px #0003; padding: 4px;
  }
  .item { display: flex; gap: 8px; width: 100%; text-align: left; background: none; border: none;
    padding: 5px 8px; border-radius: 4px; font-size: 13px; cursor: pointer; color: inherit; }
  .item.sel, .item:hover { background: var(--accent-color, #4a80d4); color: #fff; }
  .item.none { opacity: 0.5; cursor: default; }
  .icon { width: 18px; }
</style>
```

`LinkAutocomplete.svelte`（同样式，候选为字符串）：

```svelte
<script lang="ts">
  let { pages, selected, x, y, onPick }: {
    pages: string[]; selected: number; x: number; y: number; onPick: (page: string) => void
  } = $props()
</script>

<div class="menu" style="left: {x}px; top: {y}px" role="listbox">
  {#each pages as page, i}
    <button class="item" class:sel={i === selected} role="option" aria-selected={i === selected}
      onmousedown={(e) => { e.preventDefault(); onPick(page) }}>{page}</button>
  {/each}
  {#if pages.length === 0}<div class="item none">—</div>{/if}
</div>

<style>
  /* 与 SlashMenu 相同的 .menu/.item 样式，复制即可 */
  .menu { position: fixed; z-index: 100; min-width: 180px; max-height: 240px; overflow-y: auto;
    background: var(--panel-bg, #fff); border: 1px solid var(--border-color, #ccc);
    border-radius: 6px; box-shadow: 0 4px 16px #0003; padding: 4px; }
  .item { display: block; width: 100%; text-align: left; background: none; border: none;
    padding: 5px 8px; border-radius: 4px; font-size: 13px; cursor: pointer; color: inherit; }
  .item.sel, .item:hover { background: var(--accent-color, #4a80d4); color: #fff; }
  .item.none { opacity: 0.5; cursor: default; }
</style>
```

- [ ] **Step 2: Panel 中的菜单状态机（实装 onEditorInput）**

OutlinePanel script 增加：

```ts
import SlashMenu from './SlashMenu.svelte'
import LinkAutocomplete from './LinkAutocomplete.svelte'
import { filterSlashItems, applySlashItem, pageLinkQueryAt, confirmPageLink, filterPages, type SlashItem } from '../../lib/outline/completion'
import { pageCandidates } from '../../lib/outline/backlinks'

type MenuState =
  | { kind: 'none' }
  | { kind: 'slash'; nodeId: string; start: number; query: string; selected: number; x: number; y: number; el: HTMLTextAreaElement }
  | { kind: 'link'; nodeId: string; start: number; query: string; selected: number; x: number; y: number; el: HTMLTextAreaElement }
let menu = $state<MenuState>({ kind: 'none' })

let slashItems = $derived(menu.kind === 'slash' ? filterSlashItems(menu.query) : [])
let linkPages = $derived(menu.kind === 'link'
  ? filterPages(outline.backlinkIndex ? pageCandidates(outline.backlinkIndex) : [], menu.query)
  : [])

function menuAnchor(el: HTMLTextAreaElement): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  return { x: Math.min(r.left, window.innerWidth - 220), y: r.bottom + 2 }
}

function applyToTextarea(el: HTMLTextAreaElement, node: NodeT, text: string, cursor: number) {
  el.value = text
  node.content = text
  el.setSelectionRange(cursor, cursor)
  bump(); markDirty()
}

/** 返回 true = 事件被菜单消费（keydown 时 Node 组件会 preventDefault） */
function onEditorInput(node: NodeT, value: string, cursor: number, el: HTMLTextAreaElement, e?: KeyboardEvent): boolean {
  // --- keydown 阶段：菜单打开时接管导航键 ---
  if (e && menu.kind !== 'none') {
    const count = menu.kind === 'slash' ? slashItems.length : linkPages.length
    if (e.key === 'ArrowDown') { menu.selected = (menu.selected + 1) % Math.max(count, 1); return true }
    if (e.key === 'ArrowUp') { menu.selected = (menu.selected - 1 + Math.max(count, 1)) % Math.max(count, 1); return true }
    if (e.key === 'Escape') { menu = { kind: 'none' }; return true }
    if (e.key === 'Enter') {
      if (menu.kind === 'slash' && slashItems[menu.selected]) { pickSlash(slashItems[menu.selected]); return true }
      if (menu.kind === 'link') { pickPage(linkPages[menu.selected] ?? null); return true }
      menu = { kind: 'none' }
      return false
    }
    return false
  }
  if (e) {
    // `[` 后接着输 `[` → 自动补 `]]` 并开链接菜单（render.cljs:1117）
    if (e.key === '[' && value[cursor - 1] === '[') {
      const text = value.slice(0, cursor) + '[]]' + value.slice(cursor)
      applyToTextarea(el, node, text, cursor + 1)
      menu = { kind: 'link', nodeId: node.id, start: cursor - 1, query: '', selected: 0, ...menuAnchor(el), el }
      return true
    }
    return false
  }
  // --- input 阶段：维护菜单 query / 触发 slash 菜单 ---
  if (menu.kind === 'link') {
    const q = pageLinkQueryAt(value, cursor)
    if (q && q.start === menu.start) menu.query = q.query
    else menu = { kind: 'none' }
    return false
  }
  if (menu.kind === 'slash') {
    const seg = value.slice(menu.start, cursor)
    if (seg.startsWith('/') && !seg.includes(' ')) { menu.query = seg.slice(1); menu.selected = 0 }
    else menu = { kind: 'none' }
    return false
  }
  // `/` 在行首或空格后触发（render.cljs filtered-slash-commands 语义）
  if (value[cursor - 1] === '/' && (cursor === 1 || /\s/.test(value[cursor - 2]))) {
    menu = { kind: 'slash', nodeId: node.id, start: cursor - 1, query: '', selected: 0, ...menuAnchor(el), el }
  }
  return false
}

function pickSlash(item: SlashItem) {
  if (menu.kind !== 'slash') return
  const node = outline.tree.nodes.get(menu.nodeId)
  if (node) {
    const r = applySlashItem(menu.el.value, menu.start, menu.el.selectionStart, item)
    applyToTextarea(menu.el, node, r.text, r.cursor)
  }
  menu = { kind: 'none' }
}

function pickPage(page: string | null) {
  if (menu.kind !== 'link') return
  const node = outline.tree.nodes.get(menu.nodeId)
  if (node) {
    const r = confirmPageLink(menu.el.value, menu.start, menu.query, page)
    applyToTextarea(menu.el, node, r.text, r.cursor)
  }
  menu = { kind: 'none' }
}
```

模板尾部（aside 内）：

```svelte
  {#if menu.kind === 'slash'}
    <SlashMenu items={slashItems} selected={menu.selected} x={menu.x} y={menu.y} onPick={pickSlash} />
  {:else if menu.kind === 'link'}
    <LinkAutocomplete pages={linkPages} selected={menu.selected} x={menu.x} y={menu.y} onPick={pickPage} />
  {/if}
```

- [ ] **Step 3: 验证**

Run: `pnpm check && pnpm test`
Expected: 全绿。

手动：手写节点内输 `/` → 菜单出现，继续输入过滤，↑↓ 选择，Enter 应用（`/bold` → `****` 光标居中）；输 `[[` → 自动补 `]]`、候选出现（需 Task 16 索引就绪后有数据），Enter 替换为所选页面、光标落 `]]` 后；无选中 Enter 保留手输文字；Esc 关闭。

- [ ] **Step 4: Commit**

```bash
git add src/components/outline
git commit -m "feat(outline): slash menu and [[ page-link autocomplete"
```

---

### Task 14: NodeContextMenu — 右键菜单

**Files:**

- Create: `src/components/outline/NodeContextMenu.svelte`
- Modify: `src/components/outline/OutlinePanel.svelte`（实装 `onContextMenu`）
- Modify: `src/lib/i18n/en.ts` `zh.ts` `ja.ts`

菜单项（spec"大纲交互"）：手写节点 = 复制文本 / 复制子树为 markdown / 复制块引用 / 删除；auto 节点 = 跳转原文 / 复制文本 / 复制子树为 markdown。

- [ ] **Step 1: 组件**

```svelte
<script lang="ts">
  import type { OutlineNode as NodeT } from '../../lib/outline/model'
  import { t } from '../../lib/i18n/store.svelte'
  let { node, x, y, onAction, onClose }: {
    node: NodeT; x: number; y: number
    onAction: (action: 'jump' | 'copy' | 'copy-subtree' | 'copy-ref' | 'delete', node: NodeT) => void
    onClose: () => void
  } = $props()
  const items = $derived(node.source === 'manual'
    ? (['copy', 'copy-subtree', 'copy-ref', 'delete'] as const)
    : (['jump', 'copy', 'copy-subtree'] as const))
  const labels: Record<string, string> = {
    jump: t('outline.jumpToSource'), copy: t('outline.copyText'),
    'copy-subtree': t('outline.copySubtree'), 'copy-ref': t('outline.copyBlockRef'),
    delete: t('outline.delete'),
  }
</script>

<svelte:window onclick={onClose} oncontextmenu={onClose} />
<div class="menu" style="left: {x}px; top: {y}px" role="menu">
  {#each items as action}
    <button class="item" class:danger={action === 'delete'} role="menuitem"
      onclick={(e) => { e.stopPropagation(); onAction(action, node); onClose() }}>
      {labels[action]}
    </button>
  {/each}
</div>

<style>
  .menu { position: fixed; z-index: 100; min-width: 170px; background: var(--panel-bg, #fff);
    border: 1px solid var(--border-color, #ccc); border-radius: 6px; box-shadow: 0 4px 16px #0003; padding: 4px; }
  .item { display: block; width: 100%; text-align: left; background: none; border: none;
    padding: 5px 8px; border-radius: 4px; font-size: 13px; cursor: pointer; color: inherit; }
  .item:hover { background: var(--hover-bg, #8882); }
  .item.danger:hover { background: #d44a4a; color: #fff; }
</style>
```

- [ ] **Step 2: Panel 接线**

```ts
import NodeContextMenu from './NodeContextMenu.svelte'
import { deleteNode, subtreeToMarkdown } from '../../lib/outline/commands'

let ctxMenu = $state<{ node: NodeT; x: number; y: number } | null>(null)

function onContextMenu(e: MouseEvent, node: NodeT) {
  ctxMenu = { node, x: e.clientX, y: e.clientY }
}
async function onCtxAction(action: string, node: NodeT) {
  const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
  if (action === 'jump') onJump(node)
  else if (action === 'copy') await writeText(node.content)
  else if (action === 'copy-subtree') await writeText(subtreeToMarkdown(outline.tree, node.id))
  else if (action === 'copy-ref') { await writeText(`((${node.id}))`); markDirty() } // 懒分配：markDirty 触发保存，persistIdsFor 因引用存在而写 id::
  else if (action === 'delete') {
    const { confirm } = await import('@tauri-apps/plugin-dialog')
    const kids = childrenOf(outline.tree, node.id).length
    if (kids === 0 || await confirm(t('outline.deleteConfirm'), { title: t('outline.delete') })) {
      if (deleteNode(outline.tree, node.id)) { bump(); markDirty() }
    }
  }
}
```

模板：`{#if ctxMenu}<NodeContextMenu node={ctxMenu.node} x={ctxMenu.x} y={ctxMenu.y} onAction={onCtxAction} onClose={() => (ctxMenu = null)} />{/if}`

**注意 copy-ref 的懒 id**：`((id))` 复制后只有当它被粘贴进某个节点内容里，`persistIdsFor` 才会在序列化时写 `id::`。若引用被粘去别的文件，本文件不会写 `id::`——为保证目标可回溯，`copy-ref` 时直接把该节点加入一个 `pinnedIds: Set<string>` 常驻集合（存 store 模块级变量，`flushSave` 时并入 `persistIdsFor` 结果），确保 id 落盘。实现：store.svelte.ts 加 `export const pinnedIds = new Set<string>()`，`flushSave` 中 `serializeOutline(outline.tree, new Set([...persistIdsFor(outline.tree), ...pinnedIds]))`；`onCtxAction` 的 copy-ref 分支调用 `pinnedIds.add(node.id)`。

- [ ] **Step 3: i18n key**

en/zh/ja 各加：`outline.jumpToSource`（Jump to source / 跳转到原文 / 原文へジャンプ）、`outline.copyText`（Copy text / 复制文本 / テキストをコピー）、`outline.copySubtree`（Copy subtree as Markdown / 复制子树为 Markdown / サブツリーを Markdown としてコピー）、`outline.copyBlockRef`（Copy block reference / 复制块引用 / ブロック参照をコピー）、`outline.delete`（Delete / 删除 / 削除）、`outline.deleteConfirm`（Delete this node and all its children? / 删除该节点及其全部子节点？/ このノードとすべての子ノードを削除しますか？）。

- [ ] **Step 4: 验证 + Commit**

Run: `pnpm check`，手动验证四个动作 + auto 节点菜单差异。

```bash
git add src/components/outline src/lib/i18n src/lib/outline/store.svelte.ts
git commit -m "feat(outline): node context menu (copy / copy-subtree / block-ref / delete)"
```

### Task 15: reveal.ts — 反向跳转（点大纲 → 原文定位）

**Files:**

- Create: `src/lib/outline/reveal.ts`
- Modify: `src/components/SourceView.svelte`（source 模式定位）
- Modify: `src/components/RichEditor.svelte`（rich 模式定位）

机制：`reveal.ts` 是一个 `$state` 请求总线（无 DOM 依赖）；两个编辑器组件各自 `$effect` 消费。source 模式按行号滚动 textarea；rich 模式在渲染 DOM 里按文本查找并 `scrollIntoView`。

- [ ] **Step 1: reveal.ts**

```ts
// src/lib/outline/reveal.ts
export interface RevealRequest {
  seq: number
  /** 主文档 1-based 行号 */
  line: number
  /** 该行的锚文本（标题文本/高亮文本），rich 模式与 debounce 窗口兜底搜索用 */
  text: string
}

export const reveal = $state<{ req: RevealRequest | null }>({ req: null })

let seq = 0
export function requestReveal(line: number, text: string): void {
  reveal.req = { seq: ++seq, line, text }
}
```

（文件名用 `reveal.svelte.ts` —— `$state` 需要 svelte 编译，本仓库 `.svelte.ts` 后缀是惯例；File Map 与 import 相应为 `../../lib/outline/reveal.svelte`。）

- [ ] **Step 2: SourceView 消费（source 模式）**

`SourceView.svelte` script 增加（textarea 引用已有 `textareaEl`）：

```ts
import { reveal } from '../lib/outline/reveal.svelte'

let lastRevealSeq = 0
$effect(() => {
  const req = reveal.req
  if (!req || req.seq === lastRevealSeq || !textareaEl) return
  lastRevealSeq = req.seq
  const lines = value.split('\n')
  // 行号定位；若该行文本已变（debounce 窗口），按锚文本全文搜索兜底
  let lineIdx = req.line - 1
  if (lineIdx >= lines.length || !lines[lineIdx]?.includes(req.text)) {
    const found = lines.findIndex(l => l.includes(req.text))
    if (found >= 0) lineIdx = found
  }
  const offset = lines.slice(0, lineIdx).reduce((acc, l) => acc + l.length + 1, 0)
  textareaEl.focus()
  textareaEl.setSelectionRange(offset, offset + (lines[lineIdx]?.length ?? 0))
  // 估算滚动：行高 × 行号 - 视口的 1/3
  const lineHeight = parseFloat(getComputedStyle(textareaEl).lineHeight) || 20
  textareaEl.scrollTop = Math.max(0, lineIdx * lineHeight - textareaEl.clientHeight / 3)
})
```

- [ ] **Step 3: RichEditor 消费（rich 模式）**

`RichEditor.svelte` script 增加（编辑器容器元素引用名以该文件实际为准，下称 `rootEl`）：

```ts
import { reveal } from '../lib/outline/reveal.svelte'

let lastRevealSeq = 0
$effect(() => {
  const req = reveal.req
  if (!req || req.seq === lastRevealSeq || !rootEl) return
  lastRevealSeq = req.seq
  // 渲染 DOM 中按锚文本查找第一个匹配的元素
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT)
  let target: Element | null = null
  while (walker.nextNode()) {
    const tn = walker.currentNode as Text
    if (tn.textContent && tn.textContent.includes(req.text)) { target = tn.parentElement; break }
  }
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    target.classList.add('outline-reveal-flash')
    setTimeout(() => target!.classList.remove('outline-reveal-flash'), 1200)
  }
})
```

全局样式（`src/styles/editor-base.css` 尾部追加）：

```css
.outline-reveal-flash {
  animation: outline-reveal-flash 1.2s ease-out;
}
@keyframes outline-reveal-flash {
  0% { background-color: rgba(74, 128, 212, 0.35); }
  100% { background-color: transparent; }
}
```

- [ ] **Step 4: Panel 已在 Task 12 调 `requestReveal`（onJump）——去掉占位，接真实 import。**

- [ ] **Step 5: 验证 + Commit**

Run: `pnpm check`
手动：source 模式点 toc 节点 → 光标选中对应行并滚到视口；rich 模式点 → 对应标题滚动居中并闪烁；编辑原文后立即点击（debounce 窗口内）→ 文本搜索兜底仍能定位。

```bash
git add src/lib/outline/reveal.svelte.ts src/components/SourceView.svelte src/components/RichEditor.svelte src/styles/editor-base.css src/components/outline
git commit -m "feat(outline): reverse jump — reveal anchor line in source and rich modes"
```

---

### Task 16: 反链区 + 索引生命周期 + 页面打开

**Files:**

- Create: `src/components/outline/BacklinksSection.svelte`
- Create: `src/lib/outline/backlinks-io.svelte.ts`（索引生命周期 + openPageOrCreate）
- Modify: `src/components/outline/OutlinePanel.svelte`
- Modify: `src/lib/i18n/en.ts` `zh.ts` `ja.ts`

- [ ] **Step 1: backlinks-io.svelte.ts**

```ts
// src/lib/outline/backlinks-io.svelte.ts
import { watchImmediate } from '@tauri-apps/plugin-fs'
import { outline, bump } from './store.svelte'
import { buildFolderIndex, refreshFileInIndex, pageNameOf } from './backlinks'
import { folderView, parentDir } from '../folder-view.svelte'
import { openFile, tabs } from '../tabs.svelte'

let unwatch: (() => void) | null = null
let indexedRoot: string | null = null

/** 面板首次显示/主文件换目录时调用；插件关闭时 teardownIndex() */
export async function ensureIndex(mainPath: string): Promise<void> {
  // 范围：FolderView 根目录；未开文件夹 → 主文件所在目录（spec"未开文件夹时仅索引已打开标签页"的实用化：至少覆盖当前文件目录）
  const root = folderView.rootDir ?? parentDir(mainPath)
  if (indexedRoot === root && outline.backlinkIndex) return
  teardownIndex()
  indexedRoot = root
  outline.backlinkIndex = await buildFolderIndex(root)
  bump()
  let timer: ReturnType<typeof setTimeout> | null = null
  const pending = new Set<string>()
  watchImmediate(root, (ev) => {
    for (const p of (ev.paths ?? [])) if (/\.md$/i.test(p)) pending.add(p)
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      const idx = outline.backlinkIndex
      if (!idx) return
      for (const p of [...pending]) { pending.delete(p); await refreshFileInIndex(idx, p) }
      bump()
    }, 300)
  }, { recursive: true })
    .then(s => { unwatch = s })
    .catch(e => console.warn('[outline] backlink watch failed:', e))
}

export function teardownIndex(): void {
  if (unwatch) { try { unwatch() } catch { /* ignore */ } unwatch = null }
  outline.backlinkIndex = null
  indexedRoot = null
}

/** 点击 [[页面]]：找同目录同名 .md 打开；不存在则创建后打开 */
export async function openPageOrCreate(target: string): Promise<void> {
  const dir = indexedRoot ?? (outline.mainPath ? parentDir(outline.mainPath) : null)
  if (!dir) return
  const idx = outline.backlinkIndex
  const existing = idx ? [...idx.filePages.entries()].find(
    ([p, page]) => page.toLowerCase() === target.toLowerCase() && !/\.notes\.md$/i.test(p)) : null
  if (existing) { await openFile(existing[0]); return }
  const path = `${dir}/${target}.md`
  const { exists, writeTextFile } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(path).catch(() => false))) {
    await writeTextFile(path, `# ${target}\n`)
  }
  await openFile(path)
}

export function currentPageName(): string | null {
  return outline.mainPath ? pageNameOf(outline.mainPath) : null
}
```

（`openFile`/`tabs` 导出名以 `src/lib/tabs.svelte.ts` 实际为准——`openFile(path)` 已确认存在:136。`parentDir` 从 folder-view.svelte.ts 导入:18。）

- [ ] **Step 2: BacklinksSection.svelte**

```svelte
<script lang="ts">
  import { outline } from '../../lib/outline/store.svelte'
  import { backlinksFor } from '../../lib/outline/backlinks'
  import { currentPageName } from '../../lib/outline/backlinks-io.svelte'
  import { openFile } from '../../lib/tabs.svelte'
  import { t } from '../../lib/i18n/store.svelte'
  import InlineRender from './InlineRender.svelte'

  let hits = $derived.by(() => {
    void outline.version
    const page = currentPageName()
    if (!page || !outline.backlinkIndex) return []
    // 排除伴生文件对自己主文件的"自引用"噪音：保留，但排掉当前伴生文件
    return backlinksFor(outline.backlinkIndex, page).filter(h => h.file !== outline.companionPath)
  })
</script>

<section class="backlinks">
  <h3>{t('outline.backlinks')} <span class="count">{hits.length}</span></h3>
  {#each hits as hit}
    <button class="hit" onclick={() => void openFile(hit.file)}>
      <span class="file">{hit.file.split('/').pop()}</span>
      <span class="text"><InlineRender content={hit.text} /></span>
    </button>
  {/each}
  {#if hits.length === 0}<p class="none">{t('outline.noBacklinks')}</p>{/if}
</section>

<style>
  .backlinks { border-top: 1px solid var(--border-color, #3333); padding: 8px; }
  h3 { font-size: 12px; margin: 0 0 6px; opacity: 0.7; }
  .count { opacity: 0.6; font-weight: normal; }
  .hit { display: block; width: 100%; text-align: left; background: none; border: none;
    padding: 4px 6px; border-radius: 4px; cursor: pointer; color: inherit; font-size: 12px; }
  .hit:hover { background: var(--hover-bg, #8881); }
  .file { opacity: 0.6; margin-right: 6px; }
  .none { opacity: 0.5; font-size: 12px; }
</style>
```

- [ ] **Step 3: Panel 接线**

- `$effect`: `if (outlineGate.visible && tab.filePath) void ensureIndex(tab.filePath)`（索引惰性构建于面板首次显示，spec"性能护栏"）；
- unmount cleanup 中调用 `teardownIndex()`（与 flushSave 同处）；
- body 之后渲染 `<BacklinksSection />`；
- Task 12 中 `openPageOrCreate` 的占位换成真实 import。

- [ ] **Step 4: i18n key**

`outline.backlinks`（Backlinks / 反向链接 / バックリンク）、`outline.noBacklinks`（No backlinks / 暂无反向链接 / バックリンクはありません）。

- [ ] **Step 5: 验证 + Commit**

Run: `pnpm check && pnpm test`
手动：文件夹里另一文件写 `[[当前文件名]]` → 面板底部出现反链，点击打开该文件；`[[` 补全候选出现文件夹页面名；点大纲里 `[[新页面]]` → 创建 `新页面.md` 并打开。

```bash
git add src/lib/outline src/components/outline src/lib/i18n
git commit -m "feat(outline): backlinks section with folder index lifecycle and page open/create"
```

### Task 17: 快捷键改绑设置区

**Files:**

- Modify: `src/lib/outline/gate.svelte.ts`（快捷键覆盖的持久化——放 gate 因为 SettingsDialog 不应拉重模块）
- Modify: `src/components/SettingsDialog.svelte`
- Modify: `src/components/outline/OutlinePanel.svelte`（resolved 接覆盖）
- Modify: `src/lib/i18n/en.ts` `zh.ts` `ja.ts`

- [ ] **Step 1: gate 增加 shortcuts 持久化**

`gate.svelte.ts` 增加：

```ts
import { DEFAULT_SHORTCUTS, normalizeShortcut, type OutlineCommandId } from './shortcuts'

export const outlineShortcuts = $state<{ overrides: Partial<Record<OutlineCommandId, string>> }>({ overrides: {} })

// loadOutlineGate() 内追加：
//   outlineShortcuts.overrides = (await s.get<Partial<Record<OutlineCommandId, string>>>('outline.shortcuts')) ?? {}

export async function setShortcutOverride(id: OutlineCommandId, shortcut: string | null): Promise<void> {
  const n = shortcut ? normalizeShortcut(shortcut) : null
  if (n && n !== DEFAULT_SHORTCUTS[id]) outlineShortcuts.overrides[id] = n
  else delete outlineShortcuts.overrides[id]
  const s = await getStore()
  await s.set('outline.shortcuts', { ...outlineShortcuts.overrides })
  await s.save()
}
```

（`shortcuts.ts` 是纯模块，gate 引它不破坏懒加载——重的是 store/parser/sync/组件，那些仍只在面板 import 链上。）

- [ ] **Step 2: SettingsDialog 增加大纲快捷键区**

在 SettingsDialog 的既有设置区之后（插件区附近），gated on `isPluginEnabled('outline-notes')` 渲染改绑列表。录入方式：点击输入框 → 聚焦后按组合键 → `eventToShortcut` 捕获 → 冲突检查 → 保存：

```svelte
<script lang="ts">
  // 现有 import 之外新增：
  import { isPluginEnabled } from '../lib/settings.svelte'
  import { outlineShortcuts, setShortcutOverride } from '../lib/outline/gate.svelte'
  import {
    DEFAULT_SHORTCUTS, resolveShortcuts, displayShortcut, eventToShortcut, findConflict,
    type OutlineCommandId,
  } from '../lib/outline/shortcuts'
  import { t } from '../lib/i18n/store.svelte'

  const isMac = navigator.platform.includes('Mac')
  let recording = $state<OutlineCommandId | null>(null)
  let conflictMsg = $state('')
  let resolvedOutline = $derived(resolveShortcuts(outlineShortcuts.overrides))

  const OUTLINE_CMD_LABELS: Record<OutlineCommandId, string> = {
    'outline.indent': 'outline.cmd.indent', 'outline.outdent': 'outline.cmd.outdent',
    'outline.toggleCollapse': 'outline.cmd.toggleCollapse',
    'outline.moveUp': 'outline.cmd.moveUp', 'outline.moveDown': 'outline.cmd.moveDown',
    'outline.bold': 'outline.cmd.bold', 'outline.italic': 'outline.cmd.italic',
  }

  async function onRecordKey(e: KeyboardEvent, id: OutlineCommandId) {
    e.preventDefault(); e.stopPropagation()
    if (e.key === 'Escape') { recording = null; return }
    const sc = eventToShortcut(e)
    if (!sc) return
    const trial = resolveShortcuts({ ...outlineShortcuts.overrides, [id]: sc })
    const conflict = findConflict(trial, id)
    if (conflict) { conflictMsg = t('outline.shortcutConflict', { other: t(OUTLINE_CMD_LABELS[conflict] as never) }); return }
    conflictMsg = ''
    await setShortcutOverride(id, sc)
    recording = null
  }
</script>
```

模板（对话框内新增 section）：

```svelte
{#if isPluginEnabled('outline-notes')}
  <section class="settings-group">
    <h3>{t('outline.shortcutsTitle')}</h3>
    {#each Object.keys(DEFAULT_SHORTCUTS) as id (id)}
      <div class="shortcut-row">
        <span>{t(OUTLINE_CMD_LABELS[id as OutlineCommandId] as never)}</span>
        <button
          class="shortcut-input" class:recording={recording === id}
          onclick={() => (recording = id as OutlineCommandId)}
          onkeydown={(e) => recording === id && onRecordKey(e, id as OutlineCommandId)}
          onblur={() => recording === null || (recording = null)}
        >
          {recording === id ? t('outline.pressKeys') : displayShortcut(resolvedOutline[id as OutlineCommandId], isMac)}
        </button>
        {#if outlineShortcuts.overrides[id as OutlineCommandId]}
          <button class="reset" onclick={() => void setShortcutOverride(id as OutlineCommandId, null)}>↺</button>
        {/if}
      </div>
    {/each}
    {#if conflictMsg}<p class="conflict">{conflictMsg}</p>{/if}
  </section>
{/if}
```

样式沿用 SettingsDialog 现有 settings-group 类；`.shortcut-row { display:flex; gap:8px; align-items:center; }`、`.shortcut-input.recording { outline:1px solid var(--accent-color); }`、`.conflict { color:#d44a4a; font-size:12px; }`。

- [ ] **Step 3: Panel 的 resolved 接覆盖**

OutlinePanel 中 `let resolved = $state(resolveShortcuts({}))` 改为：

```ts
import { outlineShortcuts } from '../../lib/outline/gate.svelte'
let resolved = $derived(resolveShortcuts(outlineShortcuts.overrides))
```

- [ ] **Step 4: i18n key**

`outline.shortcutsTitle`（Outline shortcuts / 大纲快捷键 / アウトラインのショートカット）、`outline.pressKeys`（Press keys… / 按下组合键… / キーを押してください…）、`outline.shortcutConflict`（Conflicts with "{other}" / 与「{other}」冲突 / 「{other}」と競合しています）、`outline.cmd.indent`（Indent / 缩进 / インデント）、`outline.cmd.outdent`（Outdent / 反缩进 / アウトデント）、`outline.cmd.toggleCollapse`（Collapse/expand / 折叠/展开 / 折りたたみ切替）、`outline.cmd.moveUp`（Move up / 上移 / 上へ移動）、`outline.cmd.moveDown`（Move down / 下移 / 下へ移動）、`outline.cmd.bold`（Bold / 粗体 / 太字）、`outline.cmd.italic`（Italic / 斜体 / 斜体）。

- [ ] **Step 5: 验证 + Commit**

Run: `pnpm check && pnpm test`
手动：设置里改 Tab → Mod+]，面板内 Mod+] 生效、Tab 失效；改成与"反缩进"相同 → 冲突提示；↺ 恢复默认；重启后覆盖仍在。

```bash
git add src/lib/outline/gate.svelte.ts src/components/SettingsDialog.svelte src/components/outline/OutlinePanel.svelte src/lib/i18n
git commit -m "feat(outline): configurable shortcuts with conflict detection in settings"
```

---

### Task 18: 收尾 — 全量验证与验收清单

**Files:** 无新增（只修复发现的问题）

- [ ] **Step 1: 全量自动验证**

```bash
pnpm test        # 全部 vitest（含既有测试无回归）
pnpm check       # svelte-check 0 errors
```

- [ ] **Step 2: 验收清单逐项手动验证（spec"验收标准"）**

`pnpm tauri dev` 后：

1. **插件关闭零痕迹**：插件页关闭 Outline Notes → View 菜单无条目、无面板；DevTools Network/Sources 确认 `outline` chunk 未加载；
2. **往返无损**：建含手写+折叠+块引用的大纲 → 重启 → 面板状态完全恢复；`.notes.md` 手动打开内容正确；
3. **原文只读**：全流程操作后 `git diff` 主文件无变化（或对比 mtime）；
4. **实时同步 ≤1s**：改标题/加删 `^^..^^`/`==..==`；取消高亮 → 节点消失、其手写子节点重挂父级；
5. **反向跳转**：source 与 rich 两模式；debounce 窗口内点击兜底搜索生效；
6. **重新生成**：确认后 auto 全部重建、手写保留；
7. **菜单**：`/` 过滤+应用；`[[` 补全（选中替换/无选中保留/Esc）；右键四动作；
8. **反链**：跨文件 `[[引用]]` 出现在反链区，点击跳转；新建/删除文件后索引跟随（watcher）；
9. **快捷键**：改绑生效、冲突提示、重启保留。

发现问题：小问题当场修（当场 commit `fix(outline): ...`）；结构性问题回到对应 Task 重做。

- [ ] **Step 3: 最终 Commit（如有收尾修复）**

```bash
git add -A && git commit -m "fix(outline): final acceptance pass fixes"
```

---

## Self-Review 记录

- **Spec 覆盖**：插件化启停（T1）、零资源懒加载（T1/T16 teardown）、数据模型/分数排序（T2）、伴生文件往返（T3）、行内文法（T4）、TOC+高亮派生（T5）、diff 同步+手写保护+重新生成（T6）、结构命令+auto 只读（T7）、快捷键引擎（T8）、反链索引（T9）、菜单语义（T10）、运行时管线+外部变更（T11）、树 UI+拖拽（T12）、浮层菜单（T13）、右键菜单+懒 id（T14）、反向跳转 source/rich（T15）、反链区+页面打开（T16）、设置改绑（T17）、验收（T18）。✔ 无遗漏。
- **已知取舍**（与 spec 一致或已注明）：菜单锚定用 textarea 矩形而非逐字符光标位置；块引用悬停预览简化为 title 提示（spec 的"悬停预览"最小实现，后续可增强）；`reveal.ts` 实际文件名为 `reveal.svelte.ts`（runes 编译需要）。
- **类型一致性**：`OutlineNode`/`OutlineTree`/`AutoItem`/`SlashItem`/`OutlineCommandId` 各任务间签名已对齐；`store.svelte.ts` 导出 `persistIdsFor`/`companionPathFor` 若 vitest runes 受限则移 `store-utils.ts`（T11 Step 4 已注明处理办法）。





