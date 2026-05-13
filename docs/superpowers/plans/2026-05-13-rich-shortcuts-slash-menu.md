# Rich Mode Shortcuts & Slash Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two insertion UX layers to rich mode: (A) keyboard shortcuts for all block types (Cmd+1-6 headings, Cmd+Shift+K code, etc.) and (B) a `/` slash command menu (Obsidian-style) that filters 12 block types by name.

**Architecture:** `slash-items.ts` holds item definitions and a pure `filterSlashItems` function (testable). `SlashMenu.svelte` is a floating list component. `RichEditor.svelte` gets a single `handleRichKeydown` capture-phase listener that handles both shortcuts and slash-menu navigation; a separate `handleProseMirrorInput` listener on the `.ProseMirror` element checks after each keystroke whether cursor is on a `/`-prefixed paragraph and opens/closes the menu. All block insert commands come from `@moraya/core/commands`.

**Tech Stack:** Svelte 5, ProseMirror (via `@moraya/core/commands`), CSS system colors

---

## File Map

| Status | Path | Responsibility |
|--------|------|----------------|
| Create | `src/lib/slash-menu/slash-items.ts` | Item definitions + `filterSlashItems` (pure, testable) |
| Create | `src/lib/slash-menu/slash-items.test.ts` | Unit tests for filter |
| Create | `src/lib/slash-menu/SlashMenu.svelte` | Floating list UI |
| Modify | `src/components/RichEditor.svelte` | Shortcuts + slash detection + wiring |

---

## Task 1: slash-items.ts — item definitions + tests

**Files:**
- Create: `src/lib/slash-menu/slash-items.ts`
- Create: `src/lib/slash-menu/slash-items.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/slash-menu/slash-items.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SLASH_ITEMS, filterSlashItems } from './slash-items'

describe('SLASH_ITEMS', () => {
  it('has 12 items', () => {
    expect(SLASH_ITEMS).toHaveLength(12)
  })
  it('every item has id, label, keywords, icon, desc, execute', () => {
    for (const item of SLASH_ITEMS) {
      expect(typeof item.id).toBe('string')
      expect(typeof item.label).toBe('string')
      expect(Array.isArray(item.keywords)).toBe(true)
      expect(typeof item.icon).toBe('string')
      expect(typeof item.desc).toBe('string')
      expect(typeof item.execute).toBe('function')
    }
  })
  it('ids are unique', () => {
    const ids = SLASH_ITEMS.map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('filterSlashItems', () => {
  it('returns all items for empty query', () => {
    expect(filterSlashItems('')).toHaveLength(12)
  })
  it('filters by label (Chinese)', () => {
    const result = filterSlashItems('代码')
    expect(result.some(i => i.id === 'code')).toBe(true)
  })
  it('filters by keyword (English)', () => {
    const result = filterSlashItems('table')
    expect(result.some(i => i.id === 'table')).toBe(true)
  })
  it('filters by keyword (todo)', () => {
    const result = filterSlashItems('todo')
    expect(result.some(i => i.id === 'task')).toBe(true)
  })
  it('returns empty array for no match', () => {
    expect(filterSlashItems('zzznomatch999')).toHaveLength(0)
  })
  it('is case-insensitive', () => {
    expect(filterSlashItems('CODE').some(i => i.id === 'code')).toBe(true)
  })
})
```

- [ ] **Step 2: Run — expect failure**

```bash
cd /Users/bruce/git/mdeditor && npm test -- slash-items 2>&1 | tail -8
```
Expected: `Cannot find module './slash-items'`.

- [ ] **Step 3: Create slash-items.ts**

```bash
mkdir -p /Users/bruce/git/mdeditor/src/lib/slash-menu
```

Create `src/lib/slash-menu/slash-items.ts`:

