# Rich Editor Skins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a skin (theme) mechanism to the rich-text editor and ship one new "shuyuan" skin tuned for Chinese typography (思源宋体 body, 思源黑体/苹方 headings, first-line indent, book-style blockquote, horizontal-only tables), alongside the existing default look.

**Architecture:** CSS-only switching via `[data-skin]` attribute on the `.moraya-editor` host. Existing `src/styles/app.css` is split into three files: `editor-base.css` (structural editor styles that never change with skin — code blocks, hljs tokens, mermaid, language picker, KaTeX), and per-skin `skins/<id>.css` files (typography, headings, blockquote, lists, tables, hr). A new `src/lib/skin.svelte.ts` module owns the skin registry and reactive `current` state; `settings.svelte.ts` persists the choice to the Tauri store; `RichEditor.svelte` binds `data-skin={skin.current}` on its host div; `SettingsDialog.svelte` Core tab adds a dropdown.

**Tech Stack:** Svelte 5 (runes: `$state`, `$derived`, `$props`), TypeScript, Vitest with happy-dom, Tauri Store plugin (mocked in tests), CSS custom properties + `[data-skin]` attribute selectors.

**Spec:** `docs/superpowers/specs/2026-05-09-rich-editor-skins-design.md`

---

## File Structure

**Files created:**

- `src/lib/skin.svelte.ts` — Skin registry (`SKINS` constant), reactive `skin` state, `setSkin(id)`, `isValidSkinId(id)` validator.
- `src/lib/skin.test.ts` — Unit tests for the above.
- `src/styles/editor-base.css` — Structural editor styles extracted from `app.css`: code-block NodeView wrapper, language picker popover, mermaid preview, hljs token colors (light + dark), `.renderer-preview`. Skin-agnostic.
- `src/styles/skins/default.css` — Current typography extracted from `app.css`: headings, paragraphs, blockquote, lists, tables, inline code, links, hr. Selectors use `.moraya-editor[data-skin="default"]`.
- `src/styles/skins/shuyuan.css` — New Chinese book skin. Selectors use `.moraya-editor[data-skin="shuyuan"]`.

**Files modified:**

- `src/lib/settings.svelte.ts` — Add `skin: SkinId` to the load/save round-trip; default `'default'`; validate against `isValidSkinId` on load.
- `src/lib/settings.test.ts` — Add tests for skin load/save + invalid-id fallback.
- `src/components/RichEditor.svelte` — Bind `data-skin={skin.current}` reactively to the host div.
- `src/components/SettingsDialog.svelte` — Add skin dropdown to the Core tab, above the auto-save row.
- `src/App.svelte` — After `loadSettings()`, hydrate `skin.current` from settings; add CSS imports for the three new files.
- `src/styles/app.css` — Remove the moved-out styles, keeping only the global `:root`, `html/body/#app` reset.
- `README.md` — Append three smoke-test items (skin switch, skin persistence, skin + dark mode).

---

## Task 1: Add `skin` field to settings persistence

**Files:**
- Modify: `src/lib/settings.svelte.ts`
- Test: `src/lib/settings.test.ts`

This task adds a string field to settings that round-trips through the Tauri store. We do this *before* creating the skin module so the module can import the validator from one place — but the field starts as just `string` here; we'll narrow it to `SkinId` in Task 2.

- [ ] **Step 1: Write the failing tests**

Append these test cases to `src/lib/settings.test.ts` inside the existing `describe('settings', ...)` block (after the existing `setRecentMode` test):

```ts
  it('loadSettings hydrates skin from store, defaults to "default"', async () => {
    const { loadSettings, settings } = await import('./settings.svelte')
    mockGet.mockImplementation(async (key: string) => key === 'skin' ? 'shuyuan' : undefined)
    await loadSettings()
    expect(settings.skin).toBe('shuyuan')
  })

  it('loadSettings falls back to "default" when stored skin is unknown', async () => {
    const { loadSettings, settings } = await import('./settings.svelte')
    mockGet.mockImplementation(async (key: string) => key === 'skin' ? 'no-such-skin' : undefined)
    await loadSettings()
    expect(settings.skin).toBe('default')
  })

  it('loadSettings defaults skin to "default" when store has no value', async () => {
    const { loadSettings, settings } = await import('./settings.svelte')
    mockGet.mockResolvedValue(undefined)
    await loadSettings()
    expect(settings.skin).toBe('default')
  })

  it('saveSettings writes skin under "skin" key', async () => {
    const { loadSettings, saveSettings, settings } = await import('./settings.svelte')
    await loadSettings()
    settings.skin = 'shuyuan'
    await saveSettings()
    const setCall = mockSet.mock.calls.find((args) => args[0] === 'skin')
    expect(setCall?.[1]).toBe('shuyuan')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- settings.test`
Expected: 4 new tests fail because `settings.skin` is undefined and `'skin'` key is not written.

- [ ] **Step 3: Implement skin field in settings.svelte.ts**

In `src/lib/settings.svelte.ts`:

Replace the `settings` state line (currently line 5):

```ts
export const settings = $state<{ autoSave: boolean }>({ autoSave: false })
```

with:

```ts
export const settings = $state<{ autoSave: boolean; skin: string }>({
  autoSave: false,
  skin: 'default',
})

const KNOWN_SKIN_IDS = new Set(['default', 'shuyuan'])
```

In `loadSettings()`, after the `settings.autoSave = ...` line, add:

```ts
  const storedSkin = await s.get<string>('skin')
  settings.skin = storedSkin && KNOWN_SKIN_IDS.has(storedSkin) ? storedSkin : 'default'
```

In `saveSettings()`, after `await s.set('autoSave', settings.autoSave)`, add:

```ts
  await s.set('skin', settings.skin)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- settings.test`
