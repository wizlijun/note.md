# Rich Editor Skins

The rich (WYSIWYG) editor currently ships with a single GitHub-style skin baked
into `src/styles/app.css`. The visual style is Western-first: system sans-serif
font stack, no CJK font preference, tight line-height, generic heading
treatment, and no concession to Chinese typographic conventions (first-line
indent, mixed-script kerning, book-style blockquotes). Long-form Chinese
writing in this editor looks plain.

This spec adds a skin mechanism to the rich editor and ships one new skin —
**shuyuan**, a Chinese-optimized "modern book" style — alongside the existing
default. Skins only affect the rich editor view; the source view, share-page
worker, and PDF export pipeline are unaffected in v1, though the skin
definitions are structured so they can be reused later.

## Scope

**In scope (v1):**

- Skin selection mechanism applied to the rich editor (`.moraya-editor` and
  surrounding wrapper)
- Two skins: `default` (current GitHub-ish look, unchanged) and `shuyuan`
  (Chinese book typography)
- Persistence via existing Tauri Store (`settings.json`)
- Preferences → Core dropdown to switch
- CSS-only switching: no editor remount, no JS recomputation

**Out of scope:**

- mdshare worker / recipient page styling
- md2pdf export pipeline
- Per-tab or per-extension skin selection
- User-customizable skins (font picker, line-height slider, etc.)
- Quick-switch UI (toolbar / status bar / menu)
- Skins for source view (raw textarea)

## Design

### Architecture: base + skin layers

The current `app.css` mixes two concerns: foundational structural styles
(code-block NodeView wrapper, hljs token colors, mermaid spinner, language
picker) and visual styling (typography, headings, blockquotes, lists). When a
skin changes typography it must not accidentally clobber hljs colors or the
mermaid loading state.

Split into three files:

```
src/styles/
  app.css              global reset, root font, html/body/#app — unchanged
  editor-base.css      structural editor styles that are NEVER skinned
  skins/
    default.css        current GitHub-ish typography (extracted from app.css)
    shuyuan.css        new Chinese book typography
```

**editor-base.css** owns:

- `.moraya-editor` outline reset
- `.code-block-wrapper`, `.code-block-toolbar`, `.code-lang-label`,
  `.code-copy-btn`, `.mermaid-toggle-btn`, `.code-block-pre`/`pre`,
  `.code-block-code` (structural; the actual *background tint* of code blocks
  uses `Canvas`/`CanvasText` system colors and stays neutral across skins)
- `.code-lang-picker` (mounted to body)
- All `.hljs-*` syntax token colors (light + dark)
- `.mermaid-preview`, `.mermaid-loading`, `.mermaid-spinner`,
  `.mermaid-error`, `.mermaid-empty`
- `.renderer-preview` (WaveDrom/D2 fallback)

**skins/<id>.css** owns:

- `font-family`, `font-feature-settings`, `letter-spacing`, `line-height` for
  the editor body
- `h1`–`h6` typography and decorations
- `p` margins and `text-indent`
- `a` color and underline style
- `blockquote` style (border, padding, font-family, alignment)
- `ul`/`ol`/`li` markers and indentation
- `table`/`th`/`td`/`hr` border and spacing
- Inline `code` (the `:not(pre) > code` rule) — its background and border
  radius can vary per skin

Each skin file scopes every rule to `.moraya-editor[data-skin="<id>"]` so the
two skin files never collide.

### Activation: data attribute on the editor host

`src/components/RichEditor.svelte`'s `.host` div gets a reactive
`data-skin={currentSkin}` attribute. Switching skin = updating that attribute;
the browser reflows with the new skin's CSS. No remount, no editor state loss.

The actual `[data-skin]` is set on the inner host (the same element @moraya/core
mounts onto, which becomes `.moraya-editor`), so the skin selectors resolve at
the same specificity level as the existing rules in `app.css`.

### State: `src/lib/skin.svelte.ts`

A small new module:

```ts
export type SkinId = 'default' | 'shuyuan'

export const SKINS: { id: SkinId; label: string; description: string }[] = [
  { id: 'default', label: 'Default',
    description: 'GitHub-style sans-serif, neutral and minimal.' },
  { id: 'shuyuan', label: '书苑（中文优化）',
    description: '思源宋体正文 + 思源黑体标题，仿现代中文书籍排版。' },
]

export const skin = $state<{ current: SkinId }>({ current: 'default' })

export function setSkin(id: SkinId): void { skin.current = id }
```