```ts
import type { EditorView } from 'prosemirror-view'
import {
  setHeading,
  toggleCodeBlock,
  insertMathBlock,
  insertTable,
  toggleBlockquote,
  wrapInBulletList,
  wrapInOrderedList,
  wrapInTaskList,
  insertHorizontalRule,
} from '@moraya/core/commands'

export interface SlashItem {
  id: string
  label: string
  keywords: string[]
  icon: string
  desc: string
  execute: (view: EditorView) => void
}

function run(
  view: EditorView,
  command: (state: import('prosemirror-state').EditorState, dispatch: (tr: import('prosemirror-state').Transaction) => void) => boolean,
) {
  command(view.state, view.dispatch)
  view.focus()
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'h1',
    label: '标题 1',
    keywords: ['h1', 'heading', '标题', '一级', 'heading1'],
    icon: 'H1',
    desc: '一级大标题',
    execute: (v) => run(v, setHeading(1)),
  },
  {
    id: 'h2',
    label: '标题 2',
    keywords: ['h2', 'heading', '标题', '二级', 'heading2'],
    icon: 'H2',
    desc: '二级标题',
    execute: (v) => run(v, setHeading(2)),
  },
  {
    id: 'h3',
    label: '标题 3',
    keywords: ['h3', 'heading', '标题', '三级', 'heading3'],
    icon: 'H3',
    desc: '三级标题',
    execute: (v) => run(v, setHeading(3)),
  },
  {
    id: 'quote',
    label: '引用',
    keywords: ['quote', 'blockquote', '引用', '引言', 'block'],
    icon: '❝',
    desc: '引用块',
    execute: (v) => run(v, toggleBlockquote),
  },
  {
    id: 'code',
    label: '代码块',
    keywords: ['code', 'codeblock', '代码', 'programming', 'pre'],
    icon: '{}',
    desc: '带语法高亮的代码块',
    execute: (v) => run(v, toggleCodeBlock),
  },
  {
    id: 'mermaid',
    label: 'Mermaid 图表',
    keywords: ['mermaid', 'diagram', 'chart', '图表', '流程图', '时序图', 'flowchart'],
    icon: '⬡',
    desc: '流程图、时序图、甘特图…',
    execute: (v) => {
      const cb = v.state.schema.nodes.code_block
      if (!cb) return
      v.dispatch(v.state.tr.replaceSelectionWith(cb.create({ language: 'mermaid' })).scrollIntoView())
      v.focus()
    },
  },
  {
    id: 'math',
    label: '数学公式',
    keywords: ['math', 'equation', 'latex', '数学', '公式', 'formula'],
    icon: '∑',
    desc: 'LaTeX 数学公式块',
    execute: (v) => run(v, insertMathBlock),
  },
  {
    id: 'table',
    label: '表格',
    keywords: ['table', '表格', 'grid'],
    icon: '▦',
    desc: '3×3 可编辑表格',
    execute: (v) => run(v, insertTable),
  },
  {
    id: 'bullet',
    label: '无序列表',
    keywords: ['bullet', 'list', 'ul', '列表', '无序', '项目'],
    icon: '•',
    desc: '无序列表',
    execute: (v) => run(v, wrapInBulletList),
  },
  {
    id: 'ordered',
    label: '有序列表',
    keywords: ['ordered', 'list', 'ol', '列表', '有序', '编号', 'numbered'],
    icon: '1.',
    desc: '有序列表',
    execute: (v) => run(v, wrapInOrderedList),
  },
  {
    id: 'task',
    label: '任务列表',
    keywords: ['task', 'todo', 'checklist', '任务', '待办', '清单', 'checkbox'],
    icon: '☐',
    desc: '任务清单 / Todo',
    execute: (v) => run(v, wrapInTaskList),
  },
  {
    id: 'hr',
    label: '分割线',
    keywords: ['hr', 'divider', 'rule', '分割', '横线', 'horizontal'],
    icon: '—',
    desc: '水平分割线',
    execute: (v) => run(v, insertHorizontalRule),
  },
]

export function filterSlashItems(query: string): SlashItem[] {
  if (!query) return SLASH_ITEMS
  const q = query.toLowerCase()
  return SLASH_ITEMS.filter(item =>
    item.label.toLowerCase().includes(q) ||
    item.keywords.some(k => k.toLowerCase().includes(q))
  )
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/bruce/git/mdeditor && npm test -- slash-items 2>&1 | tail -8
```
Expected: all 9 tests pass.

- [ ] **Step 5: TypeScript check**

