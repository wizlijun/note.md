# Outline Independent View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the outline panel into a workspace-level right-hand column (symmetric with Folder View) that follows the active theme's typography, is editable by default without a `+` button, and uses Folder-View-style SVG toolbar icons.

**Architecture:** The panel is moved out of the `{#if current}` block in `App.svelte` so it persists regardless of the open document; `OutlinePanel.svelte` takes a nullable `tab` and renders a three-state body while managing the outline store lifecycle. Theme typography is read from an offscreen `[data-theme] .moraya-editor` probe and pushed into CSS variables consumed by the node rows. A save guard in the store prevents phantom `.notes.md` files for empty outlines.

**Tech Stack:** Svelte 5 (runes: `$state`/`$derived`/`$effect`/`$props`), TypeScript, Vitest, Tauri plugin-fs, existing outline store/model modules.

**Spec:** `docs/superpowers/specs/2026-07-09-outline-independent-view-design.md`

**Conventions:**
- Run unit tests: `pnpm test` (vitest run). A single file: `pnpm exec vitest run src/lib/outline/store.test.ts`.
- Type-check: `pnpm check` (svelte-check).
- Svelte components in this repo are verified manually (run the app) — the spec's "手动验证" list is the acceptance check; unit tests cover pure TS only.

---

### Task 1: `flushSave` empty-tree guard (store)

Prevents "just opening the panel" on a heading-less/highlight-less document from writing a `foo.notes.md` that contains only an empty placeholder node.

**Files:**
- Modify: `src/lib/outline/store.svelte.ts` (add `isEffectivelyEmpty`, gate `flushSave`)
- Test: `src/lib/outline/store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/outline/store.test.ts`:

```typescript
import { isEffectivelyEmpty } from './store.svelte'

describe('isEffectivelyEmpty', () => {
  it('true when tree has only empty manual nodes', () => {
    const t = createTree()
    addNode(t, { id: 'm1', parentId: null, order: 0, content: '', collapsed: false, source: 'manual' })
    addNode(t, { id: 'm2', parentId: null, order: 100, content: '   ', collapsed: false, source: 'manual' })
    expect(isEffectivelyEmpty(t)).toBe(true)
  })
  it('true for a brand-new empty tree', () => {
    expect(isEffectivelyEmpty(createTree())).toBe(true)
  })
  it('false when any manual node has content', () => {
    const t = createTree()
    addNode(t, { id: 'm1', parentId: null, order: 0, content: 'hi', collapsed: false, source: 'manual' })
    expect(isEffectivelyEmpty(t)).toBe(false)
  })
  it('false when any auto node exists', () => {
    const t = createTree()
    addNode(t, { id: 'toc1', parentId: null, order: 0, content: 'H', collapsed: false, source: 'toc', anchorLine: 1 })
    expect(isEffectivelyEmpty(t)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/outline/store.test.ts`
Expected: FAIL — `isEffectivelyEmpty is not a function` / import error.

- [ ] **Step 3: Implement `isEffectivelyEmpty` and gate `flushSave`**

In `src/lib/outline/store.svelte.ts`, add this exported helper (place it near `persistIdsFor`, after that function):

```typescript
/** True when the tree carries no meaningful outline: no auto nodes and every
 *  manual node is blank. Used to skip writing a phantom `.notes.md`. */
export function isEffectivelyEmpty(tree: OutlineTree): boolean {
  for (const n of tree.nodes.values()) {
    if (n.source !== 'manual') return false
    if (n.content.trim() !== '') return false
  }
  return true
}
```

Then in `flushSave`, add the guard right after the existing `if (!outline.dirty || !path) return` line:

```typescript
export async function flushSave(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const path = outline.companionPath
  if (!outline.dirty || !path) return
  if (isEffectivelyEmpty(outline.tree)) { outline.dirty = false; return }  // don't write phantom companion
  const text = serializeOutline(outline.tree, new Set([...persistIdsFor(outline.tree), ...pinnedIds]))
  // ...unchanged below...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/outline/store.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/store.svelte.ts src/lib/outline/store.test.ts
git commit -m "feat(outline): skip writing companion file for effectively-empty outline"
```