Expected: all settings tests pass (including the 4 new ones).

- [ ] **Step 5: Run full test suite + type check**

Run: `pnpm test && pnpm check`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/settings.svelte.ts src/lib/settings.test.ts
git commit -m "feat(settings): persist rich-editor skin choice"
```

---

## Task 2: Create skin module

**Files:**
- Create: `src/lib/skin.svelte.ts`
- Create: `src/lib/skin.test.ts`

A small reactive module that exposes the skin registry and current selection. Importing this module gives components a single source of truth for which skin is active.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/skin.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('skin module', () => {
  it('SKINS contains default and shuyuan', async () => {
    const { SKINS } = await import('./skin.svelte')
    const ids = SKINS.map((s) => s.id)
    expect(ids).toContain('default')
    expect(ids).toContain('shuyuan')
  })

  it('every skin entry has id, label, description', async () => {
    const { SKINS } = await import('./skin.svelte')
    for (const s of SKINS) {
      expect(typeof s.id).toBe('string')
      expect(typeof s.label).toBe('string')
      expect(typeof s.description).toBe('string')
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.description.length).toBeGreaterThan(0)
    }
  })

  it('skin.current defaults to "default"', async () => {
    const { skin } = await import('./skin.svelte')
    expect(skin.current).toBe('default')
  })

  it('setSkin updates skin.current', async () => {
    const { skin, setSkin } = await import('./skin.svelte')
    setSkin('shuyuan')
    expect(skin.current).toBe('shuyuan')
    setSkin('default')
    expect(skin.current).toBe('default')
  })

  it('isValidSkinId returns true for known ids, false otherwise', async () => {
    const { isValidSkinId } = await import('./skin.svelte')
    expect(isValidSkinId('default')).toBe(true)
    expect(isValidSkinId('shuyuan')).toBe(true)
    expect(isValidSkinId('nope')).toBe(false)
    expect(isValidSkinId('')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- skin.test`
Expected: all tests fail because `./skin.svelte` does not exist.

- [ ] **Step 3: Implement the skin module**

Create `src/lib/skin.svelte.ts`:

```ts
export type SkinId = 'default' | 'shuyuan'

export const SKINS: { id: SkinId; label: string; description: string }[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'GitHub-style sans-serif. Neutral and minimal.',
  },
  {
    id: 'shuyuan',
    label: '书苑（中文优化）',
    description: '思源宋体正文 + 思源黑体标题，仿现代中文书籍排版，含首行缩进与楷体引文。',
  },
]

const KNOWN_IDS = new Set<string>(SKINS.map((s) => s.id))

export function isValidSkinId(id: string): id is SkinId {
  return KNOWN_IDS.has(id)
}

export const skin = $state<{ current: SkinId }>({ current: 'default' })

export function setSkin(id: SkinId): void {
  skin.current = id
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- skin.test`
Expected: all 5 skin-module tests pass.

- [ ] **Step 5: Run type check**

Run: `pnpm check`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/skin.svelte.ts src/lib/skin.test.ts
git commit -m "feat(skin): add skin registry + reactive current state"
```

---

## Task 3: Hydrate skin module from settings on app boot

**Files:**
- Modify: `src/App.svelte`

After settings load, push `settings.skin` into the skin module's reactive state.

- [ ] **Step 1: Update App.svelte boot sequence**

In `src/App.svelte`, find the `loadSettings()` call inside the `onMount` IIFE (currently around line 45):

```ts
      try { await loadSettings() } catch (e) { console.warn('[App] loadSettings:', e) }
```

Add right after it:

```ts
      // Sync persisted skin into the reactive skin module so RichEditor's
      // [data-skin] binding picks it up before first mount.
      try {
        const { skin: skinState } = await import('./lib/skin.svelte')
        const { settings: s } = await import('./lib/settings.svelte')
        if (s.skin === 'default' || s.skin === 'shuyuan') skinState.current = s.skin
      } catch (e) { console.warn('[App] hydrate skin:', e) }
```

(We import lazily to keep this hydration self-contained; static imports already exist for `loadSettings`, but adding two more module-level imports for one boot-time call would clutter the import block. Lazy import is the local convention used elsewhere in this file.)

- [ ] **Step 2: Type check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 3: Manual smoke test**

Run: `pnpm tauri dev`. Open any markdown file. The app should look exactly as before (because `skin.current` is `'default'` and no skin CSS exists yet). Open Preferences → Core; the existing UI should be intact. No console errors.

- [ ] **Step 4: Commit**

```bash
git add src/App.svelte
git commit -m "feat(skin): hydrate skin state from settings on boot"
```

---

## Task 4: Refactor app.css into base + default-skin layers (no behavior change)

**Files:**
- Create: `src/styles/editor-base.css`
- Create: `src/styles/skins/default.css`
- Modify: `src/styles/app.css`
- Modify: `src/App.svelte`

This is a pure refactor: split the single `app.css` into three files. The `default` skin keeps the *exact* current look — no visual change. We do this *before* writing `shuyuan.css` so the diff for shuyuan is small and the refactor diff is reviewable on its own.

The split rules:

- **editor-base.css** owns: `.moraya-editor` outline reset, code-block NodeView wrapper (`.code-block-wrapper`, `.code-block-toolbar`, `.code-lang-label`, `.code-toolbar-right`, `.code-copy-btn`, `.mermaid-toggle-btn`, `.code-block-pre`, `pre`, `.code-block-code`, plain markdown `pre:not(.code-block-pre)`, `pre code`), language picker (`.code-lang-picker` and descendants — these are body-mounted), all hljs token colors (light + dark `@media`), mermaid preview (`.mermaid-preview`, `.mermaid-loading`, `.mermaid-spinner`, `@keyframes mermaid-spin`, `.mermaid-error`, `.mermaid-empty`), `.renderer-preview`.
- **skins/default.css** owns: typography (`.moraya-editor[data-skin="default"] { line-height }`), `h1`–`h6`, `p`, `a`, `blockquote`, `ul`, `ol`, `li`, `img`, `table`, `th`, `td`, `hr`, inline code (`:not(pre) > code`).
- **app.css** keeps: only the `:root` font-family/color-scheme block and the `html, body, #app` reset.