```bash
cd /Users/bruce/git/mdeditor && npm run check 2>&1 | grep "error" | head -5
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/slash-menu/slash-items.ts src/lib/slash-menu/slash-items.test.ts
git commit -m "feat: slash-menu item definitions and filter with tests"
```

---

## Task 2: SlashMenu.svelte

**Files:**
- Create: `src/lib/slash-menu/SlashMenu.svelte`

- [ ] **Step 1: Create SlashMenu.svelte**

```svelte
<script lang="ts">
  import type { SlashItem } from './slash-items'

  let {
    position,
    items,
    selectedIndex,
    onSelect,
    onClose,
  }: {
    position: { top: number; left: number }
    items: SlashItem[]
    selectedIndex: number
    onSelect: (item: SlashItem) => void
    onClose: () => void
  } = $props()

  let menuEl: HTMLDivElement | undefined = $state()
  let adjustedTop = $state(position.top)
  let adjustedLeft = $state(position.left)

  // Flip up if menu would overflow bottom of viewport
  $effect(() => {
    if (!menuEl) return
    const rect = menuEl.getBoundingClientRect()
    adjustedTop = (position.top + rect.height > window.innerHeight)
      ? Math.max(4, position.top - rect.height - 8)
      : position.top + 4
    adjustedLeft = (position.left + rect.width > window.innerWidth)
      ? Math.max(4, window.innerWidth - rect.width - 4)
      : position.left
  })

  // Scroll selected item into view
  $effect(() => {
    if (!menuEl) return
    const el = menuEl.querySelectorAll<HTMLElement>('.slash-item')[selectedIndex]
    el?.scrollIntoView({ block: 'nearest' })
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="slash-backdrop" onclick={onClose}>
  <div
    bind:this={menuEl}
    class="slash-menu"
    style="top: {adjustedTop}px; left: {adjustedLeft}px"
    onclick={(e) => e.stopPropagation()}
  >
    {#if items.length === 0}
      <div class="slash-empty">无匹配项</div>
    {:else}
      {#each items as item, i (item.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="slash-item"
          class:selected={i === selectedIndex}
          onclick={() => onSelect(item)}
        >
          <span class="slash-icon">{item.icon}</span>
          <div class="slash-text">
            <span class="slash-label">{item.label}</span>
            <span class="slash-desc">{item.desc}</span>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .slash-backdrop {
    position: fixed;
    inset: 0;
    z-index: 70;
  }

  .slash-menu {
    position: fixed;
    width: 248px;
    max-height: 340px;
    overflow-y: auto;
    padding: 4px;
    background: Canvas;
    border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas);
    border-radius: 8px;
    box-shadow: 0 4px 16px color-mix(in srgb, CanvasText 12%, transparent);
    z-index: 71;
  }

  .slash-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 7px;
    border-radius: 5px;
    cursor: pointer;
    user-select: none;
  }

  .slash-item:hover,
  .slash-item.selected {
    background: color-mix(in srgb, AccentColor 10%, Canvas);
  }

  .slash-icon {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, CanvasText 6%, Canvas);
    border: 1px solid color-mix(in srgb, CanvasText 10%, Canvas);
    border-radius: 5px;
    font-size: 11px;
    font-weight: 700;
    font-family: ui-monospace, Menlo, monospace;
    color: CanvasText;
  }

  .slash-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .slash-label {
    font-size: 13px;
    font-weight: 500;
    color: CanvasText;
    line-height: 1.3;
  }

  .slash-desc {
    font-size: 11px;
    color: color-mix(in srgb, CanvasText 55%, Canvas);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .slash-empty {
    padding: 8px 12px;
    font-size: 13px;
    color: color-mix(in srgb, CanvasText 45%, Canvas);
    text-align: center;
  }
</style>
```

- [ ] **Step 2: TypeScript check**

```bash
cd /Users/bruce/git/mdeditor && npm run check 2>&1 | grep "error" | head -5
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/slash-menu/SlashMenu.svelte
git commit -m "feat: SlashMenu floating list component"
```

---

## Task 3: RichEditor.svelte — keyboard shortcuts + slash menu wiring

**Files:**
- Modify: `src/components/RichEditor.svelte`

Read the file first to understand its current structure before making changes.

- [ ] **Step 1: Add imports**

