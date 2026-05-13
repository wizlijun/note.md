# Image Resize Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user clicks an image in rich mode, show a floating toolbar above it with 25% / 50% / 75% / 100% / 原始 resize buttons; selecting a size writes `width=XX%` into the image's `title` attribute, which `@moraya/core`'s schema already uses to apply `img.style.width`.

**Architecture:** A new `ImageToolbar.svelte` component renders as a fixed-position overlay (backdrop + toolbar div). `RichEditor.svelte` adds a `click` listener on the `.ProseMirror` element that detects `<img>` targets, resolves the ProseMirror node position, and toggles the toolbar state. On resize, `view.state.tr.setNodeMarkup` updates the node's `title` attribute. The markdown round-trip is `![alt](src "width=50%")` — already handled by `@moraya/core`.

**Tech Stack:** Svelte 5, ProseMirror (via `@moraya/core`), CSS system colors

---

## File Map

| Status | Path | Responsibility |
|--------|------|---------------|
| Create | `src/lib/image-toolbar/ImageToolbar.svelte` | Floating size picker UI |
| Modify | `src/components/RichEditor.svelte` | Click detection, toolbar state, resize dispatch |

---

## Task 1: ImageToolbar.svelte

**Files:**
- Create: `src/lib/image-toolbar/ImageToolbar.svelte`

No unit tests — pure UI component, covered by manual test in Task 2.

- [ ] **Step 1: Create the directory and file**

```bash
mkdir -p /Users/bruce/git/mdeditor/src/lib/image-toolbar
```

- [ ] **Step 2: Write the component**

Create `src/lib/image-toolbar/ImageToolbar.svelte`:

```svelte
<script lang="ts">
  let {
    position,
    currentWidth,
    onResize,
    onClose,
  }: {
    position: { top: number; left: number }
    currentWidth: string
    onResize: (width: string) => void
    onClose: () => void
  } = $props()

  const sizeOptions = [
    { label: '25%',  value: '25%'  },
    { label: '50%',  value: '50%'  },
    { label: '75%',  value: '75%'  },
    { label: '100%', value: '100%' },
    { label: '原始', value: ''     },
  ]
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="toolbar-backdrop" onclick={onClose}>
  <div
    class="image-toolbar"
    style="top: {position.top}px; left: {position.left}px"
    onclick={(e) => e.stopPropagation()}
  >
    {#each sizeOptions as opt}
      <button
        class="size-btn"
        class:active={currentWidth === opt.value}
        onclick={() => onResize(opt.value)}
        title={opt.value || '原始大小'}
      >
        {opt.label}
      </button>
    {/each}
  </div>
</div>

<style>
  .toolbar-backdrop {
    position: fixed;
    inset: 0;
    z-index: 55;
  }

  .image-toolbar {
    position: fixed;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    background: Canvas;
    border: 1px solid color-mix(in srgb, CanvasText 20%, Canvas);
    border-radius: 6px;
    box-shadow: 0 2px 8px color-mix(in srgb, CanvasText 15%, transparent);
    z-index: 56;
    transform: translateX(-50%);
  }

  .size-btn {
    padding: 3px 8px;
    border: none;
    background: transparent;
    color: color-mix(in srgb, CanvasText 65%, Canvas);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 4px;
    white-space: nowrap;
    transition: background 0.1s, color 0.1s;
  }

  .size-btn:hover {
    background: color-mix(in srgb, CanvasText 8%, Canvas);
    color: CanvasText;
  }

  .size-btn.active {
    background: AccentColor;
    color: white;
  }
</style>
```

- [ ] **Step 3: TypeScript check**

```bash
cd /Users/bruce/git/mdeditor && npm run check 2>&1 | grep "error" | head -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/image-toolbar/ImageToolbar.svelte
git commit -m "feat: add ImageToolbar component for image resize"
```

---

## Task 2: Wire ImageToolbar into RichEditor.svelte

**Files:**
- Modify: `src/components/RichEditor.svelte`

- [ ] **Step 1: Add imports and state variables**

In `RichEditor.svelte`, add the import after existing imports:

```ts
import ImageToolbar from '../lib/image-toolbar/ImageToolbar.svelte'
```

