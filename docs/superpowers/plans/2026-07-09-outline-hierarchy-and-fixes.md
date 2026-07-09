# Outline H2/H3 Hierarchy + Highlight Underline + Adaptive Icons + Collapse Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive the outline from H2–H6 heading paths that lead to highlights (skipping H1), show highlights as a yellow underline, scale the leading triangle/bullet with the theme typography, and fix the broken collapse toggle.

**Architecture:** `deriveAutoItems` is rewritten to walk a relative H2+ heading stack, emitting a heading only lazily when a highlight under it appears; H1 resets the stack and is never emitted. `OutlineNode.svelte` gets three independent changes: highlight styling (underline), em/line-height-based icon sizing, and a reactivity fix that routes collapse state through `outline.version`-reading deriveds.

**Tech Stack:** TypeScript, Vitest (pure-TS derive tests), Svelte 5 runes, existing outline model/sync.

**Spec:** `docs/superpowers/specs/2026-07-09-outline-hierarchy-and-fixes-design.md`

**Conventions:**
- Single test file: `pnpm exec vitest run src/lib/outline/derive.test.ts`
- Full suite: `pnpm test` · Type-check: `pnpm check`
- Component behavior (underline / icon scaling / collapse) is verified by running a dev build — see `reference-dev-gui-verification` memory (kill any running `/Applications/M↓` first; `pnpm tauri dev`; osascript drives the window; `/tmp/mdeditor.log`).

---

### Task 1: Rewrite `deriveAutoItems` — H2/H3 hierarchy, skip H1, highlight-led

**Files:**
- Modify: `src/lib/outline/derive.ts`
- Test: `src/lib/outline/derive.test.ts` (full rewrite)

- [ ] **Step 1: Replace the test file**

Overwrite `src/lib/outline/derive.test.ts` with:

```typescript
// src/lib/outline/derive.test.ts
import { describe, it, expect } from 'vitest'
import { deriveAutoItems, type AutoItem } from './derive'

const strip = (items: AutoItem[]) => items.map(({ source, content, depth, anchorLine }) => ({ source, content, depth, anchorLine }))

describe('deriveAutoItems (H2+ paths to highlights, H1 skipped)', () => {
  it('skips the H1 title; highlight groups under its H2', () => {
    const md = '# Title\n## A\nsome ^^x^^ here\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 2 },
      { source: 'highlight', content: 'x', depth: 1, anchorLine: 3 },
    ])
  })
  it('nests sub-headings relatively (H2=0, H3=1, highlight under H3=2)', () => {
    const md = '## A\n### A1\n^^x^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 1 },
      { source: 'toc', content: 'A1', depth: 1, anchorLine: 2 },
      { source: 'highlight', content: 'x', depth: 2, anchorLine: 3 },
    ])
  })
  it('emits only heading paths that lead to a highlight', () => {
    const md = '## A\ntext only\n## B\n^^x^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'B', depth: 0, anchorLine: 3 },
      { source: 'highlight', content: 'x', depth: 1, anchorLine: 4 },
    ])
  })
  it('emits an ancestor heading whose descendant (not itself) has the highlight', () => {
    const md = '## B\n### B1\n^^x^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'B', depth: 0, anchorLine: 1 },
      { source: 'toc', content: 'B1', depth: 1, anchorLine: 2 },
      { source: 'highlight', content: 'x', depth: 2, anchorLine: 3 },
    ])
  })
  it('emits each heading once for multiple highlights', () => {
    const md = '## A\n^^one^^\n^^two^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 1 },
      { source: 'highlight', content: 'one', depth: 1, anchorLine: 2 },
      { source: 'highlight', content: 'two', depth: 1, anchorLine: 3 },
    ])
  })
  it('a new H1 resets the sub-heading stack', () => {
    const md = '# A\n## X\n^^x^^\n# B\n^^y^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'X', depth: 0, anchorLine: 2 },
      { source: 'highlight', content: 'x', depth: 1, anchorLine: 3 },
      { source: 'highlight', content: 'y', depth: 0, anchorLine: 5 },
    ])
  })
  it('highlight before any H2 sits at depth 0 with no heading', () => {
    const md = 'intro ^^early^^\n## A\n^^under^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'highlight', content: 'early', depth: 0, anchorLine: 1 },
      { source: 'toc', content: 'A', depth: 0, anchorLine: 2 },
      { source: 'highlight', content: 'under', depth: 1, anchorLine: 3 },
    ])
  })
  it('a doc with no highlights yields nothing', () => {
    expect(strip(deriveAutoItems('# T\n## A\n### B\nplain\n'))).toEqual([])
  })
  it('skips frontmatter and fenced code', () => {
    const md = '---\ntitle: x\n---\n## Real\n^^kept^^\n```\n^^not^^\n```\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'Real', depth: 0, anchorLine: 4 },
      { source: 'highlight', content: 'kept', depth: 1, anchorLine: 5 },
    ])
  })
  it('supports == highlights and multiple per line, in order', () => {
    const md = '## H\n^^a^^ and ==b==\n'
    expect(strip(deriveAutoItems(md)).map(i => i.content)).toEqual(['H', 'a', 'b'])
  })
  it('== noise (a==b) does not create false highlights', () => {
    const md = '## H\nformula a==b and ==real==\n'
    expect(strip(deriveAutoItems(md)).map(i => i.content)).toEqual(['H', 'real'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/lib/outline/derive.test.ts`