---

### Task 2: i18n keys for the two placeholder states

**Files:**
- Modify: `src/lib/i18n/en.ts:321` (after `outline.empty`)
- Modify: `src/lib/i18n/zh.ts:316` (after `outline.empty`)
- Modify: `src/lib/i18n/ja.ts:316` (after `outline.empty`)

- [ ] **Step 1: Add the English keys**

In `src/lib/i18n/en.ts`, directly after the `'outline.empty': 'No outline yet',` line add:

```typescript
  'outline.noDocument': 'Open a Markdown file to see its outline',
  'outline.notApplicable': 'This file has no outline',
```

- [ ] **Step 2: Add the Chinese keys**

In `src/lib/i18n/zh.ts`, directly after the `'outline.empty': '暂无大纲',` line add:

```typescript
  'outline.noDocument': '打开一个 Markdown 文件以查看大纲',
  'outline.notApplicable': '此文件无大纲',
```

- [ ] **Step 3: Add the Japanese keys**

In `src/lib/i18n/ja.ts`, directly after the `'outline.empty': 'アウトラインはまだありません',` line add:

```typescript
  'outline.noDocument': 'Markdown ファイルを開くとアウトラインが表示されます',
  'outline.notApplicable': 'このファイルにアウトラインはありません',
```

- [ ] **Step 4: Type-check**

