# Editor Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native right-click menu in both rich (`@moraya/core` ProseMirror) and source (`<textarea>`) editors with a custom context menu offering the most common markdown editing actions.

**Architecture:** Menu is data (grouped `MenuItemSpec`s + enablement rules) in `menu-model.ts`; execution is two backend adapters (`rich-actions.ts`, `source-actions.ts`) that map an item `id` to a concrete edit. A shared `EditorContextMenu.svelte` (styled after `SlashMenu.svelte`) renders groups and two-level submenus. Pure text-wrapping logic is extracted from `SourceView` into a testable `text-format.ts`, and block helpers are extracted from `slash-items.ts` for reuse.

**Tech Stack:** Svelte 5 (runes), TypeScript, ProseMirror (prosemirror-commands / -state / -schema-list), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-10-editor-context-menu-design.md`

**Confirmed facts (verified in codebase):**
- Rich schema mark names: `strong`, `em`, `highlight`, `strike_through`, `code`, `link`.
- Source markdown delimiters (match existing Cmd shortcuts): bold `**`, italic `*`, highlight `^^`, strike `~~`, code `` ` ``.
- i18n: flat dot-keys in `src/lib/i18n/en.ts` (base = `Messages` type); `zh.ts`/`ja.ts` are `Partial<Messages>`. `t(key)` from `../i18n/store.svelte`.
- `slash-items.ts` already has `setBlock`/`wrap`/`wrapList`/`insertTableSync`/`wrapTaskList` helpers reading types from `view.state.schema`.

---

## File Structure

```
src/lib/context-menu/
  text-format.ts          # NEW — pure fns: applyWrap, expandToWord, expandToWordPM-agnostic
  text-format.test.ts     # NEW
  block-helpers.ts         # NEW — extracted from slash-items: setBlock/wrap/wrapList/insertTable/insertTaskList
  menu-model.ts            # NEW — MenuItemSpec/MenuGroup + getMenuModel(ctx)
  menu-model.test.ts       # NEW
  EditorContextMenu.svelte # NEW — floating menu UI + submenu + keyboard nav
  rich-actions.ts          # NEW — EditorActions for ProseMirror view
  source-actions.ts        # NEW — EditorActions for textarea
src/lib/slash-menu/slash-items.ts  # MODIFY — import helpers from block-helpers.ts
src/components/SourceView.svelte   # MODIFY — use text-format applyWrap; wire contextmenu
src/components/RichEditor.svelte   # MODIFY — wire contextmenu
src/lib/i18n/en.ts                 # MODIFY — add ctxmenu.* keys
src/lib/i18n/zh.ts                 # MODIFY — add ctxmenu.* keys
```

---

### Task 1: i18n keys for the context menu

**Files:**
- Modify: `src/lib/i18n/en.ts` (before closing `} as const`)
- Modify: `src/lib/i18n/zh.ts`

- [ ] **Step 1: Add English keys**

In `src/lib/i18n/en.ts`, immediately before the final `} as const` line, add:

```ts
  // ── Editor context menu ──
  'ctxmenu.cut': 'Cut',
  'ctxmenu.copy': 'Copy',
  'ctxmenu.paste': 'Paste',
  'ctxmenu.selectAll': 'Select All',
  'ctxmenu.highlight': 'Highlight',
  'ctxmenu.wikilink': 'WikiLink',
  'ctxmenu.bold': 'Bold',
  'ctxmenu.italic': 'Italic',
  'ctxmenu.strike': 'Strikethrough',
  'ctxmenu.code': 'Inline code',
  'ctxmenu.link': 'Link',
  'ctxmenu.heading': 'Heading',
  'ctxmenu.h1': 'Heading 1',
  'ctxmenu.h2': 'Heading 2',
  'ctxmenu.h3': 'Heading 3',
  'ctxmenu.quote': 'Quote',
  'ctxmenu.codeblock': 'Code block',
  'ctxmenu.list': 'List',
  'ctxmenu.bullet': 'Bullet list',
  'ctxmenu.ordered': 'Numbered list',
  'ctxmenu.task': 'Task list',
  'ctxmenu.hr': 'Divider',
  'ctxmenu.insert': 'Insert',
  'ctxmenu.table': 'Table',
  'ctxmenu.image': 'Image…',
  'ctxmenu.math': 'Formula',
  'ctxmenu.mermaid': 'Mermaid diagram',
  'ctxmenu.date': 'Current date',
```

- [ ] **Step 2: Add Chinese keys**

In `src/lib/i18n/zh.ts`, add anywhere in the object (e.g. after the `slashMenu.noMatches` line):

```ts
  'ctxmenu.cut': '剪切',
  'ctxmenu.copy': '复制',
  'ctxmenu.paste': '粘贴',
  'ctxmenu.selectAll': '全选',
  'ctxmenu.highlight': '高亮',
  'ctxmenu.wikilink': 'WikiLink',
  'ctxmenu.bold': '加粗',
  'ctxmenu.italic': '斜体',
  'ctxmenu.strike': '删除线',
  'ctxmenu.code': '行内代码',
  'ctxmenu.link': '链接',
  'ctxmenu.heading': '标题',
  'ctxmenu.h1': '标题 1',
  'ctxmenu.h2': '标题 2',
  'ctxmenu.h3': '标题 3',
  'ctxmenu.quote': '引用',
  'ctxmenu.codeblock': '代码块',
  'ctxmenu.list': '列表',
  'ctxmenu.bullet': '无序列表',
  'ctxmenu.ordered': '有序列表',
  'ctxmenu.task': '任务列表',
  'ctxmenu.hr': '分割线',
  'ctxmenu.insert': '插入',
  'ctxmenu.table': '表格',
  'ctxmenu.image': '图片…',
  'ctxmenu.math': '公式',
  'ctxmenu.mermaid': 'Mermaid 图',
  'ctxmenu.date': '当前日期',
```