`settings.svelte.ts` extends to load/save `skin` from the Tauri Store:

- Default value: `'default'`
- Loaded inside `loadSettings()`, written inside `saveSettings()`
- Validated against `SKINS` ids — unknown value falls back to `'default'`

`App.svelte` (or wherever `loadSettings()` runs at boot) syncs the loaded
value into the `skin` state on startup.

### UI entry point

`src/components/SettingsDialog.svelte` Core tab — add a row above the
auto-save checkbox:

```
Skin:  [ Default ▾ ]
       GitHub-style sans-serif, neutral and minimal.
```

The dropdown is bound to `skin.current`. On change: update state, persist via
`saveSettings()`. Description text under the dropdown is the selected skin's
`description` field, so users see what they're choosing without applying it.

The change takes effect immediately because `RichEditor.svelte` reads
`skin.current` reactively into its `data-skin` attribute.

### `shuyuan` skin definition

Targeting all selectors as `.moraya-editor[data-skin="shuyuan"]`.

**Body typography:**

```css
font-family:
  'Iowan Old Style', 'Charter', 'Georgia',                /* Western serif */
  'Noto Serif CJK SC', 'Source Han Serif SC',
  'Songti SC', 'STSong', serif;                            /* CJK serif */
font-feature-settings: 'palt';   /* CJK punctuation kerning */
letter-spacing: 0.01em;
line-height: 1.85;
```

The Western fonts are listed *first* so that ASCII characters fall through to
them before the browser tries the CJK fonts (whose Latin glyphs are usually
poor). This is a standard mixed-script trick — per-character font fallback in
modern browsers picks the first font in the stack that contains the glyph.

**Headings** (font-family `'PingFang SC', 'Noto Sans CJK SC', -apple-system,
sans-serif` — sans-serif against serif body for contrast):

- `h1` — 1.9em, weight 700, centered, top + bottom 1px solid borders with
  0.4em padding. Margin 1.4em above, 0.8em below.
- `h2` — 1.45em, weight 600, left border 3px `AccentColor`, padding-left
  0.6em. Margin 1.4em above, 0.5em below.
- `h3` — 1.18em, weight 600, bottom 1px dashed border on
  `color-mix(in srgb, CanvasText 25%, transparent)`, padding-bottom 0.2em.
- `h4`, `h5`, `h6` — 1em / 0.95em / 0.9em, weight 600, no decoration.

**Paragraphs:**

```css
.moraya-editor[data-skin="shuyuan"] p {
  margin: 0.8em 0;
  text-indent: 2em;       /* CJK first-line indent */
}
.moraya-editor[data-skin="shuyuan"] li > p,
.moraya-editor[data-skin="shuyuan"] blockquote p {
  text-indent: 0;          /* no indent inside lists / quotes */
}
.moraya-editor[data-skin="shuyuan"] p:first-child {
  text-indent: 0;          /* no indent at section start */
}
```