- [ ] **Step 1: Create editor-base.css**

Create `src/styles/editor-base.css` with the following exact content (extracted verbatim from current `app.css`):

```css
/* ── Editor base (skin-agnostic) ──────────────────────────────────────────── */

.moraya-editor {
  outline: none;
}

/* ── Code block (NodeView wrapper from @moraya/core code-block-view) ───── */

.moraya-editor .code-block-wrapper {
  position: relative;
  margin: 1em 0;
  padding-top: 1.4rem;
  background: color-mix(in srgb, CanvasText 5%, Canvas);
  border-radius: 6px;
}
.moraya-editor .code-block-wrapper.renderer-preview-mode,
.moraya-editor .code-block-wrapper.mermaid-preview-mode {
  background: transparent;
  padding-top: 0;
}
.moraya-editor .code-block-toolbar {
  position: absolute;
  top: 0; left: 0; right: 0;
  z-index: 5;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 10px;
  font-size: 11px;
  color: GrayText;
  user-select: none;
  border-radius: 6px 6px 0 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}
.moraya-editor .code-block-wrapper:hover .code-block-toolbar,
.moraya-editor .code-block-wrapper.ProseMirror-selectednode .code-block-toolbar,
.moraya-editor .code-block-wrapper.picker-open .code-block-toolbar {
  opacity: 1;
  pointer-events: auto;
}
.moraya-editor .code-lang-label {
  cursor: pointer;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11px;
}
.moraya-editor .code-lang-label:hover {
  background: color-mix(in srgb, CanvasText 12%, transparent);
}
.moraya-editor .code-toolbar-right {
  display: flex;
  align-items: center;
  gap: 2px;
}
.moraya-editor .code-copy-btn,
.moraya-editor .mermaid-toggle-btn {
  background: none;
  border: 0;
  cursor: pointer;
  color: GrayText;
  padding: 2px 5px;
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-family: inherit;
}
.moraya-editor .code-copy-btn:hover,
.moraya-editor .mermaid-toggle-btn:hover {
  background: color-mix(in srgb, CanvasText 12%, transparent);
  color: CanvasText;
}
.moraya-editor .code-copy-btn svg:last-child { display: none; }
.moraya-editor .code-copy-btn.copied svg:first-child { display: none; }
.moraya-editor .code-copy-btn.copied svg:last-child { display: block; }
.moraya-editor .code-block-pre,
.moraya-editor pre {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.9em;
  line-height: 1.6;
  padding: 0 1em 0.7em;
  margin: 0;
  overflow-x: auto;
  background: transparent;
  border-radius: 0;
}
.moraya-editor pre:not(.code-block-pre) {
  /* Plain markdown pre (no NodeView wrapper) */
  padding: 12px;
  background: color-mix(in srgb, CanvasText 5%, Canvas);
  border-radius: 6px;
}
.moraya-editor pre code,
.moraya-editor .code-block-code {
  background: none;
  padding: 0;
  border-radius: 0;
  color: inherit;
  font-family: inherit;
}

/* ── Language picker (mounted to body) ──────────────────────────────────── */

.code-lang-picker {
  z-index: 9999;
  background: Canvas;
  color: CanvasText;
  border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  width: 220px;
  max-height: 280px;
  display: flex;
  flex-direction: column;
  font-size: 12px;
}
.code-lang-search {
  padding: 6px;
  border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
}
.code-lang-search-input {
  width: 100%;
  border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
  border-radius: 4px;
  padding: 4px 6px;
  background: Canvas;
  color: CanvasText;
  outline: none;
  box-sizing: border-box;
  font-size: 12px;
}
.code-lang-list { overflow-y: auto; flex: 1; }
.code-lang-group-label {
  padding: 4px 8px;
  font-size: 10px;
  font-weight: 600;
  color: GrayText;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.code-lang-option,
.code-lang-suggestion {
  padding: 5px 8px;
  cursor: pointer;
}
.code-lang-option:hover,
.code-lang-suggestion:hover {
  background: color-mix(in srgb, CanvasText 8%, transparent);
}
.code-lang-option.selected { color: #0969da; font-weight: 500; }
.code-lang-divider {
  height: 1px;
  background: color-mix(in srgb, CanvasText 12%, transparent);
  margin: 2px 0;
}

/* ── HLJS syntax highlighting tokens ────────────────────────────────────── */

.moraya-editor pre .hljs-keyword,
.moraya-editor pre .hljs-selector-tag { color: #cf222e; }

.moraya-editor pre .hljs-string,
.moraya-editor pre .hljs-doctag,
.moraya-editor pre .hljs-template-tag,
.moraya-editor pre .hljs-template-variable { color: #0a3069; }

.moraya-editor pre .hljs-number,
.moraya-editor pre .hljs-literal,
.moraya-editor pre .hljs-symbol { color: #0550ae; }

.moraya-editor pre .hljs-comment,
.moraya-editor pre .hljs-quote { color: #6e7781; font-style: italic; }

.moraya-editor pre .hljs-title,
.moraya-editor pre .hljs-title.class_,
.moraya-editor pre .hljs-title.function_,
.moraya-editor pre .hljs-function { color: #8250df; }

.moraya-editor pre .hljs-variable,
.moraya-editor pre .hljs-variable.language_ { color: #953800; }

.moraya-editor pre .hljs-type,
.moraya-editor pre .hljs-class,
.moraya-editor pre .hljs-built_in { color: #953800; }

.moraya-editor pre .hljs-params { color: #24292f; }

.moraya-editor pre .hljs-meta,
.moraya-editor pre .hljs-meta .hljs-keyword { color: #116329; }

.moraya-editor pre .hljs-tag,
.moraya-editor pre .hljs-name { color: #116329; }

.moraya-editor pre .hljs-attr,
.moraya-editor pre .hljs-attribute,
.moraya-editor pre .hljs-property { color: #0550ae; }

.moraya-editor pre .hljs-selector-class,
.moraya-editor pre .hljs-selector-id,
.moraya-editor pre .hljs-selector-pseudo { color: #6639ba; }

.moraya-editor pre .hljs-operator,
.moraya-editor pre .hljs-punctuation { color: #24292f; }

.moraya-editor pre .hljs-regexp { color: #116329; }
.moraya-editor pre .hljs-section { color: #0550ae; font-weight: 600; }
.moraya-editor pre .hljs-bullet { color: #953800; }
.moraya-editor pre .hljs-link { color: #0969da; text-decoration: underline; }

.moraya-editor pre .hljs-addition { color: #116329; background: rgba(46, 160, 67, 0.15); }
.moraya-editor pre .hljs-deletion { color: #cf222e; background: rgba(248, 81, 73, 0.15); }

@media (prefers-color-scheme: dark) {
  .moraya-editor pre .hljs-keyword,
  .moraya-editor pre .hljs-selector-tag { color: #ff7b72; }
  .moraya-editor pre .hljs-string,
  .moraya-editor pre .hljs-doctag,
  .moraya-editor pre .hljs-template-tag,
  .moraya-editor pre .hljs-template-variable { color: #a5d6ff; }
  .moraya-editor pre .hljs-number,
  .moraya-editor pre .hljs-literal,
  .moraya-editor pre .hljs-symbol { color: #79c0ff; }
  .moraya-editor pre .hljs-comment,
  .moraya-editor pre .hljs-quote { color: #8b949e; }
  .moraya-editor pre .hljs-title,
  .moraya-editor pre .hljs-title.class_,
  .moraya-editor pre .hljs-title.function_,
  .moraya-editor pre .hljs-function { color: #d2a8ff; }
  .moraya-editor pre .hljs-variable,
  .moraya-editor pre .hljs-variable.language_,
  .moraya-editor pre .hljs-type,
  .moraya-editor pre .hljs-class,
  .moraya-editor pre .hljs-built_in { color: #ffa657; }
  .moraya-editor pre .hljs-params { color: #c9d1d9; }
  .moraya-editor pre .hljs-meta,
  .moraya-editor pre .hljs-tag,
  .moraya-editor pre .hljs-name,
  .moraya-editor pre .hljs-meta .hljs-keyword,
  .moraya-editor pre .hljs-regexp { color: #7ee787; }
  .moraya-editor pre .hljs-attr,
  .moraya-editor pre .hljs-attribute,
  .moraya-editor pre .hljs-property,
  .moraya-editor pre .hljs-section { color: #79c0ff; }
  .moraya-editor pre .hljs-selector-class,
  .moraya-editor pre .hljs-selector-id,
  .moraya-editor pre .hljs-selector-pseudo { color: #d2a8ff; }
  .moraya-editor pre .hljs-operator,
  .moraya-editor pre .hljs-punctuation { color: #c9d1d9; }
  .moraya-editor pre .hljs-bullet,
  .moraya-editor pre .hljs-link { color: #79c0ff; }
}

/* ── Mermaid preview ─────────────────────────────────────────────────────── */

.moraya-editor .mermaid-preview {
  padding: 12px;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 60px;
  cursor: pointer;
  background: color-mix(in srgb, CanvasText 3%, Canvas);
  border-radius: 6px;
}
.moraya-editor .mermaid-preview svg {
  max-width: 100%;
  height: auto;
}
.moraya-editor .mermaid-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: GrayText;
  font-size: 12px;
  padding: 12px;
}
.moraya-editor .mermaid-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid color-mix(in srgb, CanvasText 20%, transparent);
  border-top-color: #0969da;
  border-radius: 50%;
  animation: mermaid-spin 0.6s linear infinite;
}
@keyframes mermaid-spin { to { transform: rotate(360deg); } }
.moraya-editor .mermaid-error {
  color: #cf222e;
  font-size: 11px;
  font-family: ui-monospace, Menlo, monospace;
  padding: 6px 8px;
  background: rgba(207, 34, 46, 0.08);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}
.moraya-editor .mermaid-empty {
  color: GrayText;
  font-size: 12px;
  font-style: italic;
}

/* ── Renderer-plugin preview (WaveDrom/D2 — empty registry, mostly unused) ─ */

.moraya-editor .renderer-preview {
  padding: 12px;
  overflow: auto;
  background: color-mix(in srgb, CanvasText 3%, Canvas);
  border-radius: 6px;
}
.moraya-editor .renderer-preview svg { max-width: 100%; height: auto; }
```