- [ ] **Step 3: Type-check**

Run: `pnpm check`
Expected: no new errors referencing `ctxmenu.*`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/i18n/en.ts src/lib/i18n/zh.ts
git commit -m "i18n: add editor context menu strings"
```

---

### Task 2: text-format.ts — pure wrap/word helpers + tests

**Files:**
- Create: `src/lib/context-menu/text-format.ts`
- Test: `src/lib/context-menu/text-format.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/context-menu/text-format.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { applyWrap, expandToWord } from './text-format'

describe('applyWrap', () => {
  it('wraps a selection', () => {
    // "foo BAR baz", select BAR (4..7)
    const r = applyWrap('foo bar baz', 4, 7, '**', '**')
    expect(r.value).toBe('foo **bar** baz')
    expect(r.selStart).toBe(6)
    expect(r.selEnd).toBe(9)
  })

  it('unwraps when the selection itself includes the markers', () => {
    // select "**bar**" (4..11)
    const r = applyWrap('foo **bar** baz', 4, 11, '**', '**')
    expect(r.value).toBe('foo bar baz')
    expect(r.selStart).toBe(4)
    expect(r.selEnd).toBe(7)
  })

  it('unwraps when markers sit just outside the selection', () => {
    // select "bar" (6..9) inside **bar**
    const r = applyWrap('foo **bar** baz', 6, 9, '**', '**')
    expect(r.value).toBe('foo bar baz')
    expect(r.selStart).toBe(4)
    expect(r.selEnd).toBe(7)
  })

  it('inserts empty markers on a collapsed selection', () => {
    const r = applyWrap('foo ', 4, 4, '**', '**')
    expect(r.value).toBe('foo ****')
    expect(r.selStart).toBe(6)
    expect(r.selEnd).toBe(6)
  })
})