In the `<script>` block, add after the existing imports:

```ts
import SlashMenu from '../lib/slash-menu/SlashMenu.svelte'
import { SLASH_ITEMS, filterSlashItems, type SlashItem } from '../lib/slash-menu/slash-items'
import {
  setHeading, toggleCodeBlock, insertMathBlock, insertTable,
  toggleBlockquote, wrapInBulletList, wrapInOrderedList, wrapInTaskList,
  insertHorizontalRule,
} from '@moraya/core/commands'
```

- [ ] **Step 2: Add slash menu state variables**

Add after the `let imageToolbarTargetPos` declaration:

```ts
// ── Slash menu state ─────────────────────────────────────────────────────────
let showSlashMenu    = $state(false)
let slashMenuPos     = $state({ top: 0, left: 0 })
let slashItems       = $state<SlashItem[]>(SLASH_ITEMS)
let slashSelectedIdx = $state(0)
```

- [ ] **Step 3: Add slash menu logic functions**

Add after `handleToolbarResize`:

```ts
function closeSlashMenu() {
  showSlashMenu    = false
  slashItems       = SLASH_ITEMS
  slashSelectedIdx = 0
}

function checkSlashMenu() {
  if (!editor) return
  const view = editor.view as unknown as EditorView
  const { selection } = view.state
  const { $from } = selection

  if ($from.parent.type.name !== 'paragraph') { closeSlashMenu(); return }

  const textToCursor = $from.parent.textBetween(0, $from.parentOffset, '')
  const match = /^\/([a-zA-Z0-9一-龥]*)$/.exec(textToCursor)
  if (!match) { closeSlashMenu(); return }

  const coords = view.coordsAtPos($from.pos)
  slashItems       = filterSlashItems(match[1])
  slashMenuPos     = { top: coords.bottom, left: coords.left }
  slashSelectedIdx = 0
  showSlashMenu    = true
}

function executeSlashItem(item: SlashItem) {
  if (!editor) return
  const view = editor.view as unknown as EditorView
  const { $from } = view.state.selection
  // Delete '/' + filter text (from paragraph start to cursor)
  view.dispatch(view.state.tr.delete($from.start(), $from.pos))
  item.execute(view)
  closeSlashMenu()
}
```

- [ ] **Step 4: Add handleRichKeydown**

Add after `executeSlashItem`:

```ts
function handleRichKeydown(event: KeyboardEvent) {
  // ── Slash menu navigation (highest priority) ──
  if (showSlashMenu) {
    if (event.key === 'ArrowDown') {
      event.preventDefault(); event.stopImmediatePropagation()
      slashSelectedIdx = Math.min(slashSelectedIdx + 1, slashItems.length - 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault(); event.stopImmediatePropagation()
      slashSelectedIdx = Math.max(slashSelectedIdx - 1, 0)
      return
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && slashItems.length > 0) {
      event.preventDefault(); event.stopImmediatePropagation()
      executeSlashItem(slashItems[slashSelectedIdx])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation()
      closeSlashMenu()
      return
    }
  }

  if (!editor) return
  const mod   = event.metaKey || event.ctrlKey
  const shift = event.shiftKey
  const alt   = event.altKey
  const key   = event.key.toLowerCase()
  const view  = editor.view as unknown as EditorView

  // ── Heading shortcuts: Cmd+1-6 ──
  if (mod && !shift && !alt && /^[1-6]$/.test(event.key)) {
    event.preventDefault()
    setHeading(parseInt(event.key))(view.state, view.dispatch)
    view.focus(); return
  }

  // ── Paragraph: Cmd+0 ──
  if (mod && !shift && !alt && event.key === '0') {
    event.preventDefault()
    const para = view.state.schema.nodes.paragraph
    if (para) view.dispatch(view.state.tr.setBlockType(view.state.selection.from, view.state.selection.to, para).scrollIntoView())
    view.focus(); return
  }

  // ── Code block: Cmd+Shift+K ──
  if (mod && shift && !alt && key === 'k') {
    event.preventDefault()
    toggleCodeBlock(view.state, view.dispatch); view.focus(); return
  }

  // ── Math block: Cmd+Shift+M ──
  if (mod && shift && !alt && key === 'm') {
    event.preventDefault()
    insertMathBlock(view.state, view.dispatch); view.focus(); return
  }

  // ── Table: Cmd+Shift+T ──
  if (mod && shift && !alt && key === 't') {
    event.preventDefault()
    insertTable(view.state, view.dispatch); view.focus(); return
  }

  // ── Blockquote: Cmd+Shift+Q ──
  if (mod && shift && !alt && key === 'q') {
    event.preventDefault()
    toggleBlockquote(view.state, view.dispatch); view.focus(); return
  }

  // ── Bullet list: Cmd+Opt+U ──
  if (mod && !shift && alt && key === 'u') {
    event.preventDefault()
    wrapInBulletList(view.state, view.dispatch); view.focus(); return
  }

  // ── Ordered list: Cmd+Opt+O ──
  if (mod && !shift && alt && key === 'o') {
    event.preventDefault()
    wrapInOrderedList(view.state, view.dispatch); view.focus(); return
  }

  // ── Task list: Cmd+Opt+X ──
  if (mod && !shift && alt && key === 'x') {
    event.preventDefault()
    wrapInTaskList(view.state, view.dispatch); view.focus(); return
  }
}
```