Add these state variables after the `let _dropHandler` declaration:

```ts
let showImageToolbar = $state(false)
let imageToolbarPosition = $state({ top: 0, left: 0 })
let imageToolbarCurrentWidth = $state('')
let imageToolbarTargetPos = $state<number | null>(null)
```

- [ ] **Step 2: Add handleImageClick and handleToolbarResize functions**

Add after the `setupDragDrop` function:

```ts
function handleImageClick(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (target.tagName !== 'IMG') {
    showImageToolbar = false
    return
  }

  const imgEl = target as HTMLImageElement
  const rect = imgEl.getBoundingClientRect()
  imageToolbarPosition = {
    top:  rect.top - 36,
    left: rect.left + rect.width / 2,
  }

  // Read current width from title attr (stored as "width=50%")
  const titleAttr = imgEl.getAttribute('title') || ''
  const widthMatch = titleAttr.match(/^width=(\d+%?)$/)
  imageToolbarCurrentWidth = widthMatch ? widthMatch[1] : ''

  // Resolve ProseMirror node position
  if (editor) {
    try {
      const view = editor.view as unknown as import('prosemirror-view').EditorView
      const pos = view.posAtDOM(imgEl, 0)
      imageToolbarTargetPos = pos
    } catch {
      imageToolbarTargetPos = null
    }
  }

  showImageToolbar = true
}

function handleToolbarResize(width: string) {
  if (!editor || imageToolbarTargetPos === null) return
  try {
    const view = editor.view as unknown as import('prosemirror-view').EditorView
    const pos = imageToolbarTargetPos!
    const node = view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== 'image') return
    const title = width ? `width=${width}` : ''
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, title }))
  } catch { /* ignore */ }
  imageToolbarCurrentWidth = width
}
```

- [ ] **Step 3: Register click listener in onMount**

In the `onMount` async IIFE, after the line `_pmEl?.addEventListener('paste', handlePaste as EventListener, true)`, add:

```ts
_pmEl?.addEventListener('click', handleImageClick as EventListener)
```

- [ ] **Step 4: Remove click listener in onDestroy**

In `onDestroy`, after `_pmEl?.removeEventListener('paste', handlePaste as EventListener, true)`, add:

```ts
_pmEl?.removeEventListener('click', handleImageClick as EventListener)
```

- [ ] **Step 5: Render the toolbar in the template**

In `RichEditor.svelte`'s HTML section, locate the outermost `<div class="rich-wrap">` and add the toolbar block as the last child, just before the closing `</div>`:

```svelte
<div class="rich-wrap">
  <!-- ... existing content ... -->
  {#if showImageToolbar}
    <ImageToolbar
      position={imageToolbarPosition}
      currentWidth={imageToolbarCurrentWidth}
      onResize={handleToolbarResize}
      onClose={() => { showImageToolbar = false }}
    />
  {/if}
</div>
```

The toolbar uses `position: fixed` so DOM placement inside `.rich-wrap` doesn't affect visual position.

- [ ] **Step 6: TypeScript check and tests**

```bash
cd /Users/bruce/git/mdeditor && npm run check 2>&1 | grep "error" | head -10
```

```bash
cd /Users/bruce/git/mdeditor && npm test 2>&1 | tail -5
```

Expected: no TS errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/components/RichEditor.svelte
git commit -m "feat: image click toolbar for resize in rich mode"
```

---

## Manual Integration Test

After running the dev app (`npm run tauri dev`):

- [ ] Open a `.md` file in rich mode that contains at least one image
- [ ] **Click the image** → toolbar appears above it with 25% / 50% / 75% / 100% / 原始 buttons
- [ ] **Click 50%** → image shrinks to 50% width; button turns highlighted; switch to source mode and verify title contains `"width=50%"` e.g. `![](img.png "width=50%")`
- [ ] **Click 原始** → image returns to natural size; source mode shows no title attribute
- [ ] **Click elsewhere in editor** → toolbar disappears
- [ ] **Click image again** → toolbar reappears with correct button highlighted for current width
- [ ] Paste a new screenshot → click it → toolbar works on the newly inserted image