- [ ] **Step 2: Create skins/default.css**

Create `src/styles/skins/default.css`:

```css
/* Default skin — current GitHub-ish typography. */

.moraya-editor[data-skin="default"] { line-height: 1.6; }

.moraya-editor[data-skin="default"] h1 { font-size: 2em;    font-weight: 700; margin: 1.2em 0 0.4em; }
.moraya-editor[data-skin="default"] h2 { font-size: 1.5em;  font-weight: 600; margin: 1.1em 0 0.4em; }
.moraya-editor[data-skin="default"] h3 { font-size: 1.25em; font-weight: 600; margin: 1em   0 0.3em; }
.moraya-editor[data-skin="default"] h4,
.moraya-editor[data-skin="default"] h5,
.moraya-editor[data-skin="default"] h6 { font-size: 1em; font-weight: 600; margin: 1em 0 0.3em; }

.moraya-editor[data-skin="default"] p { margin: 0.6em 0; }
.moraya-editor[data-skin="default"] a { color: #0969da; text-decoration: underline; }

.moraya-editor[data-skin="default"] blockquote {
  border-left: 3px solid color-mix(in srgb, CanvasText 30%, transparent);
  margin: 0.6em 0;
  padding: 0 12px;
  color: GrayText;
}

.moraya-editor[data-skin="default"] ul,
.moraya-editor[data-skin="default"] ol { padding-left: 1.6em; margin: 0.6em 0; }
.moraya-editor[data-skin="default"] li { margin: 0.2em 0; }

.moraya-editor[data-skin="default"] img { max-width: 100%; }

.moraya-editor[data-skin="default"] table { border-collapse: collapse; margin: 0.8em 0; }
.moraya-editor[data-skin="default"] th,
.moraya-editor[data-skin="default"] td {
  border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
  padding: 6px 10px;
}
.moraya-editor[data-skin="default"] hr {
  border: 0;
  border-top: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
  margin: 1em 0;
}

/* Inline code (not inside a pre). */
.moraya-editor[data-skin="default"] :not(pre) > code {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  padding: 1px 4px;
  background: color-mix(in srgb, CanvasText 8%, transparent);
  border-radius: 3px;
}
```

