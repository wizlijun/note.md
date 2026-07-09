# Outline Highlights-Only Derivation + Read-Only Focusable Nodes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the outline derive only highlights (grouped under their top-level H1 as read-only context), render highlights yellow, and let read-only auto nodes take a caret / create a manual sibling on Enter / jump to source via the bullet.

**Architecture:** `deriveAutoItems` is rewritten to emit only highlight items plus the single top-level H1 that contains them. `OutlineNode.svelte` makes auto nodes focusable with a `readonly` textarea, wires Enter to `createSiblingBelow`, moves jump-to-source onto the bullet click, and paints highlight nodes with the highlight background. Persistence is unchanged — the existing `isEffectivelyEmpty` guard already skips writing when no highlights/manual content exist.

**Tech Stack:** TypeScript, Vitest (pure-TS derive tests), Svelte 5 runes, existing outline model/commands.

**Spec:** `docs/superpowers/specs/2026-07-09-outline-highlights-only-design.md`

**Conventions:**
- Run a single test file: `pnpm exec vitest run src/lib/outline/derive.test.ts`
- Full suite: `pnpm test` · Type-check: `pnpm check`
- Component behavior (readonly focus / Enter / bullet jump / yellow) is verified manually by running the app.

---

### Task 1: Rewrite `deriveAutoItems` — highlights only, grouped under top-level H1

**Files:**
- Modify: `src/lib/outline/derive.ts`
- Test: `src/lib/outline/derive.test.ts` (full rewrite)

- [ ] **Step 1: Replace the test file with the new behavior spec**

Overwrite `src/lib/outline/derive.test.ts` with:

```typescript
// src/lib/outline/derive.test.ts
import { describe, it, expect } from 'vitest'
import { deriveAutoItems, type AutoItem } from './derive'

const strip = (items: AutoItem[]) => items.map(({ source, content, depth, anchorLine }) => ({ source, content, depth, anchorLine }))

describe('deriveAutoItems (highlights only, grouped under top-level H1)', () => {
  it('emits the containing H1 (read-only) then its highlights', () => {
    const md = '# A\n\nsome ^^first^^ text\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 1 },
      { source: 'highlight', content: 'first', depth: 1, anchorLine: 3 },
    ])
  })
  it('emits each H1 only once even with multiple highlights', () => {
    const md = '# A\n^^one^^\n^^two^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 1 },
      { source: 'highlight', content: 'one', depth: 1, anchorLine: 2 },
      { source: 'highlight', content: 'two', depth: 1, anchorLine: 3 },
    ])
  })
  it('ignores sub-headings; their highlights attach to the top-level H1', () => {
    const md = '# A\n\n## B\n\n^^deep^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 1 },
      { source: 'highlight', content: 'deep', depth: 1, anchorLine: 5 },
    ])
  })
  it('omits H1s that contain no highlights', () => {
    const md = '# A\n\ntext only\n\n# B\n\n^^hit^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'B', depth: 0, anchorLine: 5 },
      { source: 'highlight', content: 'hit', depth: 1, anchorLine: 7 },
    ])
  })
  it('a heading-less doc yields nothing', () => {
    expect(strip(deriveAutoItems('# A\n\n## B\n\nplain text\n'))).toEqual([])
  })
  it('highlights before any H1 sit at depth 0 with no toc', () => {
    const md = 'intro ^^early^^\n\n# A\n\n^^under^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'highlight', content: 'early', depth: 0, anchorLine: 1 },
      { source: 'toc', content: 'A', depth: 0, anchorLine: 3 },
      { source: 'highlight', content: 'under', depth: 1, anchorLine: 5 },
    ])
  })
  it('skips frontmatter and fenced code', () => {
    const md = '---\ntitle: x\n---\n# Real\n^^kept^^\n```\n^^not a highlight^^\n```\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'Real', depth: 0, anchorLine: 4 },
      { source: 'highlight', content: 'kept', depth: 1, anchorLine: 5 },
    ])
  })
  it('supports == highlights and multiple per line, in order', () => {
    const md = '# H\n^^a^^ and ==b==\n'
    expect(strip(deriveAutoItems(md)).map(i => i.content)).toEqual(['H', 'a', 'b'])
  })
  it('== noise (a==b) does not create false highlights', () => {
    const md = '# H\nformula a==b and ==real==\n'
    expect(strip(deriveAutoItems(md)).map(i => i.content)).toEqual(['H', 'real'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/lib/outline/derive.test.ts`