Expected: FAIL — the current implementation emits the H1 and flattens to a single top-level H1.

- [ ] **Step 3: Rewrite `deriveAutoItems`**

Replace the whole body of `src/lib/outline/derive.ts` with:

```typescript
// src/lib/outline/derive.ts
export interface AutoItem {
  source: 'toc' | 'highlight'
  content: string
  /** 树深度：H2 = 0，H3 = 1…；对应高亮 = 栈深；任何 H2 之前的高亮 = 0 */
  depth: number
  anchorLine: number
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const HIGHLIGHT_RE = /\^\^([^^\n]+?)\^\^|(?<![\w=])==([^\s=][^=\n]*?)==(?![\w=])/g

interface StackEntry { level: number; content: string; anchorLine: number; emitted: boolean }

/**
 * Derive outline auto-items from highlights only. Each highlight is grouped
 * under its nearest sub-heading path (H2–H6, nested relatively). The document
 * H1 is skipped entirely (and resets the sub-heading stack). A heading is
 * emitted lazily — only when a highlight beneath it appears — so only heading
 * paths that lead to a highlight show up.
 */
export function deriveAutoItems(md: string): AutoItem[] {
  const lines = md.split('\n')
  const items: AutoItem[] = []
  const stack: StackEntry[] = []
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
      if (level === 1) { stack.length = 0; continue }   // skip H1, reset context
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, content: h[2].trim(), anchorLine: li + 1, emitted: false })
      continue
    }

    HIGHLIGHT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HIGHLIGHT_RE.exec(line)) !== null) {
      const text = (m[1] ?? m[2]).trim()
      if (!text) continue
      // Lazily emit the heading path leading to this highlight (shallow → deep).
      for (let d = 0; d < stack.length; d++) {
        const entry = stack[d]
        if (entry.emitted) continue
        items.push({ source: 'toc', content: entry.content, depth: d, anchorLine: entry.anchorLine })
        entry.emitted = true
      }
      items.push({ source: 'highlight', content: text, depth: stack.length, anchorLine: li + 1 })
    }
  }
  return items
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/lib/outline/derive.test.ts`
Expected: PASS (all 11 cases).

- [ ] **Step 5: Update the sync tests that feed markdown through `deriveAutoItems`**

`src/lib/outline/sync.test.ts` builds trees via `deriveAutoItems(md1)` where `md1 = '# A\n## B\n^^hl^^\n'`. Under the new contract this derives `[toc B d0, highlight hl d1]` (H1 `A` is skipped, `B` is the top-level heading). Update the three affected expectations:

Replace the `md1` build assertions in `src/lib/outline/sync.test.ts`:

```typescript
  it('builds initial auto tree', () => {
    const t = build(md1)
    const roots = childrenOf(t, null)
    // H1 A is skipped; B is the top-level heading; hl nests under B.
    expect(roots.map(n => [n.source, n.content])).toEqual([['toc', 'B']])
    expect(childrenOf(t, roots[0].id).map(n => [n.source, n.content])).toEqual([['highlight', 'hl']])
  })
```

The other three cases (`keeps id + collapsed...`, `removing highlight...`, `regenerate rebuilds...`) already reference node `B` / the highlight / count `toc` — verify each still holds under `[toc B, highlight hl]`:
- `keeps id + collapsed + manual children`: uses `content === 'B'` — still valid (B exists). No change.
- `removing highlight deletes its node`: re-derives `'# A\n^^other^^\n'`. Under new contract this has **no H2**, so it derives `[highlight other d0]` (no toc). The old `hl` is removed; `child` (was under `hl`) reparents to nearest survivor. With no surviving heading, it reparents to root (`null`). Update the assertion:

```typescript
  it('removing highlight deletes its node; manual children reparent to nearest survivor', () => {
    const t = build(md1)
    const hl = [...t.nodes.values()].find(n => n.source === 'highlight')!
    addNode(t, { id: 'child', parentId: hl.id, order: 0, content: 'attached', collapsed: false, source: 'manual' })
    // Re-derive keeps heading B (still has a highlight) but drops the old 'hl'.
    syncAutoItems(t, deriveAutoItems('## B\n^^other^^\n'))
    expect([...t.nodes.values()].some(n => n.content === 'hl')).toBe(false)
    const child = t.nodes.get('child')!
    const b = [...t.nodes.values()].find(n => n.content === 'B')!
    expect(child.parentId).toBe(b.id)
  })
```