- [ ] **Step 5: Register listeners in onMount**

After `_pmEl?.addEventListener('click', handleVideoLinkClick as EventListener, true)`, add:

```ts
_pmEl?.addEventListener('keydown', handleRichKeydown as EventListener, true)
_pmEl?.addEventListener('input',   checkSlashMenu as EventListener)
```

- [ ] **Step 6: Remove listeners in onDestroy**

After `_pmEl?.removeEventListener('click', handleVideoLinkClick as EventListener, true)`, add:

```ts
_pmEl?.removeEventListener('keydown', handleRichKeydown as EventListener, true)
_pmEl?.removeEventListener('input',   checkSlashMenu as EventListener)
```

- [ ] **Step 7: Add SlashMenu to template**

Inside the `<div class="rich-wrap">`, after the `{#if showImageToolbar}` block, add:

```svelte
  {#if showSlashMenu}
    <SlashMenu
      position={slashMenuPos}
      items={slashItems}
      selectedIndex={slashSelectedIdx}
      onSelect={executeSlashItem}
      onClose={closeSlashMenu}
    />
  {/if}
```

- [ ] **Step 8: TypeScript check + all tests**

```bash
cd /Users/bruce/git/mdeditor && npm run check 2>&1 | grep "error" | head -10
npm test 2>&1 | tail -5
```
Expected: no TS errors, all tests pass.

- [ ] **Step 9: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/components/RichEditor.svelte
git commit -m "feat: rich mode keyboard shortcuts and slash command menu"
```

---

## Manual Integration Test

After `npm run tauri dev`:

**Keyboard shortcuts:**
- [ ] `Cmd+1` on any paragraph → converts to H1
- [ ] `Cmd+1` again on H1 → converts back to paragraph (toggle)
- [ ] `Cmd+2` → H2, `Cmd+3` → H3 … `Cmd+6` → H6
- [ ] `Cmd+0` → converts heading back to paragraph
- [ ] `Cmd+Shift+K` → inserts code block
- [ ] `Cmd+Shift+T` → inserts 3×3 table
- [ ] `Cmd+Shift+M` → inserts math block
- [ ] `Cmd+Shift+Q` → wraps in blockquote
- [ ] `Cmd+Opt+U` → bullet list; `Cmd+Opt+O` → ordered list; `Cmd+Opt+X` → task list

**Slash menu:**
- [ ] Empty line → type `/` → slash menu appears with all 12 items
- [ ] Type `/代码` → list filters to code block only
- [ ] Type `/table` → filters to 表格
- [ ] `↓ ↑` arrows → navigate selected item (highlighted in blue)
- [ ] Press `Enter` or `Tab` → inserts block, menu closes, `/` deleted
- [ ] `Esc` → menu closes without inserting
- [ ] Click outside menu → closes
- [ ] Type `/` in middle of a sentence → menu does NOT open (only at paragraph start)
- [ ] Type `/` inside a code block or heading → menu does NOT open