Expected: FAIL — old implementation emits every heading (e.g. `## B`) and heading-less/omitted-H1 cases don't match.

- [ ] **Step 3: Rewrite `deriveAutoItems`**

Replace the body of `src/lib/outline/derive.ts` (keep the `AutoItem` interface, update its doc comment; replace the constants + function) with:

```typescript
// src/lib/outline/derive.ts
export interface AutoItem {
  source: 'toc' | 'highlight'
  content: string
  /** 树深度：顶层 H1 = 0；其下高亮 = 1；任何 H1 之前的高亮 = 0 */
  depth: number
  anchorLine: number
}

const H1_RE = /^#\s+(.*)$/
const HIGHLIGHT_RE = /\^\^([^^\n]+?)\^\^|(?<![\w=])==([^\s=][^=\n]*?)==(?![\w=])/g

/**
 * Derive outline auto-items: only highlights, each grouped under the most recent
 * top-level `#` heading (emitted once, read-only, as context). Sub-headings
 * (`##`+) are ignored. H1s with no highlights are omitted.
 */
export function deriveAutoItems(md: string): AutoItem[] {
  const lines = md.split('\n')
  const items: AutoItem[] = []
  let inFence = false
  let start = 0

  // Current top-level H1 context, and whether we've already emitted its toc item.
  let h1Content: string | null = null
  let h1Line = 0
  let h1Emitted = false

  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1)
    if (close > 0) start = close + 1
  }

  for (let li = start; li < lines.length; li++) {
    const line = lines[li]
    if (/^(```|~~~)/.test(line.trim())) { inFence = !inFence; continue }
    if (inFence) continue

    const h1 = line.match(H1_RE)
    if (h1) {
      h1Content = h1[1].trim()
      h1Line = li + 1
      h1Emitted = false
      continue
    }

    HIGHLIGHT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HIGHLIGHT_RE.exec(line)) !== null) {
      const text = (m[1] ?? m[2]).trim()
      if (!text) continue
      if (h1Content !== null && !h1Emitted) {
        items.push({ source: 'toc', content: h1Content, depth: 0, anchorLine: h1Line })
        h1Emitted = true
      }
      items.push({ source: 'highlight', content: text, depth: h1Content !== null ? 1 : 0, anchorLine: li + 1 })
    }
  }
  return items
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/lib/outline/derive.test.ts`
Expected: PASS (all 9 cases).

- [ ] **Step 5: Run the full suite (sync/store tests depend on derive)**

Run: `pnpm test`
Expected: PASS. If any existing sync/store test asserted old multi-heading derivation, it belongs to a different module and should still pass; if a test in `sync.test.ts` or `store.test.ts` fails because it fed multi-heading markdown through `deriveAutoItems`, note it — those tests construct trees directly and do not call `deriveAutoItems`, so no failures are expected here.

- [ ] **Step 6: Commit**

```bash
git add src/lib/outline/derive.ts src/lib/outline/derive.test.ts
git commit -m "feat(outline): derive only highlights grouped under top-level H1"
```

---

### Task 2: Read-only focusable auto nodes + bullet jump + yellow highlight (OutlineNode)

**Files:**
- Modify: `src/components/outline/OutlineNode.svelte`

All snippets below are exact replacements of the current code in that file.

- [ ] **Step 1: Make click-to-focus unconditional and skip dirtying for auto nodes on commit**

Replace `startEdit` and `commitEdit` (lines ~40–48):

```svelte
  function startEdit() {
    outline.editingId = node.id
  }
  function commitEdit(value: string) {
    if (node.source !== 'manual') { outline.editingId = null; return }  // auto is read-only
    node.content = value
    outline.editingId = null
    bump(); markDirty()
  }
```

- [ ] **Step 2: Enter on a read-only auto node creates a manual sibling below**

In `onKeydown`, replace the Enter block (lines ~62–71):

```svelte
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      if (node.source !== 'manual') {
        // read-only: Enter spawns an editable manual sibling directly below
        const id = createSiblingBelow(outline.tree, node.id)
        bump(); markDirty(); focusNode(id)
        return
      }
      node.content = el.value
      // 行首 Enter → 上方建兄弟（render.cljs handle-key-down 语义）
      const id = atStart && el.value.length > 0
        ? createSiblingAbove(outline.tree, node.id)
        : createSiblingBelow(outline.tree, node.id)
      bump(); markDirty(); focusNode(id)
      return
    }
```

- [ ] **Step 3: Add a bullet click handler that jumps to source**

Add this function alongside the other handlers in the `<script>` (e.g. after `commitEdit`):

```svelte
  function onBulletClick() {
    if (node.anchorLine != null) onJump(node)
  }
```

- [ ] **Step 4: Render the read-only textarea, yellow highlight, and bullet click**

Replace the bullet `<span>` (lines ~145–151):

```svelte
    <span
      class="bullet"
      class:src-toc={node.source === 'toc'}
      class:src-hl={node.source === 'highlight'}
      draggable={node.source === 'manual'}
      ondragstart={onDragStart}
      onclick={onBulletClick}
    >•</span>
```

Replace the editing/non-editing block (lines ~152–172):

```svelte
    {#if editing}
      <textarea
        bind:this={textareaEl}
        class="content edit"
        class:hl={node.source === 'highlight'}
        rows="1"
        readonly={node.source !== 'manual'}
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
      <span class="content" class:hl={node.source === 'highlight'} onclick={startEdit} role="button" tabindex="0"
        onkeydown={(e) => { if (e.key === 'Enter') startEdit() }}>
        <InlineRender content={node.content} onPageClick={onPageClick} />
      </span>
    {/if}
```

- [ ] **Step 5: Add the highlight (yellow) styling and a pointer cursor for the bullet**

In the `<style>` block, replace the `.bullet` rule (line ~195) and append the highlight rule after `.content`:

```css
  .bullet { cursor: pointer; opacity: 0.7; }
  .content { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; cursor: text; }
  .content.hl,
  textarea.hl { background: var(--highlight-bg, #fde68a); border-radius: 2px; }
```

(Note: the original `.bullet` used `cursor: grab`; manual nodes are still draggable, but click now jumps — a pointer cursor communicates the click affordance. The existing `.content` rule is shown so you replace the pair together; leave the rest of the `.content` styling intact.)

- [ ] **Step 6: Type-check**

Run: `pnpm check`
Expected: 0 errors (pre-existing a11y warnings on `OutlineNode.svelte`/`OutlinePanel.svelte` remain).

- [ ] **Step 7: Commit**

```bash
git add src/components/outline/OutlineNode.svelte
git commit -m "feat(outline): read-only focusable auto nodes, bullet jump, yellow highlights"
```

---

### Task 3: Full verification

- [ ] **Step 1: Unit suite**

Run: `pnpm test`
Expected: PASS (new derive cases + all existing).

- [ ] **Step 2: Type-check**

Run: `pnpm check`
Expected: 0 errors.

- [ ] **Step 3: Manual verification (run the app, Outline plugin enabled)**

- Open a doc with headings but no highlights → outline empty, no `.notes.md` written to disk.
- Open a doc with `^^x^^` / `==y==` highlights → only H1s containing highlights show (read-only), highlights beneath them render with a yellow background; `.notes.md` appears.
- A highlight under `## Sub` attaches to the enclosing top-level `# H1`.
- Click a highlight's text → caret appears, typing does nothing; press Enter → an editable manual sibling appears directly below.
- Click the bullet dot of an auto node → editor jumps/reveals the source line.
- Manual notes still edit/indent/drag as before.

- [ ] **Step 4: Commit any manual-verification fixups** (only if needed)

```bash
git add -A
git commit -m "fix(outline): address manual-verification findings"
```