- `regenerate rebuilds autos fresh but keeps manual nodes`: asserts `toc` count. `md1` now derives exactly one toc (`B`). If the existing assertion is `toHaveLength(1)` it passes; if it still says `2`, change to `1`:

```typescript
    expect([...t.nodes.values()].filter(n => n.source === 'toc')).toHaveLength(1)
```

Also the `anchorLine refreshes on match` case re-derives `'intro\n\n# A\n## B\n^^hl^^\n'` and asserts A's anchorLine — under the new contract `A` (H1) is skipped, so change it to assert `B`'s anchorLine (line 4):

```typescript
  it('anchorLine refreshes on match', () => {
    const t = build(md1)
    syncAutoItems(t, deriveAutoItems('intro\n\n# A\n## B\n^^hl^^\n'))
    expect([...t.nodes.values()].find(n => n.content === 'B')!.anchorLine).toBe(4)
  })
```

And `root-level manual node survives` re-derives `'# A2\n'` (only H1 → empty derive) — unchanged behavior (autos cleared, manual root survives). No change.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS (all files). If a sync assertion still fails, read the actual vs expected and align it with the `[toc B, highlight hl]` contract (do not change sync.ts).

- [ ] **Step 7: Commit**

```bash
git add src/lib/outline/derive.ts src/lib/outline/derive.test.ts src/lib/outline/sync.test.ts
git commit -m "feat(outline): derive H2/H3 heading paths to highlights, skip H1"
```

---

### Task 2: Highlight underline + adaptive icons + collapse fix (OutlineNode)

**Files:**
- Modify: `src/components/outline/OutlineNode.svelte`

- [ ] **Step 1: Add version-reading deriveds for collapse (fix reactivity)**

In the `<script>`, right after the existing `let editing = $derived(outline.editingId === node.id)` line, add:

```svelte
  let isCollapsed = $derived.by(() => { void outline.version; return node.collapsed })
  let showChildren = $derived.by(() => {
    void outline.version
    return visibleIds ? kids.length > 0 : !node.collapsed
  })
```

- [ ] **Step 2: Route the triangle + child render through the deriveds**

Replace the triangle button (currently `class:closed={node.collapsed}`):

```svelte
    {#if kids.length > 0}
      <button class="tri" class:closed={isCollapsed}
        onclick={() => { node.collapsed = !node.collapsed; bump(); markDirty() }}>▾</button>
    {:else}<span class="tri-spacer"></span>{/if}
```

Replace the child-render guard (currently `{#if visibleIds ? kids.length > 0 : !node.collapsed}`):

```svelte
  {#if showChildren}
    {#each kids as child (child.id)}
      <OutlineNode node={child} depth={depth + 1} {resolved} {onJump} {onPageClick} {onEditorInput} {onContextMenu} {onDragOp} {visibleIds} />
    {/each}
  {/if}
```

- [ ] **Step 3: Change highlight style from background to yellow underline**

Replace the `.content.hl, textarea.hl` rule:

```css
  .content.hl,
  textarea.hl {
    text-decoration: underline;
    text-decoration-color: var(--highlight-underline, #e0a500);
    text-decoration-thickness: 2px;
    text-underline-offset: 2px;
  }
```

- [ ] **Step 4: Make the leading icons scale with theme typography**

Replace the `.tri`, `.tri-spacer`, and `.bullet` rules:

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

(The `.bullet.src-toc` / `.bullet.src-hl` color rules below stay unchanged.)

- [ ] **Step 5: Type-check**

Run: `pnpm check`
Expected: 0 errors (pre-existing a11y warnings on the file remain).

- [ ] **Step 6: Commit**

```bash
git add src/components/outline/OutlineNode.svelte
git commit -m "fix(outline): yellow-underline highlights, typography-scaled icons, working collapse"
```

---

### Task 3: Verification (unit + dev-build in-app)

- [ ] **Step 1: Unit suite + type-check**

Run: `pnpm test && pnpm check`
Expected: all tests pass, 0 type errors.

- [ ] **Step 2: Dev build — collapse + visuals**

Per the `reference-dev-gui-verification` memory:
- `killall mdeditor` (drop any running installed app so single-instance doesn't block dev).
- `pnpm tauri dev` (background). Wait for `RunEvent::Ready` in `/tmp/mdeditor.log`.
- Open a doc with `## / ###` headings and `^^..^^` highlights (via `src-tauri/target/debug/mdeditor <path>` forwarding). Confirm:
  - The document H1 is not shown; only H2/H3 paths that lead to a highlight appear, with highlights nested under their nearest heading.
  - Highlights render as a yellow underline (not a yellow background).
  - Clicking a node's collapse triangle hides/shows its children and rotates the arrow (collapse works).
  - Changing the theme font size/line height scales the triangle and bullet proportionally.
- Screenshot with `screencapture -x -o /tmp/shot.png` and inspect.

- [ ] **Step 3: Commit any verification fixups** (only if needed)

```bash
git add -A
git commit -m "fix(outline): address dev-verification findings"
```