- [ ] **Step 3: Trim app.css to globals only**

Replace the entire content of `src/styles/app.css` with:

```css
:root {
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 14px;
  color-scheme: light dark;
}

html, body, #app {
  margin: 0;
  padding: 0;
  height: 100vh;
  overflow: hidden;
  background: Canvas;
  color: CanvasText;
}

/* Editor styles live in editor-base.css and skins/<id>.css. */
```

- [ ] **Step 4: Wire the new CSS into App.svelte**

In `src/App.svelte`, find the line:

```ts
  import './styles/app.css'
```

Replace it with:

```ts
  import './styles/app.css'
  import './styles/editor-base.css'
  import './styles/skins/default.css'
```

(skins/shuyuan.css will be added in Task 7.)

- [ ] **Step 5: Apply data-skin="default" temporarily for refactor verification**

In `src/components/RichEditor.svelte`, find the host div (currently line 84):

```svelte
  <div class="host" bind:this={host}></div>
```

Replace it with:

```svelte
  <div class="host" data-skin="default" bind:this={host}></div>
```

(In Task 5 we'll make this reactive. For now, hard-coding `"default"` is correct — it activates the new skin selectors.)

Note: `@moraya/core` mounts its content *inside* this host, so the actual `.moraya-editor` element will end up as a descendant. CSS selectors `.moraya-editor[data-skin="default"]` won't match because `[data-skin]` is on the parent, not on `.moraya-editor` itself. We need the attribute on the editor element. We address this by putting `data-skin` on the host div *and* using a selector that walks down: `[data-skin="default"] .moraya-editor`. Update the selectors:

Change all `src/styles/skins/default.css` selectors from `.moraya-editor[data-skin="default"]` to `[data-skin="default"] .moraya-editor`. For example:

```css
[data-skin="default"] .moraya-editor { line-height: 1.6; }
[data-skin="default"] .moraya-editor h1 { font-size: 2em; ... }
```

Apply this rename across the entire file. (We'll mirror this convention in shuyuan.css in Task 7.)

- [ ] **Step 6: Manual smoke test — appearance unchanged**

Run: `pnpm tauri dev`. Open a markdown document with H1/H2/H3, paragraphs, blockquote, ordered + unordered lists, inline code, code block, table, hr, mermaid block.

Compare visually to the previous main branch. Expected: identical look. Code blocks still highlighted, mermaid still renders, blockquote still has left border, headings same size/weight.

If anything looks off: check that `data-skin="default"` is on `.host`; check selector rewrite covered every rule.

- [ ] **Step 7: Type check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 8: Run full test suite**

Run: `pnpm test`
Expected: all tests still pass (no behavior change for tests; this is a CSS-only refactor).

- [ ] **Step 9: Commit**

```bash
git add src/styles/app.css src/styles/editor-base.css src/styles/skins/default.css \
        src/App.svelte src/components/RichEditor.svelte
git commit -m "refactor(css): split editor styles into base + skin layers"
```

---

## Task 5: Make `data-skin` reactive on the editor host

**Files:**
- Modify: `src/components/RichEditor.svelte`

Replace the hard-coded `"default"` from Task 4 with a reactive binding to `skin.current`.

- [ ] **Step 1: Import the skin module**

In `src/components/RichEditor.svelte`, add to the imports at the top of the `<script>` block (after the existing imports):

```ts
  import { skin } from '../lib/skin.svelte'
```

- [ ] **Step 2: Bind data-skin reactively**

Find the host div (modified in Task 4):

```svelte
  <div class="host" data-skin="default" bind:this={host}></div>
```

Replace with:

```svelte
  <div class="host" data-skin={skin.current} bind:this={host}></div>
```

- [ ] **Step 3: Manual smoke test — switch via DevTools**

Run: `pnpm tauri dev`. Open a markdown file. Open the WebKit devtools (Cmd+Opt+I). In the Console:

```js
// Currently the only way to flip skin (UI comes in Task 6):
document.querySelector('.host').dataset.skin
```

Expected: `'default'`.

Then in the Console:

```js
// Manually flip via the reactive store (won't persist, but verifies the selector works):
__svelte_skin_test = await import('/src/lib/skin.svelte')
__svelte_skin_test.setSkin('shuyuan')
```

Expected: `data-skin` on `.host` becomes `'shuyuan'` (verify by re-running `document.querySelector('.host').dataset.skin`). Visually nothing changes yet because `skins/shuyuan.css` doesn't exist; that's correct.

Set it back: `__svelte_skin_test.setSkin('default')` — visual look returns to current.

- [ ] **Step 4: Type check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/RichEditor.svelte
git commit -m "feat(skin): bind data-skin reactively on rich-editor host"
```

---

## Task 6: Skin dropdown in Preferences → Core

**Files:**
- Modify: `src/components/SettingsDialog.svelte`

Add a dropdown to the Core tab. On change: update `skin.current`, update `settings.skin`, persist.

- [ ] **Step 1: Update SettingsDialog imports + handler**

In `src/components/SettingsDialog.svelte`, find the existing imports near the top:

```ts
  import { settings, saveSettings, getPluginScopedAll, mergePluginScoped } from '../lib/settings.svelte'
```

Add below:

```ts
  import { SKINS, skin, setSkin, type SkinId, isValidSkinId } from '../lib/skin.svelte'
```

Find the `onToggle` function near the bottom of the script block:

```ts
  async function onToggle(e: Event) {
    settings.autoSave = (e.currentTarget as HTMLInputElement).checked
    await saveSettings()
  }
```

Add right after it:

```ts
  async function onSkinChange(e: Event) {
    const val = (e.currentTarget as HTMLSelectElement).value
    if (!isValidSkinId(val)) return
    setSkin(val)
    settings.skin = val
    await saveSettings()
  }

  function describeSkin(id: SkinId): string {
    return SKINS.find((s) => s.id === id)?.description ?? ''
  }
```

- [ ] **Step 2: Add dropdown to Core tab markup**

Find the Core tab block (currently around line 146, starts with `{:else if selectedTab === 'core'}`). Inside it, the first `<section class="block">` contains the auto-save row. Add a new section *before* it:

```svelte
        <section class="block">
          <label class="row">
            <span class="lbl">Skin</span>
            <select value={skin.current} onchange={onSkinChange}>
              {#each SKINS as s (s.id)}
                <option value={s.id}>{s.label}</option>
              {/each}
            </select>
          </label>
          <p class="desc">{describeSkin(skin.current)}</p>
        </section>
```

- [ ] **Step 3: Add styling for the new label/select pair**

Find the existing `<style>` block at the bottom. Add inside it (anywhere — order doesn't matter):

```css
  .row .lbl {
    width: 60px;
    flex-shrink: 0;
  }
  .row select {
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: Canvas;
    color: CanvasText;
    font-size: 13px;
    flex: 1;
    max-width: 240px;
  }
```

- [ ] **Step 4: Manual smoke test — UI flow**

Run: `pnpm tauri dev`. Open a markdown file. Open Preferences (Cmd+,) → Core. Verify:
1. "Skin" row appears with a dropdown showing "Default" and "书苑（中文优化）".
2. Description text updates when selection changes.
3. Selecting "书苑（中文优化）" — *visually nothing changes yet* (shuyuan.css doesn't exist), but `data-skin` on the editor host should become `shuyuan` (check via devtools).
4. Close dialog, reopen — selection is preserved (read from `settings.skin`).
5. Quit and relaunch the app — selection is still `shuyuan` (round-trip through Tauri Store).
6. Reset to "Default" before next task.

- [ ] **Step 5: Type check + tests**

Run: `pnpm check && pnpm test`
Expected: no errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsDialog.svelte
git commit -m "feat(skin): add Skin dropdown to Preferences"
```

---

## Task 7: Author the `shuyuan` skin

**Files:**
- Create: `src/styles/skins/shuyuan.css`
- Modify: `src/App.svelte`

This is the visible payoff. Create the skin file, register it via the existing CSS-import mechanism.

- [ ] **Step 1: Create skins/shuyuan.css**

Create `src/styles/skins/shuyuan.css`:

```css
/* shuyuan skin — modern Chinese book typography. */

[data-skin="shuyuan"] .moraya-editor {
  font-family:
    'Iowan Old Style', 'Charter', 'Georgia',
    'Noto Serif CJK SC', 'Source Han Serif SC',
    'Songti SC', 'STSong', serif;
  font-feature-settings: 'palt';
  letter-spacing: 0.01em;
  line-height: 1.85;
}

/* ── Headings (sans-serif against serif body for contrast) ─────────────── */

[data-skin="shuyuan"] .moraya-editor h1,
[data-skin="shuyuan"] .moraya-editor h2,
[data-skin="shuyuan"] .moraya-editor h3,
[data-skin="shuyuan"] .moraya-editor h4,
[data-skin="shuyuan"] .moraya-editor h5,
[data-skin="shuyuan"] .moraya-editor h6 {
  font-family:
    'PingFang SC', 'Noto Sans CJK SC', 'Source Han Sans SC',
    -apple-system, BlinkMacSystemFont, sans-serif;
  letter-spacing: 0;
}

[data-skin="shuyuan"] .moraya-editor h1 {
  font-size: 1.9em;
  font-weight: 700;
  text-align: center;
  margin: 1.4em 0 0.8em;
  padding: 0.4em 0;
  border-top: 1px solid color-mix(in srgb, CanvasText 35%, transparent);
  border-bottom: 1px solid color-mix(in srgb, CanvasText 35%, transparent);
}

[data-skin="shuyuan"] .moraya-editor h2 {
  font-size: 1.45em;
  font-weight: 600;
  margin: 1.4em 0 0.5em;
  padding-left: 0.6em;
  border-left: 3px solid AccentColor;
}

[data-skin="shuyuan"] .moraya-editor h3 {
  font-size: 1.18em;
  font-weight: 600;
  margin: 1.2em 0 0.4em;
  padding-bottom: 0.2em;
  border-bottom: 1px dashed color-mix(in srgb, CanvasText 25%, transparent);
}

[data-skin="shuyuan"] .moraya-editor h4 { font-size: 1em;    font-weight: 600; margin: 1em 0 0.3em; }
[data-skin="shuyuan"] .moraya-editor h5 { font-size: 0.95em; font-weight: 600; margin: 1em 0 0.3em; }
[data-skin="shuyuan"] .moraya-editor h6 { font-size: 0.9em;  font-weight: 600; margin: 1em 0 0.3em; color: GrayText; }

/* ── Paragraphs: CJK first-line indent ──────────────────────────────────── */

[data-skin="shuyuan"] .moraya-editor p {
  margin: 0.8em 0;
  text-indent: 2em;
}
[data-skin="shuyuan"] .moraya-editor li > p,
[data-skin="shuyuan"] .moraya-editor blockquote p {
  text-indent: 0;
}
[data-skin="shuyuan"] .moraya-editor p:first-child {
  text-indent: 0;
}

/* ── Links ──────────────────────────────────────────────────────────────── */

[data-skin="shuyuan"] .moraya-editor a {
  color: #0969da;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}

/* ── Blockquote: book-style epigraph in Kaiti (楷体) ─────────────────────── */

[data-skin="shuyuan"] .moraya-editor blockquote {
  border: 0;
  border-top: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
  border-bottom: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
  margin: 1.2em 1.5em;
  padding: 0.8em 1em;
  font-family: 'STKaiti', 'Kaiti SC', 'BiauKai',
               'Noto Serif CJK SC', serif;
  font-size: 0.95em;
  text-align: center;
  color: color-mix(in srgb, CanvasText 80%, transparent);
}

/* ── Lists: middle-dot bullets ──────────────────────────────────────────── */

[data-skin="shuyuan"] .moraya-editor ul {
  list-style: none;
  padding-left: 1.4em;
  margin: 0.8em 0;
}
[data-skin="shuyuan"] .moraya-editor ul > li {
  position: relative;
  margin: 0.25em 0;
}
[data-skin="shuyuan"] .moraya-editor ul > li::before {
  content: '·';
  position: absolute;
  left: -1em;
  color: color-mix(in srgb, CanvasText 60%, transparent);
}
[data-skin="shuyuan"] .moraya-editor ol {
  padding-left: 1.8em;
  margin: 0.8em 0;
}
[data-skin="shuyuan"] .moraya-editor ol > li {
  margin: 0.25em 0;
}

/* ── Tables: horizontal-only borders (Chinese book convention) ──────────── */

[data-skin="shuyuan"] .moraya-editor table {
  border-collapse: collapse;
  margin: 1em auto;
  border-top: 2px solid CanvasText;
  border-bottom: 2px solid CanvasText;
}
[data-skin="shuyuan"] .moraya-editor th {
  border: 0;
  border-bottom: 1px solid CanvasText;
  padding: 8px 12px;
  font-weight: 600;
  font-family:
    'PingFang SC', 'Noto Sans CJK SC', -apple-system, sans-serif;
}
[data-skin="shuyuan"] .moraya-editor td {
  border: 0;
  padding: 6px 12px;
}

/* ── Horizontal rule: three centered asterisks (book section break) ─────── */

[data-skin="shuyuan"] .moraya-editor hr {
  border: 0;
  margin: 1.6em 0;
  text-align: center;
  height: 1.2em;
  position: relative;
}
[data-skin="shuyuan"] .moraya-editor hr::before {
  content: '＊　＊　＊';
  color: color-mix(in srgb, CanvasText 50%, transparent);
  letter-spacing: 0.5em;
  position: absolute;
  left: 0;
  right: 0;
}

/* ── Images ─────────────────────────────────────────────────────────────── */

[data-skin="shuyuan"] .moraya-editor img { max-width: 100%; }

/* ── Inline code: slightly tighter, rounder ─────────────────────────────── */

[data-skin="shuyuan"] .moraya-editor :not(pre) > code {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.88em;
  padding: 1px 5px;
  background: color-mix(in srgb, CanvasText 6%, transparent);
  border-radius: 4px;
  letter-spacing: 0;
}
```

- [ ] **Step 2: Register shuyuan.css in App.svelte**

In `src/App.svelte`, find the CSS imports (added in Task 4):

```ts
  import './styles/app.css'
  import './styles/editor-base.css'
  import './styles/skins/default.css'
```

Add the shuyuan import:

```ts
  import './styles/app.css'
  import './styles/editor-base.css'
  import './styles/skins/default.css'
  import './styles/skins/shuyuan.css'
```

- [ ] **Step 3: Manual smoke test — visual review**

Run: `pnpm tauri dev`. Prepare a markdown file with mixed Chinese + English content covering every styled element:

```markdown
# 测试文档 Test Document

这是一段中文段落，用来测试首行缩进与中西文混排效果。This is a sentence in English, mixed in to verify the Western-first font fallback chain renders Latin letters in serif rather than CJK glyph fallback.

## 二级标题 Second Level

### 三级标题

正文段落继续。注意标点符号 "引号" 「书名号」 ——破折号 ……省略号 都应该按 CJK 排版收紧。

> 引用段落应使用楷体显示，居中，上下细线。
> The quote stays Kaiti-styled even with Latin in it.

- 第一项
- 第二项 with mixed English
- 第三项

1. 序号项一
2. 序号项二

`inline code` 内联代码应该保持较小字号。

```python
def hello(name: str) -> None:
    print(f"hi {name}")
```

| 列 A   | 列 B   |
|--------|--------|
| 数据 1 | 数据 2 |
| 数据 3 | 数据 4 |

---

分节后的内容。
```

Open the file. Open Preferences (Cmd+,) → Core → switch Skin to "书苑（中文优化）".

Verify:
1. **Body font** — Chinese characters render in 思源宋体 / Songti (a serif), Latin renders in Iowan Old Style / Charter (a Western serif), not the CJK font's poor Latin fallback.
2. **Headings** — H1 centered with horizontal rules above and below; H2 with left accent stripe; H3 with dashed underline; all headings in sans-serif (PingFang/思源黑).
3. **First-line indent** — every body paragraph indented 2 characters; first paragraph after a heading is *not* indented; paragraphs inside list items / blockquote are *not* indented.
4. **Blockquote** — no left border; horizontal rules above and below; centered; Kaiti font; lighter color.
5. **Bullets** — `·` middle-dot to the left of each item.
6. **Table** — only horizontal lines (top thick, header-bottom thin, bottom thick); no vertical lines.
7. **HR** — replaced with three spaced asterisks `＊　＊　＊` centered, no horizontal line.
8. **Code blocks** — *unchanged*: same hljs colors, same wrapper background, same toolbar. (This validates editor-base.css is doing its job.)
9. **Inline code** — slightly smaller, lighter background, rounder corners.
10. Toggle macOS dark mode (System Settings → Appearance) — text and backgrounds invert via system colors; skin decoration (rules, borders, accents) all stay legible.
11. Switch back to "Default" — look reverts exactly to current main-branch appearance. Switch to "书苑" again — look returns. No flash, no scroll jump.

- [ ] **Step 4: Run full test suite + type check + build**

Run: `pnpm test && pnpm check && pnpm build`
Expected: all tests pass, no type errors, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/styles/skins/shuyuan.css src/App.svelte
git commit -m "feat(skin): add shuyuan skin (Chinese book typography)"
```

---

## Task 8: Document smoke tests in README

**Files:**
- Modify: `README.md`

Append three smoke-test items so the release checklist covers the skin feature.

- [ ] **Step 1: Append items to README smoke list**

In `README.md`, find the last numbered smoke test item (currently item 67, "md2pdf write failure"). Add immediately after it:

```markdown
68. **Skin switch** — open a markdown file with H1/H2/H3, blockquote,
    bullet list, table, hr → Preferences (Cmd+,) → Core → switch Skin
    to "书苑（中文优化）". Editor visually updates immediately:
    Songti/思源宋体 body, sans-serif headings, first-line paragraph
    indent, Kaiti blockquote, middle-dot bullets, horizontal-only
    table borders, three-asterisk hr. No flash, no scroll jump. Switch
    back to "Default" → look reverts to GitHub-ish style.
69. **Skin persistence** — set Skin to "书苑", quit M↓, relaunch.
    Editor opens with 书苑 still applied; Preferences dropdown still
    shows "书苑（中文优化）".
70. **Skin + dark mode** — with 书苑 active, toggle macOS Appearance
    between Light and Dark. Text/background invert via system
    colors; skin decoration (heading rules, blockquote borders, table
    horizontals, hr asterisks) all stay legible in both modes.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): smoke tests for skin switch / persistence / dark mode"
```

---

## Task 9: Final integration verification

**Files:** none (verification only)

A short end-to-end pass to catch anything the per-task checks missed.

- [ ] **Step 1: Clean test run**

Run: `pnpm test`
Expected: all tests pass (settings + skin + everything else).

- [ ] **Step 2: Type check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 3: Production build**

Run: `pnpm build`
Expected: build succeeds; no missing-import warnings for the new CSS files.

- [ ] **Step 4: Smoke walk through new items**

Run: `pnpm tauri dev`. Walk through README items 68, 69, 70 (added in Task 8). All three should pass.

- [ ] **Step 5: Spot-check non-skin features still work**

Open a markdown file with a `mermaid` block, a python code block, and a KaTeX expression. With each skin (default + shuyuan), verify all three render exactly as before. (This guards against accidental skin-into-base bleed.)

- [ ] **Step 6: No commit**

This task is verification only. If any step fails, file a bug task and amend the failing earlier task — do not paper over it here.

---

## Self-Review Notes

After drafting, I checked the plan against the spec:

- **Skin scope (rich editor only)** — Task 5 puts `data-skin` on the rich-editor host; mdshare/md2pdf are untouched. ✓
- **Two skins (default + shuyuan)** — Tasks 4 + 7. ✓
- **base + skin layer split** — Task 4. ✓
- **Persistence via Tauri Store** — Task 1. ✓
- **Preferences dropdown** — Task 6. ✓
- **CSS-only switching, no remount** — Task 5 (reactive attribute, no editor reinit). ✓
- **Default value `'default'`** — Task 1 (settings) + Task 2 (skin module). Consistent. ✓
- **Validation falls back to default** — Task 1 uses `KNOWN_SKIN_IDS` set; Task 2 exports `isValidSkinId`. (Both maintain the same set; if a third skin is added later, both files update.) ✓
- **shuyuan visual rules** (font stack, line-height, headings, indent, blockquote, lists, tables, hr) — Task 7 implements every clause from spec § "shuyuan skin definition". ✓
- **Manual smoke tests in README** — Task 8 covers spec § "Testing" items 68/69/70 verbatim. ✓
- **Unit tests for skin/settings** — Tasks 1 + 2. ✓

One spec-vs-plan adjustment: the spec said "src/main.ts imports all three skin stylesheets". The actual codebase imports CSS in `App.svelte` (verified via `grep import './styles' src/App.svelte src/main.ts`), so the plan keeps that location. No semantic change.

Selector convention: spec wrote selectors as `.moraya-editor[data-skin="..."]`, but the `data-skin` attribute lives on the `.host` *parent* of `.moraya-editor` (because `@moraya/core` mounts the editor inside the host, after the host is rendered). The plan adjusts to `[data-skin="..."] .moraya-editor` everywhere. Both files (default.css, shuyuan.css) use the parent-attribute pattern consistently.
