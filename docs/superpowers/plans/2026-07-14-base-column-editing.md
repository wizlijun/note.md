# Base 列定义编辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 base 表格里直接编辑 `.base` 列定义(增/删列、重命名、调序、设 groupBy/默认排序)并经普通 tab 保存流写回文件。

**Architecture:** 所有编辑是纯函数(`base/edit.ts`):在 `parseBase` 得到的完整 `raw` 对象上施加操作 → `yaml.stringify` → 自检 → `setContent(tab.id, yaml)`(出脏点,复用现有保存流)。因始终整体序列化 `raw`,不支持的字段(formulas/summaries/cards)原样保留。UI 为列头内联 ⋯ 菜单 + "+" 加列 + 拖拽重排,拆成两个小组件。

**Tech Stack:** TypeScript, Svelte 5 runes, Vitest, `yaml` 包。

参照:`docs/superpowers/specs/2026-07-14-base-column-editing-design.md`

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/lib/base/model.ts` | `BaseView.sort?: BaseSort[]` + `ColumnMenuAction` 类型 | 改 |
| `src/lib/base/parse.ts` | 解析 `view.sort` | 改 |
| `src/lib/base/parse.test.ts` | `view.sort` 用例 | 改 |
| `src/lib/base/edit.ts` | 纯函数编辑器 + `toYaml` | 建 |
| `src/lib/base/edit.test.ts` | edit 单测 | 建 |
| `src/components/BaseColumnMenu.svelte` | 单列 ⋯ 菜单 | 建 |
| `src/components/BaseAddColumnMenu.svelte` | "+" 属性选择器 | 建 |
| `src/components/BaseView.svelte` | 编排:菜单/拖拽/派发 edit + setContent | 改 |
| `src/lib/i18n/{en,zh,ja,de}.ts` | `base.*` 文案 | 改 |

---

## Task 1: model + parse 支持 `view.sort`

**Files:**
- Modify: `src/lib/base/model.ts`, `src/lib/base/parse.ts`
- Test: `src/lib/base/parse.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/lib/base/parse.test.ts` 的 `describe('parseBase', ...)` 内追加:
```ts
  it('parses view.sort as a list of {property,direction}', () => {
    const cfg = parseBase(`
views:
  - type: table
    name: T
    sort:
      - property: note.rating
        direction: DESC
`)
    expect(cfg.views[0].sort).toEqual([{ property: 'note.rating', direction: 'DESC' }])
  })

  it('leaves view.sort undefined when absent', () => {
    const cfg = parseBase('views:\n  - type: table\n    name: T\n')
    expect(cfg.views[0].sort).toBeUndefined()
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/lib/base/parse.test.ts -t "view.sort"`
Expected: FAIL(`sort` 未解析,为 undefined 或类型不符)。第一个用例失败。

- [ ] **Step 3: 实现**

在 `src/lib/base/model.ts` 的 `BaseView` 接口加一行(在 `groupBy?` 附近):
```ts
  sort?: BaseSort[]
```

同文件末尾追加一个供 UI 用的动作类型:
```ts
/** A column-header menu action emitted by BaseColumnMenu → handled by BaseView. */
export type ColumnMenuAction =
  | { kind: 'rename'; name: string }
  | { kind: 'sort'; direction: SortDirection }
  | { kind: 'clearSort' }
  | { kind: 'group'; direction: SortDirection }
  | { kind: 'ungroup' }
  | { kind: 'move'; delta: -1 | 1 }
  | { kind: 'remove' }
```

在 `src/lib/base/parse.ts` 的 `toView` 返回对象里,`groupBy` 那行之后加:
```ts
    sort: Array.isArray(o.sort)
      ? o.sort.map(toSort).filter((s): s is BaseSort => !!s)
      : undefined,
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/lib/base/parse.test.ts`
Expected: PASS(含新 2 例)。

- [ ] **Step 5: 提交**

```bash
git add src/lib/base/model.ts src/lib/base/parse.ts src/lib/base/parse.test.ts
git commit -m "feat(base): parse view.sort + add ColumnMenuAction type

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `base/edit.ts` 纯函数编辑器

**Files:**
- Create: `src/lib/base/edit.ts`
- Test: `src/lib/base/edit.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/base/edit.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import {
  addColumn, removeColumn, moveColumn, renameColumn,
  setGroupBy, setSort, toYaml,
} from './edit'

// A raw config carrying fields we DON'T support, to prove round-trip preservation.
const RAW = {
  formulas: { ppu: '(price / age).toFixed(2)' },
  summaries: { customAvg: 'values.mean()' },
  properties: { 'note.status': { displayName: 'Status' } },
  views: [
    { type: 'table', name: 'T', order: ['file.name', 'note.status'] },
    { type: 'cards', name: 'C' },
  ],
}
const clone = () => JSON.parse(JSON.stringify(RAW))

describe('addColumn', () => {
  it('appends to an existing order', () => {
    const out = addColumn(clone(), 0, 'note.rating', ['file.name', 'note.status'])
    expect((out.views as any)[0].order).toEqual(['file.name', 'note.status', 'note.rating'])
  })
  it('materializes order from currentColumns when order is absent', () => {
    const raw = { views: [{ type: 'table', name: 'T' }] }
    const out = addColumn(raw, 0, 'note.x', ['file.name', 'note.a'])
    expect((out.views as any)[0].order).toEqual(['file.name', 'note.a', 'note.x'])
  })
  it('does not duplicate an existing column', () => {
    const out = addColumn(clone(), 0, 'note.status', ['file.name', 'note.status'])
    expect((out.views as any)[0].order).toEqual(['file.name', 'note.status'])
  })
})

describe('removeColumn', () => {
  it('removes the column from order', () => {
    const out = removeColumn(clone(), 0, 'note.status', ['file.name', 'note.status'])
    expect((out.views as any)[0].order).toEqual(['file.name'])
  })
})

describe('moveColumn', () => {
  it('moves a column to a new index', () => {
    const out = moveColumn(clone(), 0, 'file.name', 1, ['file.name', 'note.status'])
    expect((out.views as any)[0].order).toEqual(['note.status', 'file.name'])
  })
  it('is a no-op for an unknown column', () => {
    const out = moveColumn(clone(), 0, 'note.zzz', 0, ['file.name', 'note.status'])
    expect((out.views as any)[0].order).toEqual(['file.name', 'note.status'])
  })
})

describe('renameColumn', () => {
  it('sets displayName globally', () => {
    const out = renameColumn(clone(), 'note.rating', 'Score')
    expect((out.properties as any)['note.rating']).toEqual({ displayName: 'Score' })
  })
  it('empty name removes the displayName (and empty entry)', () => {
    const out = renameColumn(clone(), 'note.status', '')
    expect((out.properties as any)['note.status']).toBeUndefined()
  })
})

describe('setGroupBy / setSort', () => {
  it('sets and clears groupBy', () => {
    let out = setGroupBy(clone(), 0, 'note.status', 'ASC')
    expect((out.views as any)[0].groupBy).toEqual({ property: 'note.status', direction: 'ASC' })
    out = setGroupBy(out, 0, null, 'ASC')
    expect((out.views as any)[0].groupBy).toBeUndefined()
  })
  it('sets and clears sort (list form)', () => {
    let out = setSort(clone(), 0, 'note.rating', 'DESC')
    expect((out.views as any)[0].sort).toEqual([{ property: 'note.rating', direction: 'DESC' }])
    out = setSort(out, 0, null, 'DESC')
    expect((out.views as any)[0].sort).toBeUndefined()
  })
})

describe('round-trip preservation', () => {
  it('keeps unsupported fields (formulas/summaries/cards view) through edit + toYaml', () => {
    const out = addColumn(clone(), 0, 'note.rating', ['file.name', 'note.status'])
    const reparsed = parse(toYaml(out)) as any
    expect(reparsed.formulas).toEqual({ ppu: '(price / age).toFixed(2)' })
    expect(reparsed.summaries).toEqual({ customAvg: 'values.mean()' })
    expect(reparsed.views[1]).toEqual({ type: 'cards', name: 'C' })
  })
  it('does not mutate the input object', () => {
    const raw = clone()
    addColumn(raw, 0, 'note.rating', ['file.name', 'note.status'])
    expect(raw.views[0].order).toEqual(['file.name', 'note.status'])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/lib/base/edit.test.ts`
Expected: FAIL(`./edit` 不存在)。

- [ ] **Step 3: 实现**

创建 `src/lib/base/edit.ts`:
```ts
import { stringify } from 'yaml'
import type { SortDirection } from './model'

export type Raw = Record<string, unknown>

/** Deep clone plain YAML data (strings/numbers/bools/arrays/objects). */
function clone(v: unknown): Raw {
  return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : {}
}

function asObj(v: unknown): Raw {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {}
}

/** Clone `raw`, ensure `views[viewIndex]` exists as an object, return both. */
function ensureView(raw: Raw, viewIndex: number): { raw: Raw; view: Raw } {
  const out = clone(raw)
  if (!Array.isArray(out.views)) out.views = []
  const views = out.views as Raw[]
  while (views.length <= viewIndex) views.push({ type: 'table', name: 'Table' })
  const view = asObj(views[viewIndex])
  views[viewIndex] = view
  return { raw: out, view }
}

/** Return view.order, materializing it from currentColumns when missing/empty. */
function ensureOrder(view: Raw, currentColumns: string[]): string[] {
  if (Array.isArray(view.order) && view.order.length) {
    view.order = (view.order as unknown[]).filter((x): x is string => typeof x === 'string')
  } else {
    view.order = [...currentColumns]
  }
  return view.order as string[]
}

export function addColumn(raw: Raw, viewIndex: number, prop: string, currentColumns: string[]): Raw {
  const { raw: out, view } = ensureView(raw, viewIndex)
  const order = ensureOrder(view, currentColumns)
  if (!order.includes(prop)) order.push(prop)
  return out
}

export function removeColumn(raw: Raw, viewIndex: number, prop: string, currentColumns: string[]): Raw {
  const { raw: out, view } = ensureView(raw, viewIndex)
  const order = ensureOrder(view, currentColumns)
  view.order = order.filter((c) => c !== prop)
  return out
}

export function moveColumn(
  raw: Raw, viewIndex: number, prop: string, toIndex: number, currentColumns: string[],
): Raw {
  const { raw: out, view } = ensureView(raw, viewIndex)
  const order = ensureOrder(view, currentColumns)
  const from = order.indexOf(prop)
  if (from === -1) return out
  order.splice(from, 1)
  const clamped = Math.max(0, Math.min(order.length, toIndex))
  order.splice(clamped, 0, prop)
  view.order = order
  return out
}

/** Set/clear a global displayName. Empty name removes it (and an empty prop entry). */
export function renameColumn(raw: Raw, prop: string, name: string): Raw {
  const out = clone(raw)
  const props = asObj(out.properties)
  const entry = asObj(props[prop])
  if (name.trim()) {
    entry.displayName = name
    props[prop] = entry
  } else {
    delete entry.displayName
    if (Object.keys(entry).length === 0) delete props[prop]
    else props[prop] = entry
  }
  if (Object.keys(props).length === 0) delete out.properties
  else out.properties = props
  return out
}

export function setGroupBy(raw: Raw, viewIndex: number, prop: string | null, direction: SortDirection): Raw {
  const { raw: out, view } = ensureView(raw, viewIndex)
  if (prop) view.groupBy = { property: prop, direction }
  else delete view.groupBy
  return out
}

export function setSort(raw: Raw, viewIndex: number, prop: string | null, direction: SortDirection): Raw {
  const { raw: out, view } = ensureView(raw, viewIndex)
  if (prop) view.sort = [{ property: prop, direction }]
  else delete view.sort
  return out
}

export function toYaml(raw: Raw): string {
  return stringify(raw)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/lib/base/edit.test.ts`
Expected: PASS(全部)。

- [ ] **Step 5: 提交**

```bash
git add src/lib/base/edit.ts src/lib/base/edit.test.ts
git commit -m "feat(base): pure column-definition editors + YAML serialization

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `BaseColumnMenu.svelte` 单列菜单

**Files:**
- Create: `src/components/BaseColumnMenu.svelte`

无单测(UI);`pnpm check` 验证类型。i18n 键在 Task 6 添加,但本组件已引用 —— **先做 Task 6 或与之并做**。为避免顺序死锁:本任务直接引用 `t('base.colRename')` 等键;若 Task 6 未先做,`pnpm check` 会报 `keyof Messages` 错。**执行顺序:先做 Task 6(i18n),再做 Task 3/4/5。** 见计划末"执行顺序"。

- [ ] **Step 1: 写组件**

创建 `src/components/BaseColumnMenu.svelte`:
```svelte
<script lang="ts">
  import type { ColumnMenuAction } from '../lib/base/model'
  import { t } from '../lib/i18n/store.svelte'

  let {
    x, y, displayName, isGroup, isSort, onAction, onClose,
  }: {
    x: number
    y: number
    displayName: string
    isGroup: boolean
    isSort: boolean
    onAction: (a: ColumnMenuAction) => void
    onClose: () => void
  } = $props()

  let renaming = $state(false)
  let draft = $state('')

  function startRename() {
    draft = displayName
    renaming = true
  }
  function commitRename() {
    onAction({ kind: 'rename', name: draft })
    onClose()
  }
</script>

<svelte:window onclick={onClose} oncontextmenu={onClose} />

<div class="col-menu" style="left:{x}px; top:{y}px" role="menu" tabindex="-1"
     onclick={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === 'Escape') onClose() }}>
  {#if renaming}
    <input
      class="rename-input"
      bind:value={draft}
      placeholder={t('base.colRenamePlaceholder')}
      autofocus
      onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') onClose() }}
      onblur={commitRename}
    />
  {:else}
    <button type="button" onclick={startRename}>{t('base.colRename')}</button>
    <div class="sep"></div>
    <button type="button" onclick={() => { onAction({ kind: 'sort', direction: 'ASC' }); onClose() }}>{t('base.colSortAsc')}</button>
    <button type="button" onclick={() => { onAction({ kind: 'sort', direction: 'DESC' }); onClose() }}>{t('base.colSortDesc')}</button>
    {#if isSort}
      <button type="button" onclick={() => { onAction({ kind: 'clearSort' }); onClose() }}>{t('base.colClearSort')}</button>
    {/if}
    <div class="sep"></div>
    {#if isGroup}
      <button type="button" onclick={() => { onAction({ kind: 'ungroup' }); onClose() }}>{t('base.colUngroup')}</button>
    {:else}
      <button type="button" onclick={() => { onAction({ kind: 'group', direction: 'ASC' }); onClose() }}>{t('base.colGroupAsc')}</button>
      <button type="button" onclick={() => { onAction({ kind: 'group', direction: 'DESC' }); onClose() }}>{t('base.colGroupDesc')}</button>
    {/if}
    <div class="sep"></div>
    <button type="button" onclick={() => { onAction({ kind: 'move', delta: -1 }); onClose() }}>{t('base.colMoveLeft')}</button>
    <button type="button" onclick={() => { onAction({ kind: 'move', delta: 1 }); onClose() }}>{t('base.colMoveRight')}</button>
    <div class="sep"></div>
    <button type="button" class="danger" onclick={() => { onAction({ kind: 'remove' }); onClose() }}>{t('base.colRemove')}</button>
  {/if}
</div>

<style>
  .col-menu {
    position: fixed; z-index: 50; min-width: 160px;
    display: flex; flex-direction: column;
    background: Canvas; color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
    border-radius: 6px; padding: 4px;
    box-shadow: 0 6px 20px color-mix(in srgb, CanvasText 25%, transparent);
  }
  .col-menu button {
    text-align: left; padding: 5px 10px; border: 0; border-radius: 4px;
    background: transparent; color: inherit; font-size: 13px; cursor: pointer;
  }
  .col-menu button:hover { background: color-mix(in srgb, CanvasText 8%, Canvas); }
  .col-menu button.danger { color: #d9534f; }
  .sep { height: 1px; margin: 4px 6px; background: color-mix(in srgb, CanvasText 12%, transparent); }
  .rename-input {
    padding: 5px 8px; font-size: 13px; background: color-mix(in srgb, CanvasText 4%, Canvas);
    color: inherit; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 4px;
  }
</style>
```

- [ ] **Step 2: 类型检查**

Run: `pnpm check`
Expected: 与 `BaseColumnMenu.svelte` 相关 0 error(前提:Task 6 的 i18n 键已存在)。a11y 警告可忽略。

- [ ] **Step 3: 提交**

```bash
git add src/components/BaseColumnMenu.svelte
git commit -m "feat(base): per-column header menu component

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `BaseAddColumnMenu.svelte` 属性选择器

**Files:**
- Create: `src/components/BaseAddColumnMenu.svelte`

- [ ] **Step 1: 写组件**

创建 `src/components/BaseAddColumnMenu.svelte`:
```svelte
<script lang="ts">
  import { t } from '../lib/i18n/store.svelte'

  let {
    x, y, options, label, onPick, onClose,
  }: {
    x: number
    y: number
    options: string[]
    label: (prop: string) => string
    onPick: (prop: string) => void
    onClose: () => void
  } = $props()
</script>

<svelte:window onclick={onClose} oncontextmenu={onClose} />

<div class="add-menu" style="left:{x}px; top:{y}px" role="menu" tabindex="-1"
     onclick={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === 'Escape') onClose() }}>
  {#if options.length === 0}
    <div class="empty">{t('base.noAddableProps')}</div>
  {:else}
    {#each options as prop}
      <button type="button" onclick={() => { onPick(prop); onClose() }}>
        <span class="name">{label(prop)}</span>
        <span class="id">{prop}</span>
      </button>
    {/each}
  {/if}
</div>

<style>
  .add-menu {
    position: fixed; z-index: 50; min-width: 200px; max-height: 320px; overflow: auto;
    display: flex; flex-direction: column;
    background: Canvas; color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
    border-radius: 6px; padding: 4px;
    box-shadow: 0 6px 20px color-mix(in srgb, CanvasText 25%, transparent);
  }
  .add-menu button {
    display: flex; justify-content: space-between; gap: 12px; align-items: baseline;
    text-align: left; padding: 5px 10px; border: 0; border-radius: 4px;
    background: transparent; color: inherit; font-size: 13px; cursor: pointer;
  }
  .add-menu button:hover { background: color-mix(in srgb, CanvasText 8%, Canvas); }
  .add-menu .id { font-size: 11px; color: color-mix(in srgb, CanvasText 50%, Canvas); }
  .empty { padding: 8px 10px; font-size: 13px; color: color-mix(in srgb, CanvasText 55%, Canvas); }
</style>
```

- [ ] **Step 2: 类型检查**

Run: `pnpm check`
Expected: `BaseAddColumnMenu.svelte` 相关 0 error。

- [ ] **Step 3: 提交**

```bash
git add src/components/BaseAddColumnMenu.svelte
git commit -m "feat(base): add-column property picker component

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: BaseView 集成(菜单 + 拖拽 + 写回)

**Files:**
- Modify: `src/components/BaseView.svelte`

- [ ] **Step 1: 脚本区 — 导入与状态**

在 `BaseView.svelte` `<script>` 顶部导入区加:
```ts
  import { setContent } from '../lib/tabs.svelte'
  import { pushToast } from '../lib/toast.svelte'
  import * as edit from '../lib/base/edit'
  import type { ColumnMenuAction } from '../lib/base/model'
  import BaseColumnMenu from './BaseColumnMenu.svelte'
  import BaseAddColumnMenu from './BaseAddColumnMenu.svelte'
```

在 `let clickSort = $state(...)` 之后加编辑相关状态与派生:
```ts
  const editable = $derived(!config.error)
  const activeViewIndex = $derived(Math.min(viewIndex, config.views.length - 1))

  let colMenu = $state<{ x: number; y: number; col: string } | null>(null)
  let addMenu = $state<{ x: number; y: number } | null>(null)
  let dragCol = $state<string | null>(null)

  const FILE_PROPS = ['file.name', 'file.path', 'file.folder', 'file.ext', 'file.mtime', 'file.ctime', 'file.size', 'file.tags']

  // 可加入的属性:所有文件 frontmatter 键(note.*)∪ file.*,减去当前列
  const addableProps = $derived.by(() => {
    const set = new Set<string>(FILE_PROPS)
    for (const r of records) for (const k of Object.keys(r.frontmatter)) set.add('note.' + k)
    const used = new Set(columns)
    return [...set].filter((p) => !used.has(p))
  })
```

- [ ] **Step 2: 脚本区 — 排序优先级 + 写回 + 派发**

把现有 `rows` 派生里的这一行:
```ts
    const sort = clickSort ?? view.groupBy
```
改为(纳入持久化 `view.sort`):
```ts
    const sort = clickSort ?? view.sort?.[0] ?? view.groupBy
```

在 `label` 定义之后追加写回与派发逻辑:
```ts
  /** Serialize an edited raw config, self-check, then push into the tab (dirty → saved by the tab flow). */
  function applyRaw(nextRaw: edit.Raw) {
    const yaml = edit.toYaml(nextRaw)
    if (parseBase(yaml).error) {
      pushToast({ level: 'error', message: t('base.writeError') })
      return
    }
    setContent(tab.id, yaml)
  }

  function rawObj(): edit.Raw {
    return (config.raw ?? {}) as edit.Raw
  }

  function pickAdd(prop: string) {
    applyRaw(edit.addColumn(rawObj(), activeViewIndex, prop, columns))
  }

  function onColAction(col: string, a: ColumnMenuAction) {
    const i = activeViewIndex
    if (a.kind === 'rename') applyRaw(edit.renameColumn(rawObj(), col, a.name))
    else if (a.kind === 'sort') applyRaw(edit.setSort(rawObj(), i, col, a.direction))
    else if (a.kind === 'clearSort') applyRaw(edit.setSort(rawObj(), i, null, 'ASC'))
    else if (a.kind === 'group') applyRaw(edit.setGroupBy(rawObj(), i, col, a.direction))
    else if (a.kind === 'ungroup') applyRaw(edit.setGroupBy(rawObj(), i, null, 'ASC'))
    else if (a.kind === 'move') applyRaw(edit.moveColumn(rawObj(), i, col, columns.indexOf(col) + a.delta, columns))
    else if (a.kind === 'remove') applyRaw(edit.removeColumn(rawObj(), i, col, columns))
  }

  function openColMenu(e: MouseEvent, col: string) {
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    colMenu = { x: r.left, y: r.bottom + 2, col }
  }
  function openAddMenu(e: MouseEvent) {
    e.stopPropagation() // don't let this click reach the menu's svelte:window close handler
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    addMenu = { x: r.left, y: r.bottom + 2 }
  }

  function onDrop(targetCol: string) {
    if (!dragCol || dragCol === targetCol) { dragCol = null; return }
    applyRaw(edit.moveColumn(rawObj(), activeViewIndex, dragCol, columns.indexOf(targetCol), columns))
    dragCol = null
  }

  const isGroupCol = (col: string) => view.groupBy?.property === col
  const isSortCol = (col: string) => view.sort?.[0]?.property === col
```

- [ ] **Step 3: 模板 — 表头改造**

把现有 `<thead>` 的 `<tr>...{#each columns as col}<th ...>...</th>{/each}...</tr>` 替换为(加拖拽 + ⋯ 按钮 + 末尾 "+"):
```svelte
      <thead>
        <tr>
          {#each columns as col (col)}
            <th
              draggable={editable}
              ondragstart={() => (dragCol = col)}
              ondragover={(e) => { if (editable) e.preventDefault() }}
              ondrop={() => editable && onDrop(col)}
            >
              <span class="th-label" onclick={() => toggleSort(col)}>
                {label(col)}
                {#if clickSort?.property === col}<span class="sort-arrow">{clickSort.direction === 'ASC' ? '▲' : '▼'}</span>{/if}
              </span>
              {#if editable}
                <button type="button" class="th-menu-btn" title={t('base.colMenu')} onclick={(e) => openColMenu(e, col)}>⋯</button>
              {/if}
            </th>
          {/each}
          {#if editable}
            <th class="th-add">
              <button type="button" class="th-add-btn" title={t('base.addColumn')} onclick={openAddMenu}>＋</button>
            </th>
          {/if}
        </tr>
      </thead>
```
说明:分组行 `colspan={columns.length}` 若表头多了 "+" 列,视觉略窄一格,可接受;如需精确可改为 `columns.length + (editable ? 1 : 0)`,本步保持 `columns.length`。

- [ ] **Step 4: 模板 — 挂菜单**

在最外层 `<div class="base-view"> ... </div>` 结束标签**之后**、`{#snippet rowTr...}` **之前**,加:
```svelte
{#if colMenu}
  <BaseColumnMenu
    x={colMenu.x} y={colMenu.y}
    displayName={label(colMenu.col)}
    isGroup={isGroupCol(colMenu.col)}
    isSort={isSortCol(colMenu.col)}
    onAction={(a) => onColAction(colMenu!.col, a)}
    onClose={() => (colMenu = null)}
  />
{/if}
{#if addMenu}
  <BaseAddColumnMenu
    x={addMenu.x} y={addMenu.y}
    options={addableProps}
    label={label}
    onPick={pickAdd}
    onClose={() => (addMenu = null)}
  />
{/if}
```

- [ ] **Step 5: 样式 — 表头按钮**

在 `<style>` 里 `.base-table th` 规则后追加(**不要**给 `th` 加 `position: relative` —— 它已有 `position: sticky`,菜单用 fixed 定位不需要相对定位;`th` 内用 flex 让 label 撑开、按钮靠右):
```css
  .base-table th { }
  .th-label { cursor: pointer; }
  .th-menu-btn, .th-add-btn {
    border: 0; background: transparent; color: inherit; cursor: pointer;
    font-size: 13px; padding: 0 4px; opacity: 0; margin-left: 4px; border-radius: 3px;
  }
  .base-table th:hover .th-menu-btn { opacity: 0.6; }
  .th-menu-btn:hover, .th-add-btn:hover { opacity: 1; background: color-mix(in srgb, CanvasText 10%, Canvas); }
  .th-add-btn { opacity: 0.6; }
  .th-add { width: 1%; white-space: nowrap; }
```

- [ ] **Step 6: 类型检查 + 全量测试**

Run: `pnpm check && pnpm test`
Expected: 0 error;测试全绿(逻辑未回归)。

- [ ] **Step 7: 提交**

```bash
git add src/components/BaseView.svelte
git commit -m "feat(base): column-edit UI — header menu, add-column, drag reorder, write-back

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: i18n 文案(**先于 Task 3/4/5 执行**)

**Files:**
- Modify: `src/lib/i18n/en.ts`, `zh.ts`, `ja.ts`, `de.ts`

- [ ] **Step 1: en.ts**

在 `en.ts`(源,定义 `Messages`)加(与 `base.loading` 同处):
```ts
  'base.colMenu': 'Column options',
  'base.colRename': 'Rename…',
  'base.colRenamePlaceholder': 'Display name',
  'base.colSortAsc': 'Sort ascending (default)',
  'base.colSortDesc': 'Sort descending (default)',
  'base.colClearSort': 'Clear default sort',
  'base.colGroupAsc': 'Group by this (asc)',
  'base.colGroupDesc': 'Group by this (desc)',
  'base.colUngroup': 'Remove grouping',
  'base.colMoveLeft': 'Move left',
  'base.colMoveRight': 'Move right',
  'base.colRemove': 'Remove column',
  'base.addColumn': 'Add column',
  'base.noAddableProps': 'No more properties to add',
  'base.writeError': 'Could not write .base — edit skipped',
```

- [ ] **Step 2: zh.ts**
```ts
  'base.colMenu': '列选项',
  'base.colRename': '重命名…',
  'base.colRenamePlaceholder': '显示名',
  'base.colSortAsc': '默认升序',
  'base.colSortDesc': '默认降序',
  'base.colClearSort': '清除默认排序',
  'base.colGroupAsc': '按此分组(升序)',
  'base.colGroupDesc': '按此分组(降序)',
  'base.colUngroup': '取消分组',
  'base.colMoveLeft': '左移',
  'base.colMoveRight': '右移',
  'base.colRemove': '删除列',
  'base.addColumn': '加列',
  'base.noAddableProps': '没有可加的属性了',
  'base.writeError': '无法写入 .base — 已跳过本次修改',
```

- [ ] **Step 3: ja.ts**
```ts
  'base.colMenu': '列オプション',
  'base.colRename': '名前を変更…',
  'base.colRenamePlaceholder': '表示名',
  'base.colSortAsc': '既定の昇順',
  'base.colSortDesc': '既定の降順',
  'base.colClearSort': '既定の並び替えを解除',
  'base.colGroupAsc': 'この列でグループ化(昇順)',
  'base.colGroupDesc': 'この列でグループ化(降順)',
  'base.colUngroup': 'グループ化を解除',
  'base.colMoveLeft': '左へ移動',
  'base.colMoveRight': '右へ移動',
  'base.colRemove': '列を削除',
  'base.addColumn': '列を追加',
  'base.noAddableProps': '追加できるプロパティがありません',
  'base.writeError': '.base に書き込めませんでした — 変更をスキップ',
```

- [ ] **Step 4: de.ts**
```ts
  'base.colMenu': 'Spaltenoptionen',
  'base.colRename': 'Umbenennen…',
  'base.colRenamePlaceholder': 'Anzeigename',
  'base.colSortAsc': 'Standardsortierung aufsteigend',
  'base.colSortDesc': 'Standardsortierung absteigend',
  'base.colClearSort': 'Standardsortierung entfernen',
  'base.colGroupAsc': 'Danach gruppieren (aufst.)',
  'base.colGroupDesc': 'Danach gruppieren (abst.)',
  'base.colUngroup': 'Gruppierung entfernen',
  'base.colMoveLeft': 'Nach links',
  'base.colMoveRight': 'Nach rechts',
  'base.colRemove': 'Spalte entfernen',
  'base.addColumn': 'Spalte hinzufügen',
  'base.noAddableProps': 'Keine weiteren Eigenschaften',
  'base.writeError': '.base konnte nicht geschrieben werden — übersprungen',
```

注意:zh/ja/de 是完整 catalog(`Record<keyof Messages,string>`),必须四个文件都加全这 15 个键,否则 `pnpm check` 报缺键。`grep -n "base.loading" src/lib/i18n/zh.ts` 找落点。

- [ ] **Step 5: 类型检查 + 提交**

Run: `pnpm check`
Expected: 0 error。

```bash
git add src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/ja.ts src/lib/i18n/de.ts
git commit -m "i18n(base): column-menu + add-column + write-error strings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 全量校验 + 手动 GUI 冒烟

**Files:** 无

- [ ] **Step 1: 全量**

Run: `pnpm test && pnpm check`
Expected: 全绿,0 error。

- [ ] **Step 2: 手动清单(隔离 worktree,交用户)**

复用 `/tmp/base-demo/library.base`。启隔离 dev(worktree `mdeditor-base-verify`,端口 1440,identifier `net.notemd.app.baseverify`)后:
1. 打开 `library.base` → 表头每列 hover 出 ⋯;末尾有 ＋。
2. ＋ → 属性选择器列出未用的 frontmatter/file.* 属性;选一个 → 该列出现,`.base` tab 出脏点。
3. ⋯ → 重命名 → 输入回车 → 列头显示名变;`properties.<id>.displayName` 写入。
4. ⋯ → 默认降序 → 表按该列降序,再开 source 看到 `view.sort`。
5. ⋯ → 设为分组 → 出现分组标题;取消分组恢复。
6. 拖拽两个表头互换 → order 变;左移/右移菜单同样生效。
7. ⋯ → 删除列 → 列消失。
8. Cmd-S(或等自动保存)→ 文件落盘;Obsidian 语义字段(若加了 formulas 到 .base)仍在。
9. 故意在 source 模式写坏 YAML → 编辑控件禁用(⋯/＋/拖拽消失)。

- [ ] **Step 3: 提交(如无代码改动则跳过)**

无。

---

## 执行顺序

因 UI 组件(Task 3/4/5)引用 i18n 键,而 `t()` 按 `keyof Messages` 强类型,**必须先做 Task 6**。推荐顺序:

**Task 1 → Task 2 → Task 6 → Task 3 → Task 4 → Task 5 → Task 7**

(Task 1/2 是纯逻辑,与 i18n 无关,可先;Task 6 在 UI 之前;Task 5 依赖 3/4 组件存在。)

## 自审记录(spec 覆盖)

- 增/删/移/重命名/groupBy/默认排序 → edit.ts(Task 2)+ 菜单(Task 3)+ 集成(Task 5)。✓
- 走 tab 保存流写回 → `applyRaw`→`setContent`(Task 5)。✓
- 未支持字段保留 → edit.ts 在 raw 上改 + round-trip 测试(Task 2)。✓
- 两条排序路(clickSort 临时 / view.sort 持久)→ 优先级 `clickSort ?? view.sort?.[0] ?? view.groupBy`(Task 5 Step 2)+ 解析(Task 1)。✓
- 属性选择器数据源(frontmatter ∪ file.* − 已用)→ `addableProps`(Task 5 Step 1)。✓
- config.error 禁用编辑 → `editable` 门控(Task 5)。✓
- 序列化自检 + toast → `applyRaw`(Task 5)。✓
- 列头内联菜单 + "+" + 拖拽 → Task 3/4/5。✓