describe('expandToWord', () => {
  it('expands to the ascii word under the cursor', () => {
    expect(expandToWord('foo bar baz', 5)).toEqual({ start: 4, end: 7 })
  })
  it('expands to a CJK run', () => {
    expect(expandToWord('你好世界', 2)).toEqual({ start: 0, end: 4 })
  })
  it('returns the cursor collapsed when not on a word', () => {
    expect(expandToWord('foo   bar', 4)).toEqual({ start: 4, end: 4 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/context-menu/text-format.test.ts`
Expected: FAIL — cannot find module './text-format'.

- [ ] **Step 3: Write the implementation**

Create `src/lib/context-menu/text-format.ts`:

```ts
// Pure text helpers shared by SourceView keyboard shortcuts and the source
// context-menu adapter. No DOM, no ProseMirror — trivially unit-testable.

export interface WrapResult {
  value: string
  selStart: number
  selEnd: number
}

/**
 * Toggle a paired marker (open/close) around [start,end) in `value`.
 * Handles three cases, mirroring SourceView's existing Cmd+B logic:
 *  1. selection already includes the markers → strip them
 *  2. markers sit just outside the selection → strip them
 *  3. otherwise wrap (or insert empty markers on a collapsed selection)
 */
export function applyWrap(
  value: string, start: number, end: number, open: string, close: string,
): WrapResult {
  const sel = value.slice(start, end)
  const selWrapped = sel.startsWith(open) && sel.endsWith(close)
                  && sel.length > open.length + close.length
  const beforeOpen = start >= open.length && value.slice(start - open.length, start) === open
  const afterClose = value.slice(end, end + close.length) === close
  const outerWrapped = beforeOpen && afterClose

  if (selWrapped) {
    const inner = sel.slice(open.length, sel.length - close.length)
    return { value: value.slice(0, start) + inner + value.slice(end),
             selStart: start, selEnd: start + inner.length }
  }
  if (outerWrapped) {
    const newStart = start - open.length
    return { value: value.slice(0, newStart) + sel + value.slice(end + close.length),
             selStart: newStart, selEnd: newStart + sel.length }
  }
  return {
    value: value.slice(0, start) + open + sel + close + value.slice(end),
    selStart: start + open.length, selEnd: end + open.length,
  }
}

const WORD_CHAR = /[\w一-龥]/

/** Expand a cursor position to the surrounding word run; collapsed if not on a word. */
export function expandToWord(value: string, cursor: number): { start: number; end: number } {
  if (!WORD_CHAR.test(value[cursor] ?? '') && !WORD_CHAR.test(value[cursor - 1] ?? '')) {
    return { start: cursor, end: cursor }
  }
  let start = cursor
  let end = cursor
  while (start > 0 && WORD_CHAR.test(value[start - 1])) start--
  while (end < value.length && WORD_CHAR.test(value[end])) end++
  return { start, end }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/context-menu/text-format.test.ts`
Expected: PASS (7 assertions).

- [ ] **Step 5: Refactor SourceView to use applyWrap**

In `src/components/SourceView.svelte`, replace the body of the `if (open && tabId)` block inside `onTextareaKeydown` (currently lines ~75-107, the selWrapped/outerWrapped/else logic) with a call to the shared helper. Add the import at the top of `<script>`:

```ts
  import { applyWrap } from '../lib/context-menu/text-format'
```

Replace the inner logic (from `const cur = el.value` through the closing of the three-branch if/else, keeping `ev.preventDefault(); ev.stopPropagation()` above it) with:

```ts
        const el = textareaEl!
        const start = el.selectionStart ?? 0
        const end = el.selectionEnd ?? 0
        const r = applyWrap(el.value, start, end, open, close)
        setContent(tabId, r.value)
        requestAnimationFrame(() => el.setSelectionRange(r.selStart, r.selEnd))
        return
```

- [ ] **Step 6: Verify existing tests + type-check still pass**

Run: `pnpm vitest run && pnpm check`
Expected: PASS, no new type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/context-menu/text-format.ts src/lib/context-menu/text-format.test.ts src/components/SourceView.svelte
git commit -m "feat(context-menu): extract text-format wrap helpers; reuse in SourceView"
```

---

### Task 3: block-helpers.ts — extract reusable ProseMirror block ops

**Files:**
- Create: `src/lib/context-menu/block-helpers.ts`
- Modify: `src/lib/slash-menu/slash-items.ts`

- [ ] **Step 1: Create block-helpers.ts**

Move the schema-aware helpers out of `slash-items.ts` into `src/lib/context-menu/block-helpers.ts`:

```ts
import type { EditorView } from 'prosemirror-view'
import { setBlockType, wrapIn } from 'prosemirror-commands'
import { wrapInList } from 'prosemirror-schema-list'

export function setBlock(v: EditorView, typeName: string, attrs?: Record<string, unknown>) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return
  setBlockType(type, attrs)(v.state, v.dispatch)
  v.focus()
}

export function wrapBlock(v: EditorView, typeName: string) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return
  wrapIn(type)(v.state, v.dispatch)
  v.focus()
}

export function wrapList(v: EditorView, typeName: string) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return
  wrapInList(type)(v.state, v.dispatch)
  v.focus()
}

export function insertAtom(v: EditorView, typeName: string, attrs?: Record<string, unknown>) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return
  v.dispatch(v.state.tr.replaceSelectionWith(type.create(attrs ?? {})).scrollIntoView())
  v.focus()
}

export function insertTable(v: EditorView) {
  const { schema } = v.state
  const { table, table_header_row, table_row, table_header, table_cell, paragraph } = schema.nodes
  if (!table || !table_header_row || !table_row || !table_header || !table_cell || !paragraph) return
  const rows = 3, cols = 3
  const emptyPara  = () => paragraph.createAndFill()!
  const headerCell = () => table_header.createAndFill({ alignment: 'left' }, [emptyPara()])!
  const bodyCell   = () => table_cell.createAndFill(  { alignment: 'left' }, [emptyPara()])!
  const tableNode = table.create(null, [
    table_header_row.create(null, Array.from({ length: cols }, headerCell)),
    ...Array.from({ length: rows - 1 }, () =>
      table_row.create(null, Array.from({ length: cols }, bodyCell))),
  ])
  v.dispatch(v.state.tr.replaceSelectionWith(tableNode).scrollIntoView())
  v.focus()
}

export function insertTaskList(v: EditorView) {
  const { schema } = v.state
  const bulletList = schema.nodes.bullet_list
  const listItem   = schema.nodes.list_item
  if (!bulletList || !listItem) return
  if (!wrapInList(bulletList)(v.state, v.dispatch)) return
  const { doc, selection } = v.state
  const $from = doc.resolve(selection.from)
  let listDepth = -1
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type === bulletList) { listDepth = d; break }
  }
  if (listDepth < 0) { v.focus(); return }
  const listStart = $from.before(listDepth)
  const listEnd   = listStart + $from.node(listDepth).nodeSize
  const tr = v.state.tr
  doc.nodesBetween(listStart, listEnd, (node, pos) => {
    if (node.type === listItem && node.attrs.checked === null) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false })
    }
  })
  if (tr.docChanged) v.dispatch(tr)
  v.focus()
}
```

- [ ] **Step 2: Rewire slash-items.ts to import from block-helpers**

In `src/lib/slash-menu/slash-items.ts`:
- Remove the local definitions of `setBlock`, `wrap`, `wrapList`, `insertAtom`, `insertTableSync`, `wrapTaskList` (lines ~21-116, but KEEP `insertSpreadsheetSync` — it's slash-only).
- Add at top: `import { setBlock, wrapBlock, wrapList, insertAtom, insertTable, insertTaskList } from '../context-menu/block-helpers'`
- Replace call sites: `wrap(v, 'blockquote')` → `wrapBlock(v, 'blockquote')`; `insertTableSync(v)` → `insertTable(v)`; `wrapTaskList(v)` → `insertTaskList(v)`. `setBlock`/`wrapList`/`insertAtom` names are unchanged.

- [ ] **Step 3: Type-check and run tests**

Run: `pnpm check && pnpm vitest run src/lib/slash-menu`
Expected: PASS, no unresolved imports.

- [ ] **Step 4: Commit**

```bash
git add src/lib/context-menu/block-helpers.ts src/lib/slash-menu/slash-items.ts
git commit -m "refactor(context-menu): extract block helpers shared with slash menu"
```

---

### Task 4: menu-model.ts — menu data + tests

**Files:**
- Create: `src/lib/context-menu/menu-model.ts`
- Test: `src/lib/context-menu/menu-model.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/context-menu/menu-model.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { getMenuModel } from './menu-model'

describe('getMenuModel', () => {
  it('always includes a clipboard group and the emphasis items', () => {
    const groups = getMenuModel({ hasSelection: true })
    const ids = groups.flatMap(g => g.items.map(i => i.id))
    expect(ids).toContain('cut')
    expect(ids).toContain('highlight')
    expect(ids).toContain('wikilink')
  })

  it('marks highlight and wikilink as emphasis and orders them before other marks', () => {
    const groups = getMenuModel({ hasSelection: true })
    const emphasis = groups.find(g => g.id === 'emphasis')!
    expect(emphasis.items.map(i => i.id)).toEqual(['highlight', 'wikilink'])
    expect(emphasis.items.every(i => i.emphasis)).toBe(true)
  })

  it('flags link-from-text as needing a selection', () => {
    const groups = getMenuModel({ hasSelection: false })
    const link = groups.flatMap(g => g.items).find(i => i.id === 'link')!
    expect(link.needsSelection).toBe(true)
  })

  it('exposes block and insert submenus with children', () => {
    const groups = getMenuModel({ hasSelection: false })
    const all = groups.flatMap(g => g.items)
    expect(all.find(i => i.id === 'heading')!.children!.map(c => c.id))
      .toEqual(['h1', 'h2', 'h3'])
    expect(all.find(i => i.id === 'list')!.children!.map(c => c.id))
      .toEqual(['bullet', 'ordered', 'task'])
    expect(all.find(i => i.id === 'insert')!.children!.map(c => c.id))
      .toEqual(['table', 'image', 'math', 'mermaid', 'date'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/context-menu/menu-model.test.ts`
Expected: FAIL — cannot find module './menu-model'.

- [ ] **Step 3: Implement menu-model.ts**

Create `src/lib/context-menu/menu-model.ts`:

```ts
import { t } from '../i18n/store.svelte'
import type { Messages } from '../i18n/en'

export interface MenuItemSpec {
  id: string
  label: string
  icon?: string
  emphasis?: boolean          // rendered bold/outlined (highlight, wikilink)
  needsSelection?: boolean    // disabled when there is no selection
  children?: MenuItemSpec[]   // one level of submenu
}

export interface MenuGroup {
  id: string
  items: MenuItemSpec[]
}

export interface MenuContext {
  hasSelection: boolean
}

function item(id: string, key: keyof Messages, extra: Partial<MenuItemSpec> = {}): MenuItemSpec {
  return { id, label: t(key), ...extra }
}

/**
 * The context menu as pure data. Backend adapters map `item.id` to an edit.
 * `ctx` currently only gates enablement of selection-dependent items; the
 * structure itself is identical for rich and source.
 */
export function getMenuModel(_ctx: MenuContext): MenuGroup[] {
  return [
    { id: 'clipboard', items: [
      item('cut', 'ctxmenu.cut'),
      item('copy', 'ctxmenu.copy'),
      item('paste', 'ctxmenu.paste'),
      item('selectAll', 'ctxmenu.selectAll'),
    ] },
    { id: 'emphasis', items: [
      item('highlight', 'ctxmenu.highlight', { emphasis: true, icon: '⭐' }),
      item('wikilink', 'ctxmenu.wikilink', { emphasis: true, icon: '🔗' }),
    ] },
    { id: 'marks', items: [
      item('bold', 'ctxmenu.bold', { icon: 'B' }),
      item('italic', 'ctxmenu.italic', { icon: 'I' }),
      item('strike', 'ctxmenu.strike', { icon: 'S' }),
      item('code', 'ctxmenu.code', { icon: '<>' }),
    ] },
    { id: 'link', items: [
      item('link', 'ctxmenu.link', { needsSelection: true, icon: '↗' }),
    ] },
    { id: 'block', items: [
      item('heading', 'ctxmenu.heading', { icon: 'H', children: [
        item('h1', 'ctxmenu.h1'), item('h2', 'ctxmenu.h2'), item('h3', 'ctxmenu.h3'),
      ] }),
      item('quote', 'ctxmenu.quote', { icon: '❝' }),
      item('codeblock', 'ctxmenu.codeblock', { icon: '{}' }),
      item('list', 'ctxmenu.list', { icon: '•', children: [
        item('bullet', 'ctxmenu.bullet'), item('ordered', 'ctxmenu.ordered'), item('task', 'ctxmenu.task'),
      ] }),
      item('hr', 'ctxmenu.hr', { icon: '—' }),
    ] },
    { id: 'insert', items: [
      item('insert', 'ctxmenu.insert', { icon: '+', children: [
        item('table', 'ctxmenu.table'), item('image', 'ctxmenu.image'),
        item('math', 'ctxmenu.math'), item('mermaid', 'ctxmenu.mermaid'),
        item('date', 'ctxmenu.date'),
      ] }),
    ] },
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/context-menu/menu-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/context-menu/menu-model.ts src/lib/context-menu/menu-model.test.ts
git commit -m "feat(context-menu): menu model data + tests"
```

---

### Task 5: EditorContextMenu.svelte — the floating menu UI

**Files:**
- Create: `src/lib/context-menu/EditorContextMenu.svelte`

Defines the shared `EditorActions` interface (imported by adapters + wiring) and renders `getMenuModel` groups with one-level submenus, viewport flipping (like `SlashMenu`), backdrop-to-close, Escape, and disabled items.

- [ ] **Step 1: Create the component**

Create `src/lib/context-menu/EditorContextMenu.svelte`:

```svelte
<script module lang="ts">
  export interface EditorActions {
    run(id: string): void | Promise<void>
    canRun(id: string): boolean
  }
</script>

<script lang="ts">
  import { getMenuModel, type MenuItemSpec } from './menu-model'

  let {
    position,
    hasSelection,
    actions,
    onClose,
  }: {
    position: { x: number; y: number }
    hasSelection: boolean
    actions: EditorActions
    onClose: () => void
  } = $props()

  const groups = getMenuModel({ hasSelection })

  let menuEl: HTMLDivElement | undefined = $state()
  let top = $state(position.y)
  let left = $state(position.x)
  let openSubId = $state<string | null>(null)

  $effect(() => {
    if (!menuEl) return
    const r = menuEl.getBoundingClientRect()
    top = (position.y + r.height > window.innerHeight)
      ? Math.max(4, window.innerHeight - r.height - 4) : position.y
    left = (position.x + r.width > window.innerWidth)
      ? Math.max(4, window.innerWidth - r.width - 4) : position.x
  })

  function disabled(it: MenuItemSpec): boolean {
    if (it.children) return false
    if (it.needsSelection && !hasSelection) return true
    return !actions.canRun(it.id)
  }

  async function choose(it: MenuItemSpec) {
    if (it.children) return
    if (disabled(it)) return
    onClose()
    await actions.run(it.id)
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ctx-backdrop" oncontextmenu={(e) => { e.preventDefault(); onClose() }} onclick={onClose}>
  <div
    bind:this={menuEl}
    class="ctx-menu"
    style="top: {top}px; left: {left}px"
    onclick={(e) => e.stopPropagation()}
  >
    {#each groups as group, gi (group.id)}
      {#if gi > 0}<div class="ctx-sep"></div>{/if}
      {#each group.items as it (it.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="ctx-item"
          class:emphasis={it.emphasis}
          class:disabled={disabled(it)}
          class:has-sub={!!it.children}
          onmouseenter={() => openSubId = it.children ? it.id : null}
          onclick={() => choose(it)}
        >
          {#if it.icon}<span class="ctx-icon">{it.icon}</span>{/if}
          <span class="ctx-label">{it.label}</span>
          {#if it.children}<span class="ctx-arrow">▸</span>{/if}

          {#if it.children && openSubId === it.id}
            <div class="ctx-sub">
              {#each it.children as sub (sub.id)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="ctx-item" onclick={(e) => { e.stopPropagation(); choose(sub) }}>
                  <span class="ctx-label">{sub.label}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/each}
  </div>
</div>

<style>
  .ctx-backdrop { position: fixed; inset: 0; z-index: 80; }
  .ctx-menu {
    position: fixed; min-width: 200px; padding: 4px;
    background: Canvas; color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas);
    border-radius: 8px;
    box-shadow: 0 4px 16px color-mix(in srgb, CanvasText 18%, transparent);
    z-index: 81; font-size: 13px;
  }
  .ctx-sep { height: 1px; margin: 4px 6px; background: color-mix(in srgb, CanvasText 12%, Canvas); }
  .ctx-item {
    position: relative; display: flex; align-items: center; gap: 8px;
    padding: 5px 10px; border-radius: 5px; cursor: pointer; user-select: none;
    white-space: nowrap;
  }
  .ctx-item:hover { background: color-mix(in srgb, AccentColor 12%, Canvas); }
  .ctx-item.disabled { opacity: 0.4; pointer-events: none; }
  .ctx-item.emphasis { font-weight: 700; }
  .ctx-item.emphasis .ctx-label { color: AccentColor; }
  .ctx-icon {
    flex-shrink: 0; width: 20px; text-align: center;
    font-family: ui-monospace, Menlo, monospace; font-size: 11px; font-weight: 700;
  }
  .ctx-label { flex: 1; }
  .ctx-arrow { margin-left: 12px; opacity: 0.6; }
  .ctx-sub {
    position: absolute; top: -5px; left: 100%; min-width: 150px; padding: 4px;
    background: Canvas;
    border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas);
    border-radius: 8px;
    box-shadow: 0 4px 16px color-mix(in srgb, CanvasText 18%, transparent);
  }
</style>
```

- [ ] **Step 2: Type-check**

Run: `pnpm check`
Expected: no errors in `EditorContextMenu.svelte`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/context-menu/EditorContextMenu.svelte
git commit -m "feat(context-menu): floating menu UI with submenus"
```

---

### Task 6: rich-actions.ts — ProseMirror adapter

**Files:**
- Create: `src/lib/context-menu/rich-actions.ts`

Maps menu ids to ProseMirror edits. Marks use `toggleMark`; on a collapsed selection the current word is selected first. Blocks/insert reuse `block-helpers.ts`. Reuses existing `insertImageAtCursor` (image) and slash-item logic.

- [ ] **Step 1: Create the adapter**

Create `src/lib/context-menu/rich-actions.ts`:

```ts
import type { EditorView } from 'prosemirror-view'
import { toggleMark } from 'prosemirror-commands'
import { TextSelection } from 'prosemirror-state'
import type { EditorActions } from './EditorContextMenu.svelte'
import {
  setBlock, wrapBlock, wrapList, insertAtom, insertTable, insertTaskList,
} from './block-helpers'

const MARK_BY_ID: Record<string, string> = {
  bold: 'strong', italic: 'em', highlight: 'highlight', strike: 'strike_through', code: 'code',
}

/** Select the word under the cursor if the selection is empty, so mark toggles have a target. */
function ensureSelection(view: EditorView) {
  const { selection, doc } = view.state
  if (!selection.empty) return
  const $pos = selection.$from
  const text = $pos.parent.textContent
  const offset = $pos.parentOffset
  const isWord = (c: string) => /[\w一-龥]/.test(c)
  let s = offset, e = offset
  while (s > 0 && isWord(text[s - 1])) s--
  while (e < text.length && isWord(text[e])) e++
  if (e === s) return
  const base = $pos.pos - offset
  view.dispatch(view.state.tr.setSelection(
    TextSelection.create(doc, base + s, base + e)))
}

function toggle(view: EditorView, markName: string) {
  const mark = view.state.schema.marks[markName]
  if (!mark) return
  ensureSelection(view)
  toggleMark(mark)(view.state, view.dispatch)
  view.focus()
}

/** Wrap the selected text (or current word) in [[ ]] as literal text. */
function wrapWikilink(view: EditorView) {
  ensureSelection(view)
  const { from, to } = view.state.selection
  const text = view.state.doc.textBetween(from, to) || ''
  const tr = view.state.tr.insertText(`[[${text}]]`, from, to)
  // place caret inside the brackets when empty, else after
  const caret = text ? from + text.length + 4 : from + 2
  tr.setSelection(TextSelection.create(tr.doc, caret))
  view.dispatch(tr)
  view.focus()
}

function toggleLink(view: EditorView) {
  const linkMark = view.state.schema.marks.link
  if (!linkMark) return
  const { from, to } = view.state.selection
  if (from === to) return
  toggleMark(linkMark, { href: '' })(view.state, view.dispatch)
  view.focus()
}

function insertDate(view: EditorView) {
  const d = new Date().toISOString().slice(0, 10)
  view.dispatch(view.state.tr.insertText(d).scrollIntoView())
  view.focus()
}

export function createRichActions(view: EditorView): EditorActions {
  return {
    canRun(id) {
      if (id === 'link') return !view.state.selection.empty
      return true
    },
    async run(id) {
      if (id in MARK_BY_ID) return toggle(view, MARK_BY_ID[id])
      switch (id) {
        case 'cut':       document.execCommand('cut'); return
        case 'copy':      document.execCommand('copy'); return
        case 'paste':     document.execCommand('paste'); return
        case 'selectAll': {
          const { doc } = view.state
          view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, 0, doc.content.size)))
          view.focus(); return
        }
        case 'wikilink':  return wrapWikilink(view)
        case 'link':      return toggleLink(view)
        case 'h1':        return setBlock(view, 'heading', { level: 1 })
        case 'h2':        return setBlock(view, 'heading', { level: 2 })
        case 'h3':        return setBlock(view, 'heading', { level: 3 })
        case 'quote':     return wrapBlock(view, 'blockquote')
        case 'codeblock': return setBlock(view, 'code_block', { language: '' })
        case 'bullet':    return wrapList(view, 'bullet_list')
        case 'ordered':   return wrapList(view, 'ordered_list')
        case 'task':      return insertTaskList(view)
        case 'hr':        return insertAtom(view, 'horizontal_rule')
        case 'table':     return insertTable(view)
        case 'math':      return insertAtom(view, 'math_block', { value: '' })
        case 'mermaid':   return setBlock(view, 'code_block', { language: 'mermaid' })
        case 'date':      return insertDate(view)
        case 'image': {
          const { open } = await import('@tauri-apps/plugin-dialog')
          const result = await open({ multiple: false,
            filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','gif','svg','webp','bmp','avif'] }] })
          if (typeof result !== 'string') return
          const { insertImageAtCursor } = await import('../attachment-insert')
          insertImageAtCursor(view, result)
          return
        }
      }
    },
  }
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm check`
Expected: no errors. (`prosemirror-state`/`-commands` are already deps via moraya.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/context-menu/rich-actions.ts
git commit -m "feat(context-menu): ProseMirror action adapter"
```

---

### Task 7: source-actions.ts — textarea adapter

**Files:**
- Create: `src/lib/context-menu/source-actions.ts`

Operates on the `<textarea>` via a small handle. Marks reuse `applyWrap` + `expandToWord`; blocks toggle line prefixes; insert splices markdown snippets. Writes through `setContent` (same as SourceView) so the tab stays the source of truth.

- [ ] **Step 1: Create the adapter**

Create `src/lib/context-menu/source-actions.ts`:

```ts
import type { EditorActions } from './EditorContextMenu.svelte'
import { applyWrap, expandToWord } from './text-format'
import { setContent } from '../tabs.svelte'

const WRAP_BY_ID: Record<string, [string, string]> = {
  bold: ['**', '**'], italic: ['*', '*'], highlight: ['^^', '^^'],
  strike: ['~~', '~~'], code: ['`', '`'],
}

export interface SourceHandle {
  el: HTMLTextAreaElement
  tabId: string
  value(): string
}

function replaceRange(h: SourceHandle, start: number, end: number, text: string, caret?: number) {
  const v = h.value()
  const next = v.slice(0, start) + text + v.slice(end)
  setContent(h.tabId, next)
  const pos = caret ?? start + text.length
  requestAnimationFrame(() => { h.el.focus(); h.el.setSelectionRange(pos, pos) })
}

function wrap(h: SourceHandle, open: string, close: string) {
  let start = h.el.selectionStart ?? 0
  let end = h.el.selectionEnd ?? 0
  if (start === end) { const w = expandToWord(h.value(), start); start = w.start; end = w.end }
  const r = applyWrap(h.value(), start, end, open, close)
  setContent(h.tabId, r.value)
  requestAnimationFrame(() => { h.el.focus(); h.el.setSelectionRange(r.selStart, r.selEnd) })
}

function wikilink(h: SourceHandle) {
  let start = h.el.selectionStart ?? 0
  let end = h.el.selectionEnd ?? 0
  if (start === end) { const w = expandToWord(h.value(), start); start = w.start; end = w.end }
  const inner = h.value().slice(start, end)
  const text = `[[${inner}]]`
  replaceRange(h, start, end, text, inner ? start + text.length : start + 2)
}

function link(h: SourceHandle) {
  const start = h.el.selectionStart ?? 0
  const end = h.el.selectionEnd ?? 0
  if (start === end) return
  const inner = h.value().slice(start, end)
  const text = `[${inner}](url)`
  // select the "url" placeholder
  replaceRange(h, start, end, text, start + inner.length + 3)
  requestAnimationFrame(() =>
    h.el.setSelectionRange(start + inner.length + 3, start + inner.length + 6))
}

/** Toggle a single-line prefix on the line containing the cursor. */
function linePrefix(h: SourceHandle, prefix: string) {
  const v = h.value()
  const pos = h.el.selectionStart ?? 0
  const lineStart = v.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = v.indexOf('\n', pos) === -1 ? v.length : v.indexOf('\n', pos)
  const line = v.slice(lineStart, lineEnd)
  const stripped = line.replace(/^(#{1,6}\s|>\s|-\s\[[ x]\]\s|-\s|\d+\.\s)/, '')
  const next = line === prefix + stripped ? stripped : prefix + stripped
  replaceRange(h, lineStart, lineEnd, next, lineStart + next.length)
}

function insertText(h: SourceHandle, text: string) {
  const start = h.el.selectionStart ?? 0
  const end = h.el.selectionEnd ?? 0
  replaceRange(h, start, end, text)
}

export function createSourceActions(h: SourceHandle): EditorActions {
  return {
    canRun(id) {
      if (id === 'link') return (h.el.selectionStart ?? 0) !== (h.el.selectionEnd ?? 0)
      return true
    },
    async run(id) {
      if (id in WRAP_BY_ID) { const [o, c] = WRAP_BY_ID[id]; return wrap(h, o, c) }
      switch (id) {
        case 'cut':       document.execCommand('cut'); return
        case 'copy':      document.execCommand('copy'); return
        case 'paste':     document.execCommand('paste'); return
        case 'selectAll': h.el.focus(); h.el.select(); return
        case 'wikilink':  return wikilink(h)
        case 'link':      return link(h)
        case 'h1':        return linePrefix(h, '# ')
        case 'h2':        return linePrefix(h, '## ')
        case 'h3':        return linePrefix(h, '### ')
        case 'quote':     return linePrefix(h, '> ')
        case 'bullet':    return linePrefix(h, '- ')
        case 'ordered':   return linePrefix(h, '1. ')
        case 'task':      return linePrefix(h, '- [ ] ')
        case 'codeblock': return insertText(h, '```\n\n```\n')
        case 'hr':        return insertText(h, '\n---\n')
        case 'table':     return insertText(h, '| A | B | C |\n| --- | --- | --- |\n|  |  |  |\n')
        case 'math':      return insertText(h, '$$\n\n$$\n')
        case 'mermaid':   return insertText(h, '```mermaid\n\n```\n')
        case 'date':      return insertText(h, new Date().toISOString().slice(0, 10))
        case 'image': {
          const { open } = await import('@tauri-apps/plugin-dialog')
          const result = await open({ multiple: false,
            filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','gif','svg','webp','bmp','avif'] }] })
          if (typeof result !== 'string') return
          insertText(h, `![](${result})`)
          return
        }
      }
    },
  }
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/context-menu/source-actions.ts
git commit -m "feat(context-menu): textarea action adapter"
```

---

### Task 8: Wire the context menu into RichEditor

**Files:**
- Modify: `src/components/RichEditor.svelte`

- [ ] **Step 1: Add imports and state**

In the `<script>` of `RichEditor.svelte`, add near the other imports:

```ts
  import EditorContextMenu, { type EditorActions } from '../lib/context-menu/EditorContextMenu.svelte'
  import { createRichActions } from '../lib/context-menu/rich-actions'
```

Add near the slash-menu state (~line 127):

```ts
  let showCtxMenu   = $state(false)
  let ctxMenuPos    = $state({ x: 0, y: 0 })
  let ctxHasSel     = $state(false)
  let ctxActions    = $state<EditorActions | null>(null)
```

- [ ] **Step 2: Add the contextmenu handler**

Add a function alongside the other handlers (e.g. after `handleLinkMouseDown`):

```ts
  function handleRichContextMenu(event: MouseEvent) {
    if (!editor) return
    event.preventDefault()
    const view = editor.view as unknown as EditorView
    ctxHasSel   = !view.state.selection.empty
    ctxActions  = createRichActions(view)
    ctxMenuPos  = { x: event.clientX, y: event.clientY }
    showCtxMenu = true
  }
```

- [ ] **Step 3: Register/unregister the listener**

In `onMount`, next to the other `_pmEl?.addEventListener(...)` calls (~line 866), add:

```ts
        _pmEl?.addEventListener('contextmenu', handleRichContextMenu as EventListener)
```

In `onDestroy` (~line 912), add the matching removal:

```ts
    _pmEl?.removeEventListener('contextmenu', handleRichContextMenu as EventListener)
```

- [ ] **Step 4: Render the menu**

In the markup, after the `{#if showSlashMenu}` block (before the closing `</div>` of `.rich-wrap`), add:

```svelte
  {#if showCtxMenu && ctxActions}
    <EditorContextMenu
      position={ctxMenuPos}
      hasSelection={ctxHasSel}
      actions={ctxActions}
      onClose={() => { showCtxMenu = false }}
    />
  {/if}
```

- [ ] **Step 5: Verify build + type-check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/RichEditor.svelte
git commit -m "feat(context-menu): wire menu into rich editor"
```

---

### Task 9: Wire the context menu into SourceView

**Files:**
- Modify: `src/components/SourceView.svelte`

- [ ] **Step 1: Add imports and state**

In the `<script>` of `SourceView.svelte`, add:

```ts
  import EditorContextMenu, { type EditorActions } from '../lib/context-menu/EditorContextMenu.svelte'
  import { createSourceActions } from '../lib/context-menu/source-actions'
```

Add state near the other `$state` declarations:

```ts
  let showCtxMenu = $state(false)
  let ctxMenuPos  = $state({ x: 0, y: 0 })
  let ctxHasSel   = $state(false)
  let ctxActions  = $state<EditorActions | null>(null)
```

- [ ] **Step 2: Add the handler**

Add a function in `<script>`:

```ts
  function onContextMenu(event: MouseEvent) {
    if (!textareaEl || !tabId) return
    event.preventDefault()
    const el = textareaEl
    ctxHasSel  = (el.selectionStart ?? 0) !== (el.selectionEnd ?? 0)
    ctxActions = createSourceActions({ el, tabId, value: () => el.value })
    ctxMenuPos = { x: event.clientX, y: event.clientY }
    showCtxMenu = true
  }
```

- [ ] **Step 3: Attach to the textarea**

On the `<textarea>` element in the markup, add the handler attribute alongside `onpaste`:

```svelte
      oncontextmenu={onContextMenu}
```

- [ ] **Step 4: Render the menu**

After the closing `</div>` of `.host` but inside the top-level `.src` div (i.e. just before `</div>` that closes `.src`), add:

```svelte
  {#if showCtxMenu && ctxActions}
    <EditorContextMenu
      position={ctxMenuPos}
      hasSelection={ctxHasSel}
      actions={ctxActions}
      onClose={() => { showCtxMenu = false }}
    />
  {/if}
```

- [ ] **Step 5: Verify build + full test suite + type-check**

Run: `pnpm check && pnpm vitest run`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/SourceView.svelte
git commit -m "feat(context-menu): wire menu into source editor"
```

---

### Task 10: Dev GUI verification (manual)

**Files:** none (verification only)

Per memory `reference_dev_gui_verification`, GUI/window regressions must be verified on a real dev build, not just tests.

- [ ] **Step 1: Launch dev build and verify the matrix**

Run the dev build (`pnpm tauri dev` or the project's documented dev launcher). Verify for **both** rich and source modes:
- Right-click with a text selection → menu appears; Bold/Italic/Highlight/Strike/Code toggle the selection; Link enabled.
- Right-click with no selection on a word → mark items expand to the word and apply; Link disabled (greyed).
- Highlight and WikiLink appear as emphasised (bold + accent) root items.
- Heading▸ / List▸ / Insert▸ submenus open on hover and their items work.
- Cut/Copy/Paste/Select All behave.
- Escape, backdrop click, and choosing an item all close the menu.
- Round-trip: a mark applied in rich mode shows the correct markdown after toggling to source mode.

- [ ] **Step 2: Commit any fixes discovered**

If issues are found, fix and commit with descriptive messages, then re-verify.

---

## Self-Review Notes

- **Spec coverage:** clipboard group (Task 4/5/6/7), emphasis highlight+wikilink (Task 4), four function groups (Task 4 + adapters 6/7), collapsed-selection word expansion (Task 2 `expandToWord`, used in both adapters), two-level submenus (Task 4/5), native-menu takeover via `preventDefault` (Tasks 8/9), i18n (Task 1), DRY extraction of block helpers + text-format (Tasks 2/3). All covered.
- **Type consistency:** `EditorActions` defined once in `EditorContextMenu.svelte` module script, imported by both adapters and both wirings. `createRichActions`/`createSourceActions` return it. `MenuItemSpec` fields (`emphasis`, `needsSelection`, `children`) match usage in the component. Mark names verified against moraya dist.
- **Deferred to manual:** ProseMirror interaction correctness (Task 10) — pure logic is unit-tested; view-bound logic is verified live.