The `:first-child` exception keeps the very first paragraph after a heading
flush, matching modern Chinese typesetting (the Western "no indent at section
start" convention).

**Blockquote** — book-style "epigraph" rather than the default flag-mark:

```css
.moraya-editor[data-skin="shuyuan"] blockquote {
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
```

Kaiti (楷体) for blockquote is conventional in Chinese typesetting for quoted
passages.

**Lists:**

```css
.moraya-editor[data-skin="shuyuan"] ul { list-style: none; padding-left: 1.4em; }
.moraya-editor[data-skin="shuyuan"] ul > li { position: relative; }
.moraya-editor[data-skin="shuyuan"] ul > li::before {
  content: '·';
  position: absolute;
  left: -1em;
  color: color-mix(in srgb, CanvasText 60%, transparent);
}
.moraya-editor[data-skin="shuyuan"] ol { padding-left: 1.8em; }
```

The `·` (middle dot) reads better than `•` for Chinese; ordered lists keep
default numbering since `1.` / `1、` is a layout decision the user controls.

**Tables** — horizontal-only borders (Chinese book convention):

```css
.moraya-editor[data-skin="shuyuan"] table {
  border-collapse: collapse;
  margin: 1em auto;
  border-top: 2px solid CanvasText;
  border-bottom: 2px solid CanvasText;
}
.moraya-editor[data-skin="shuyuan"] th {
  border-bottom: 1px solid CanvasText;
  padding: 8px 12px;
  font-weight: 600;
}
.moraya-editor[data-skin="shuyuan"] td {
  padding: 6px 12px;
}
```

Note: tables are skin-owned, not base-owned. The current `border: 1px solid …`
on `th`/`td` in `app.css` moves *into* `default.css`, leaving `editor-base.css`
with no table styling. shuyuan therefore doesn't need to "cancel" anything —
it just defines its own borders from scratch.

**Inline code:**

```css
.moraya-editor[data-skin="shuyuan"] :not(pre) > code {
  font-size: 0.88em;
  padding: 1px 5px;
  background: color-mix(in srgb, CanvasText 6%, transparent);
  border-radius: 4px;
}
```

**Links** — slightly muted underline so it doesn't clash with the serif body:

```css
.moraya-editor[data-skin="shuyuan"] a {
  color: #0969da;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}
```

**Horizontal rule** — replace the line with three centered asterisks (book
section break):

```css
.moraya-editor[data-skin="shuyuan"] hr {
  border: 0;
  margin: 1.6em 0;
  text-align: center;
  height: 1.2em;
}
.moraya-editor[data-skin="shuyuan"] hr::before {
  content: '＊　＊　＊';
  color: color-mix(in srgb, CanvasText 50%, transparent);
  letter-spacing: 0.5em;
}
```

### What stays unchanged

- All hljs token colors (live in `editor-base.css`)
- Mermaid loading/error/empty UI
- Code block toolbar (lang label, copy button)
- Code-language picker popover
- KaTeX rendered output (untouched stylesheet from `katex/dist/katex.min.css`)
- Source-view textarea (skin doesn't apply)
- mdshare worker output, PDF export

### Loading strategy

`src/main.ts` imports all three skin stylesheets unconditionally:

```ts
import './styles/app.css'
import './styles/editor-base.css'
import './styles/skins/default.css'
import './styles/skins/shuyuan.css'
```

Total CSS size for both skins is well under 10 KB; eager loading keeps switch
latency at zero (no FOUC, no async). If skins ever balloon (custom fonts
bundled, etc.), the lazy-load strategy can be revisited then.

## Failure modes & edge cases

- **Unknown skin id in settings** — `loadSettings()` validates the value; an
  unrecognized id falls back to `'default'` silently and overwrites on next
  save.
- **CJK fonts not installed** — the font stack ends in generic `serif` /
  `sans-serif`. On macOS, `PingFang SC`, `Songti SC`, `STKaiti` ship with the
  OS, so the practical fallback is fine. Linux/Windows aren't a concern (this
  is a macOS-only Tauri app).
- **First-paragraph-after-heading indent rule** — `p:first-child` won't catch
  every case ProseMirror produces; if it misses, the worst outcome is one
  extra indented paragraph at the start of a section. Acceptable for v1; a
  more precise selector (`h1 + p, h2 + p, ...`) can refine later.
- **Inline code inside a list item with first-line indent** — text-indent
  doesn't affect inline code; no interaction expected.
- **Editor remount when wrapAsCodeBlock is set** (code-kind tabs) — the host
  div's `data-skin` attribute is reactive, so it stays correct after remount.

## Testing

This is a CSS-only feature; the tested surface is small.

- **Unit:** add `src/lib/skin.test.ts` to verify
  - `setSkin('shuyuan')` updates `skin.current`
  - `loadSettings()` round-trips `skin` value
  - `loadSettings()` falls back to `'default'` when the stored value isn't a
    known skin id
- **Manual smoke (added to README's smoke list):**
  - 68. **Skin switch** — Open a markdown file with H1/H2/H3/blockquote/list/
       table → Preferences → Core → switch skin to "书苑" → editor visually
       updates immediately (no flash, no scroll jump). Switch back → reverts.
  - 69. **Skin persistence** — set "书苑", quit, relaunch → editor opens with
       书苑 still applied.
  - 70. **Skin + dark mode** — toggle macOS dark mode while 书苑 is active →
       editor remains legible (text/background follow system; only typographic
       decoration is skin-defined).

## Migration & rollout

- No data migration: settings without a `skin` key default to `'default'`
  (which is the existing look — zero visible change for existing users).
- No version bump required for the skin mechanism itself; ship in the next
  patch release.

## Open questions resolved during brainstorming

- Skin scope: rich editor only, structured to extend later → confirmed
- Depth: typography + decoration, colors stay system → confirmed
- Switching UI: Preferences dropdown only, no quick-switch → confirmed
- v1 skin count: default + one Chinese skin → confirmed
- Chinese skin character: modern book (not magazine) → confirmed