Run: `pnpm check`
Expected: no new errors relating to i18n keys.

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/ja.ts
git commit -m "i18n(outline): add noDocument / notApplicable placeholder strings"
```

---

### Task 3: Promote OutlinePanel to a workspace-level column (App.svelte)

**Files:**
- Modify: `src/App.svelte:663-676` (the `.pane` section)

- [ ] **Step 1: Move the panel out of `{#if current}` and relax the gate**

Replace the current block (lines ~663–672) — which reads:

```svelte
    {#if current}
      {#if tabs.length === 1 && platformName !== 'ios'}
        <div class="float-toggle"><ModeToggle tab={current} /></div>
      {/if}
      <EditorPane tab={current} />
      {#if platformName !== 'ios' && outlineGate.enabled && outlineGate.visible && current && outlineAppliesTo(current)}
        {#await import('./components/outline/OutlinePanel.svelte') then Panel}
          <Panel.default tab={current} />
        {/await}
      {/if}
    {:else}
      <EmptyState />
    {/if}
```

with:

```svelte
    {#if current}
      {#if tabs.length === 1 && platformName !== 'ios'}
        <div class="float-toggle"><ModeToggle tab={current} /></div>
      {/if}
      <EditorPane tab={current} />
    {:else}
      <EmptyState />
    {/if}
    {#if platformName !== 'ios' && outlineGate.enabled && outlineGate.visible}
      {#await import('./components/outline/OutlinePanel.svelte') then Panel}
        <Panel.default tab={current ?? null} />
      {/await}
    {/if}
```

- [ ] **Step 2: Remove the now-unused `outlineAppliesTo` import**

In `src/App.svelte:49`, change:

```typescript
  import { outlineGate, loadOutlineGate, setOutlineVisible, outlineAppliesTo } from './lib/outline/gate.svelte'
```

to:

```typescript
  import { outlineGate, loadOutlineGate, setOutlineVisible } from './lib/outline/gate.svelte'
```

(`outlineAppliesTo` moves into the panel in Task 4.)

- [ ] **Step 3: Type-check**

Run: `pnpm check`
Expected: an error in `OutlinePanel.svelte` about `tab` possibly `null` is EXPECTED here (fixed in Task 4). No error should remain in `App.svelte` itself. If `App.svelte` still errors on `outlineAppliesTo`, ensure Step 2 was applied.

- [ ] **Step 4: Commit**

```bash
git add src/App.svelte
git commit -m "feat(outline): render outline panel as a workspace-level column"
```

---

### Task 4: OutlinePanel — nullable tab, three-state body, store lifecycle

**Files:**
- Modify: `src/components/outline/OutlinePanel.svelte`

- [ ] **Step 1: Import `outlineAppliesTo` and accept a nullable tab**

At the top of the `<script>`, add `outlineAppliesTo` to the gate import:

```typescript
  import { outlineGate, outlineShortcuts, setOutlineWidth, setOutlineWidthLive, setOutlineVisible, outlineAppliesTo } from '../../lib/outline/gate.svelte'
```

Change the props declaration (line ~23) from:

```typescript
  let { tab }: { tab: Tab } = $props()
```

to:

```typescript
  let { tab }: { tab: Tab | null } = $props()

  // Whether the current tab has an editable outline. Drives body state + button enablement.
  let applicable = $derived(tab != null && outlineAppliesTo(tab))
```

- [ ] **Step 2: Guard the store-driving effects on `applicable`**

Replace the four effects at lines ~29–37:

```typescript
  $effect(() => {
    if (tab.filePath) void attachTab(tab.filePath, tab.currentContent)
  })
  $effect(() => {
    const content = tab.currentContent
    if (outline.mainPath === tab.filePath) scheduleSyncFromMain(content)
  })
  $effect(() => () => { void flushSave(); detach(); teardownIndex() })  // unmount 兜底保存
  $effect(() => { if (outlineGate.visible && tab.filePath) void ensureIndex(tab.filePath) })
```

with:

```typescript
  $effect(() => {
    if (applicable && tab) void attachTab(tab.filePath, tab.currentContent)
    else { void flushSave(); detach(); teardownIndex() }
  })
  $effect(() => {
    if (!applicable || !tab) return
    const content = tab.currentContent
    if (outline.mainPath === tab.filePath) scheduleSyncFromMain(content)
  })
  $effect(() => () => { void flushSave(); detach(); teardownIndex() })  // unmount 兜底保存
  $effect(() => { if (applicable && outlineGate.visible && tab) void ensureIndex(tab.filePath) })
```

- [ ] **Step 3: Guard `onRegenerate` against a null tab**

Replace `onRegenerate` (line ~91):

```typescript
  async function onRegenerate() {
    if (!tab) return
    const { confirm } = await import('@tauri-apps/plugin-dialog')
    if (await confirm(t('outline.regenerateConfirm'), { title: t('outline.regenerate') })) {
      regenerate(tab.currentContent)
    }
  }
```

- [ ] **Step 4: Render the three-state body**

Replace the body block (lines ~260–270):

```svelte
  <div class="body" role="tree">
    {#each visibleRoots as node (node.id)}
      <OutlineNode {node} depth={0} {resolved} {onJump} {onPageClick} {onEditorInput} {onContextMenu} {onDragOp} {visibleIds} />
    {/each}
    {#if visibleRoots.length === 0}
      <p class="empty">{visibleIds ? t('outline.noSearchResults') : t('outline.empty')}</p>
    {/if}
  </div>
  {#if !visibleIds}
    <BacklinksSection />
  {/if}
```

with:

```svelte
  {#if !applicable}
    <div class="body">
      <p class="empty">{tab == null ? t('outline.noDocument') : t('outline.notApplicable')}</p>
    </div>
  {:else}
    <div class="body" role="tree">
      {#each visibleRoots as node (node.id)}
        <OutlineNode {node} depth={0} {resolved} {onJump} {onPageClick} {onEditorInput} {onContextMenu} {onDragOp} {visibleIds} />
      {/each}
      {#if visibleRoots.length === 0}
        <p class="empty">{visibleIds ? t('outline.noSearchResults') : t('outline.empty')}</p>
      {/if}
    </div>
    {#if !visibleIds}
      <BacklinksSection />
    {/if}
  {/if}
```

- [ ] **Step 5: Disable search / regenerate when not applicable**

In the header (lines ~235–241), add `disabled={!applicable}` to the search and regenerate buttons. The header becomes:

```svelte
  <header>
    <button class="hbtn" title={t('outline.hide')} onclick={() => void setOutlineVisible(false)}>«</button>
    <span class="title">{t('outline.title')}</span>
    <button class="hbtn" class:active={searchOpen} title={t('outline.search')} disabled={!applicable} onclick={toggleSearch}>⌕</button>
    <button class="hbtn" title={t('outline.regenerate')} disabled={!applicable} onclick={onRegenerate}>⟳</button>
    <button class="hbtn" title={t('outline.addNote')} onclick={addRootNote}>＋</button>
  </header>
```

(The `＋` button is removed in Task 6 — leave it for now so this task compiles cleanly.)

Add a `:disabled` rule to the `.hbtn` style block (append inside `<style>`, next to the existing `.hbtn` rules):

```css
  .hbtn:disabled { opacity: 0.25; cursor: default; }
```

- [ ] **Step 6: Type-check**

Run: `pnpm check`
Expected: no errors in `OutlinePanel.svelte` or `App.svelte`.

- [ ] **Step 7: Commit**

```bash
git add src/components/outline/OutlinePanel.svelte
git commit -m "feat(outline): nullable tab with three-state body and guarded lifecycle"
```

---

### Task 5: OutlinePanel — remove `+`, default-editable empty state, blank-area click

**Files:**
- Modify: `src/components/outline/OutlinePanel.svelte`

- [ ] **Step 1: Make `addRootNote` reusable and non-dirtying for the empty placeholder**

Replace `addRootNote` (lines ~81–90) with a version that does NOT mark the tree dirty when it creates an empty node (so merely focusing an empty placeholder never writes a file — Task 1's guard also protects this, but not dirtying avoids a pointless 800ms save cycle):

```typescript
  function addRootNote() {
    const last = roots[roots.length - 1]
    const node: NodeT = {
      id: newId(), parentId: null, order: calculateOrderBetween(last ? last.order : null, null),
      content: '', collapsed: false, source: 'manual',
    }
    outline.tree.nodes.set(node.id, node)
    outline.editingId = node.id
    bump()   // no markDirty(): an empty node alone must not trigger a save
  }
```

- [ ] **Step 2: Auto-provide an editable starting node when the outline is empty**

Add this effect after the existing effects (e.g. after the `$effect(() => { if (menu.kind !== 'none' ...})` block around line ~43). It creates exactly one empty root node when an applicable outline has no nodes and nothing is being edited:

```typescript
  // Default-editable: an applicable but empty outline gets one ready-to-type
  // root node (no + button needed). Guarded so it fires once, not on every bump.
  $effect(() => {
    void outline.version
    if (!applicable) return
    if (outline.tree.nodes.size === 0 && outline.editingId == null) addRootNote()
  })
```

- [ ] **Step 3: Create a node when the blank area below the list is clicked**

Add a handler in the `<script>`:

```typescript
  // Click in the empty region below the last node → new trailing root node.
  function onBodyClick(e: MouseEvent) {
    if (!applicable) return
    const target = e.target as HTMLElement
    if (target.closest('.node')) return   // clicks on existing rows handled by the node
    addRootNote()
  }
```

- [ ] **Step 4: Wire the handler and remove the `＋` button**

In the applicable branch of the body (from Task 4), add `onclick={onBodyClick}` to the tree `div`:

```svelte
    <div class="body" role="tree" onclick={onBodyClick}>
```

In the header, delete the add-note button line entirely:

```svelte
    <button class="hbtn" title={t('outline.addNote')} onclick={addRootNote}>＋</button>
```

- [ ] **Step 5: Type-check**

Run: `pnpm check`
Expected: no errors. (Svelte may warn about a click handler on a non-interactive `div`; if `pnpm check` treats it as an error, add `role="tree"` is already present — keep it. Silence a11y warning with `<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->` immediately above the `<div class="body" role="tree" ...>` line.)

- [ ] **Step 6: Commit**

```bash
git add src/components/outline/OutlinePanel.svelte
git commit -m "feat(outline): default-editable empty state, click-to-add, remove + button"
```

---

### Task 6: Theme-driven typography (probe + CSS variables)

**Files:**
- Modify: `src/components/outline/OutlinePanel.svelte` (probe + vars)
- Modify: `src/components/outline/OutlineNode.svelte` (consume vars)

- [ ] **Step 1: Import the active theme id in the panel**

Add to the panel `<script>` imports:

```typescript
  import { activeTheme } from '../../lib/active-theme.svelte'
```

Add reactive state + derived id:

```typescript
  let activeThemeId = $derived(activeTheme.id)
  let probeEl = $state<HTMLDivElement>()
  let typo = $state({ family: '', size: '', line: '' })
```

- [ ] **Step 2: Measure theme typography from an offscreen probe**

Add this effect (after the other effects):

```typescript
  // Read the theme's base body typography (font-family/size/line-height, which
  // live on `.moraya-editor` under `[data-theme=<id>]`) and expose as CSS vars.
  // rAF waits for the theme slot CSS to apply after an id change.
  $effect(() => {
    void activeThemeId
    const probe = probeEl?.querySelector('.moraya-editor') as HTMLElement | null
    if (!probe) return
    const raf = requestAnimationFrame(() => {
      const cs = getComputedStyle(probe)
      typo = { family: cs.fontFamily, size: cs.fontSize, line: cs.lineHeight }
    })
    return () => cancelAnimationFrame(raf)
  })
```

- [ ] **Step 3: Render the probe and push vars onto the panel root**

Change the `<aside>` opening tag (line ~228) to add the CSS variables via `style`:

```svelte
<aside
  class="outline-panel"
  style="width: {outlineGate.width}px; --outline-font-family: {typo.family}; --outline-font-size: {typo.size}; --outline-line-height: {typo.line};"
>
  <div class="typo-probe" data-theme={activeThemeId} aria-hidden="true" bind:this={probeEl}>
    <div class="moraya-editor"></div>
  </div>
```

Add the probe style rule inside the panel `<style>`:

```css
  .typo-probe {
    position: absolute;
    left: -9999px; top: 0;
    width: 0; height: 0;
    visibility: hidden;
    pointer-events: none;
  }
```

Also set the body to inherit the family (append to the existing `.body` rule):

```css
  .body { flex: 1; overflow-y: auto; padding: 8px; font-family: var(--outline-font-family); }
```

- [ ] **Step 4: Consume the variables in the node row**

In `src/components/outline/OutlineNode.svelte`, change the `.row` rule (line ~183) from:

```css
  .row {
    display: flex; align-items: flex-start; gap: 4px;
    padding: 1px 4px 1px calc(var(--depth) * 16px + 4px);
    border-radius: 4px; font-size: 13px; line-height: 1.5;
  }
```

to:

```css
  .row {
    display: flex; align-items: flex-start; gap: 4px;
    padding: 1px 4px 1px calc(var(--depth) * 16px + 4px);
    border-radius: 4px;
    font-family: var(--outline-font-family);
    font-size: var(--outline-font-size, 13px);
    line-height: var(--outline-line-height, 1.5);
  }
```

(The fallbacks keep the row sane before the probe measures / if a var is empty.)

- [ ] **Step 5: Type-check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/outline/OutlinePanel.svelte src/components/outline/OutlineNode.svelte
git commit -m "feat(outline): follow active theme typography via probe-derived CSS vars"
```

---

### Task 7: Folder-View-style SVG toolbar icons

Replace the glyph buttons (`«`, `⌕`, `⟳`, and the search-clear `✕`) with stroke SVGs matching `FolderView.svelte`'s `.hbtn` visual language.

**Files:**
- Modify: `src/components/outline/OutlinePanel.svelte`

- [ ] **Step 1: Replace the header buttons with SVG icons**

Replace the `<header>` (as left by Task 5 — hide / title / search / regenerate) with:

```svelte
  <header>
    <button class="hbtn" title={t('outline.hide')} aria-label={t('outline.hide')} onclick={() => void setOutlineVisible(false)}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="15" y1="3" x2="15" y2="21" />
        <polyline points="8 9 11 12 8 15" />
      </svg>
    </button>
    <span class="title">{t('outline.title')}</span>
    <button class="hbtn" class:on={searchOpen} title={t('outline.search')} aria-label={t('outline.search')} disabled={!applicable} onclick={toggleSearch}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    </button>
    <button class="hbtn" title={t('outline.regenerate')} aria-label={t('outline.regenerate')} disabled={!applicable} onclick={onRegenerate}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    </button>
  </header>
```

(The hide icon is Folder View's panel-collapse mirrored to point right; the search and regenerate SVGs are copied verbatim from `FolderView.svelte`.)

- [ ] **Step 2: Replace the search-clear glyph with the stroke ✕**

In the search row (lines ~242–255), replace the clear button:

```svelte
      {#if searchQuery}
        <button class="hbtn" title={t('common.close')} aria-label={t('common.close')} onclick={() => (searchQuery = '')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      {/if}
```

- [ ] **Step 3: Align `.hbtn` styling with Folder View**

Replace the `.hbtn` style rules (lines ~308–313) with the Folder-View-aligned version:

```css
  .hbtn {
    display: inline-flex; align-items: center; justify-content: center;
    border: 0; background: transparent; cursor: pointer;
    padding: 3px; border-radius: 4px; opacity: 0.7;
  }
  .hbtn svg { display: block; }
  .hbtn:hover:not(:disabled) { background: rgba(0,0,0,0.08); opacity: 1; }
  .hbtn:disabled { opacity: 0.25; cursor: default; }
  .hbtn.on { background: rgba(0,0,0,0.1); opacity: 1; }
```

Add a dark-mode block at the end of the `<style>` (matching Folder View):

```css
  @media (prefers-color-scheme: dark) {
    .hbtn:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
    .hbtn.on { background: rgba(255,255,255,0.15); }
  }
```

Remove the now-unused `.hbtn.active` rule (line ~313) if present — the search toggle now uses `.on`.

- [ ] **Step 4: Type-check**

Run: `pnpm check`
Expected: no errors, no unused-selector warnings for `.hbtn.active`.

- [ ] **Step 5: Commit**

```bash
git add src/components/outline/OutlinePanel.svelte
git commit -m "style(outline): Folder-View-style SVG toolbar icons"
```

---

### Task 8: Full verification

- [ ] **Step 1: Run the whole unit suite**

Run: `pnpm test`
Expected: PASS (including the new `isEffectivelyEmpty` tests).

- [ ] **Step 2: Type-check the whole project**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 3: Manual verification (run the app)**

Enable the Outline plugin, then confirm each spec acceptance item:
- No document open → right column persists, shows "Open a Markdown file…"; open a `.md` → outline appears; switch to a `.notes.md` tab → shows "This file has no outline".
- Switch theme / toggle light-dark → outline font family, size, line-height change accordingly.
- Open a heading-less doc with the panel visible → a ready-to-type node is present; type nothing → no `.notes.md` is created on disk; type content → `.notes.md` appears.
- Click blank area below the list → new node in edit mode; `Enter` → sibling; `Tab` → child; `Shift+Tab` → outdent.
- Toolbar icons visually match Folder View (hide / search / regenerate) in both light and dark.

- [ ] **Step 4: Commit any manual-verification fixups** (only if changes were needed)

```bash
git add -A
git commit -m "fix(outline): address manual-verification findings"
```
