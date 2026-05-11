# Typora theme import design

**Date:** 2026-05-11
**Status:** Approved, ready for implementation plan

## Goal

Let M↓ users install any [Typora theme](https://github.com/typora/theme.typora.io)
by dropping a `.zip` (or picking it from Preferences). The current rigid
"skin" mechanism (hand-authored CSS files baked into the app bundle and
hard-coded in `SkinId` union) is replaced by a directory-based theme system
that follows Typora's own conventions, so that:

- Every `.css` file in the user's themes directory is one independent theme.
- Themes are paired into a (light, dark) tuple that follows macOS appearance.
- The user can manually add, edit, or delete theme files in Finder; M↓
  picks up the changes on launch (and via an explicit refresh).
- Existing built-in skins (`default`, `effie`) migrate into the same
  directory as plain Typora-format CSS files. There is no longer a
  privileged "built-in" code path.

## Non-goals

- **Print / PDF export** is out of scope. `@media print` blocks are preserved
  in the compiled CSS but the export pipeline (md2pdf) is not yet wired to
  consume them.
- **Sidebar / window-chrome theming** is out of scope. Typora themes that
  target `.sidebar`, `#typora-quick-open`, etc. will not affect M↓'s tab bar
  or menus — those selectors simply won't match.
- **Live edit-and-preview** of a theme (watch source CSS and recompile on
  save) is out of scope. Users edit `themes/<name>.css`, then trigger
  "Reload themes" from Preferences. A future revision may add file watching.
- **Shadow DOM isolation** for editor content is out of scope. We rewrite
  selectors to a `.moraya-editor` scope instead of changing M↓'s DOM
  topology.
- **Theme marketplace / discovery UI** is out of scope. The user finds
  themes elsewhere (e.g., theme.typora.io) and imports zips manually.
- **Linux/Windows path support** is not designed against — M↓ currently
  ships only macOS, and the directory paths in this spec use the macOS
  Application Support layout. Cross-platform extension follows the same
  conventions Tauri's `app_data_dir` provides.

## Why this approach

Typora has a large theme ecosystem and a stable convention. By making M↓
read those themes natively — and storing built-in themes in the same
location and same format — we get:

1. **Zero per-theme code.** No `SkinId` union to extend, no per-skin import
   line in `App.svelte`. The theme registry is read from disk.
2. **User-tunable.** Power users edit `themes/<name>.css` directly in any
   editor, then trigger reload.
3. **Compatible with the ecosystem.** A user who already maintains a
   collection of Typora themes can drop them in and they work.

## High-level architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│ User actions                                                          │
│   • Drag *.zip onto window                                            │
│   • Preferences → "Import Typora Theme…"                              │
│   • Manually add/remove files in themes/ via Finder                   │
└─────────────────────────┬─────────────────────────────────────────────┘
                          │
                          ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Rust (Tauri command layer)                                            │
│                                                                       │
│   theme_import(zip_path) → ThemeImportReport                          │
│     1. unzip to tmpdir, validate paths (no `..`)                      │
│     2. parse each CSS header for metadata                             │
│     3. detect conflicts with existing themes                          │
│     4. return summary to frontend → user confirms                     │
│                                                                       │
│   theme_install(approved_report) → ()                                 │
│     1. copy source CSS + asset folders into themes/                   │
│     2. invoke lightningcss to rewrite selectors                       │
│     3. write compiled CSS into themes/.compiled/                      │
│     4. emit `themes-updated` event                                    │
│                                                                       │
│   theme_list() → Vec<ThemeMeta>                                       │
│     scan themes/, parse headers, return registry                      │
│                                                                       │
│   theme_recompile(name) → ()                                          │
│     re-run lightningcss for one theme (manual edit reload)            │
│                                                                       │
│   theme_reveal() → ()                                                 │
│     open themes/ in Finder                                            │
└─────────────────────────┬─────────────────────────────────────────────┘
                          │
                          ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Frontend (Svelte 5)                                                   │
│                                                                       │
│   themes.svelte.ts   ← reactive registry, hydrated from theme_list    │
│   theme-loader.ts    ← injects <style> for active theme(s)            │
│   SettingsDialog     ← Light/Dark dropdowns + import/reveal buttons   │
│   App.svelte         ← sets [data-theme="<id>"] on host element       │
│                                                                       │
│   settings persistence:                                                │
│     theme.light:        <theme-id>                                    │
│     theme.dark:         <theme-id>                                    │
│     theme.followSystem: boolean   (false → always light)              │
└───────────────────────────────────────────────────────────────────────┘
```

## Directory layout

User-visible:

```
~/Library/Application Support/com.laobu.mdeditor/themes/
├── default.css                  ← built-in, migrated on first launch
├── effie.css                    ← built-in, migrated on first launch
├── claude-like.css              ← user-imported (Typora source CSS)
├── claude-like-dark.css
├── claude-like-grey.css
├── claude-like/                 ← (optional) Typora "asset folder" convention
│   └── fonts/...
└── .compiled/                   ← M↓-generated, regenerable cache
    ├── default.css
    ├── effie.css
    ├── claude-like.css
    ├── claude-like-dark.css
    └── claude-like-grey.css
```

Conventions:

- Each `*.css` directly under `themes/` is a theme. Subdirectories named the
  same as a `.css` (minus the extension) are treated as asset folders
  (fonts, images) for that theme. Other subdirectories are ignored.
- `.compiled/` is M↓-owned. Users may delete it; M↓ will recompile on next
  launch. Editing files in `.compiled/` directly is not supported (M↓
  overwrites on recompile).
- A theme is identified by its file stem (`claude-like.css` → id
  `claude-like`). Ids must match `[a-z0-9][a-z0-9._-]*`. CSS files whose
  stem violates this are skipped with a warning event.

## Built-in theme migration

As part of this work, the two existing skin CSS files (`default.css`,
`effie.css`) are **hand-rewritten once** into Typora source-form CSS (no
`[data-skin]` prefix; selectors target `:root`, `html`/`body`, plain tag
selectors, etc.) and shipped as app resources under
`src-tauri/resources/themes/`. The migration itself contains no runtime
CSS transformation logic.

On first launch (or when `themes/` does not contain `default.css` /
`effie.css`):

1. Tauri reads the bundled resource files via the bundle resource path.
2. Each is **copied verbatim** to `themes/default.css` and
   `themes/effie.css`.
3. The standard compilation pipeline (see "Compilation pipeline" below)
   produces `themes/.compiled/default.css` and `themes/.compiled/effie.css`.

If a user has deleted one of them, M↓ does *not* re-create it automatically
(silent re-creation would surprise users who deliberately removed it). The
Preferences pane provides a "Restore built-in themes" button that writes
both back, overwriting any present version.

Subsequent launches simply read whatever is in `themes/`.

## CSS metadata convention

The first CSS comment block in the file is parsed as metadata:

```css
/*
 * Theme Name:  Claude-Like
 * Author:      anonymous
 * Version:     1.0.0
 * Appearance:  light
 * Description: Anthropic Claude-inspired warm paper.
 */
:root {
  --bg-color: #faf9f5;
  ...
}
```

Parser rules:

- Look only at the first `/* … */` block at the top of the file (after
  optional `@charset` and BOM).
- Extract `Key: Value` lines, case-insensitive on keys. Whitespace
  trimmed. Lines that don't match the pattern are ignored.
- Recognized keys: `Theme Name`, `Author`, `Version`, `Appearance`,
  `Description`. Unknown keys are preserved in `ThemeMeta.extra` but
  unused.
- `Appearance` values: `light` | `dark`. Anything else → fallback to
  filename heuristic.

Fallback heuristic when the header is missing or `Appearance` is absent:

- File stem matches `/(^|[-_])(dark|night)([-_]|$)/i` → `dark`.
- Otherwise → `light`.

The display name falls back to the file stem in Title Case
(`claude-like-dark` → "Claude-Like Dark").

We **do not** write metadata headers back into user-provided files. If a
zip arrives without a header, M↓ holds the inferred values in memory only;
the on-disk source CSS is untouched. (Rationale: respecting user files
matters more than uniformity, and the heuristic is stable.)

## Selector translation rules

The compiler (Rust + `lightningcss`) rewrites every rule in a Typora CSS
to be scoped under `[data-theme="<id>"] .moraya-editor`.

| Original selector              | Rewritten to                                              |
| ------------------------------ | --------------------------------------------------------- |
| `:root`                        | `[data-theme="<id>"] .moraya-editor`                      |
| `#write`                       | `[data-theme="<id>"] .moraya-editor`                      |
| `html`                         | `[data-theme="<id>"] .moraya-editor`                      |
| `body`                         | `[data-theme="<id>"] .moraya-editor`                      |
| `#write > h1` (child combinator after `#write`) | `[data-theme="<id>"] .moraya-editor h1` (`>` → space) |
| `.md-fences`, any other class/tag selector | `[data-theme="<id>"] .moraya-editor .md-fences` (prefix prepended) |
| compound selectors like `a.external` | `[data-theme="<id>"] .moraya-editor a.external` |
| selector list `h1, h2`         | each list element prefixed independently                  |

At-rules:

- `@include-when-export url(…)` — Typora-private at-rule, stripped entirely
  (lightningcss errors on it; we pre-strip with a regex pass *before*
  parsing).
- `@font-face` — preserved. `url(./fonts/x.woff2)` inside is rewritten to
  the absolute Tauri asset URL pointing at `themes/<id>/fonts/x.woff2`
  (`tauri://localhost/...` via `convertFileSrc`). Absolute `url(https://...)`
  is left alone.
- `@media print` — preserved unchanged, including its inner rules. Will be
  unused until md2pdf plugin opts in.
- `@media (prefers-color-scheme: dark)` etc. — preserved unchanged; useful
  for themes that pack light/dark in one file (we treat appearance pairing
  at the theme level, but in-file media queries still work).
- `@import url(...)` — preserved unchanged. Themes may rely on remote
  webfonts (jsDelivr etc.); blocking would break Typora compatibility.

Special cases / trade-offs:

- **Child combinator after `#write` becomes a descendant combinator.** A
  small minority of Typora themes use `#write > p` to exclude nested
  paragraphs (e.g. inside blockquotes). Our rewrite makes that selector
  also match the nested case. Acceptable: it favors visual coverage over
  semantic precision, and the user can edit the source if they hit a
  collision.
- **`html` and `body` rules apply only inside the editor.** Typora's body
  background colors the entire window; in M↓ it colors the editor pane.
  Window chrome (tab bar, title bar) stays neutral. This is consistent
  with how M↓ already handles built-in skins.
- **`:root` CSS variable declarations end up scoped to the editor.** They
  will not affect M↓'s app shell — that's the intended behavior. Plugins
  or features that need theme variables must read them inside the editor
  scope.

## Compilation pipeline

For each theme file under `themes/<id>.css`:

1. **Read source** with bytes (no encoding conversion). Strip BOM.
2. **Pre-strip Typora-specific at-rules** with a regex pass:
   - `@include-when-export url(...);` lines deleted.
3. **Parse with lightningcss.** On parse error, abort this theme, emit a
   compilation error event, and leave the previous compiled CSS in place
   (if any). The user can still use other themes.
4. **Walk the stylesheet AST**, rewriting selectors and rewriting
   `url(...)` references in `@font-face`. Use `lightningcss::visitor::Visit`.
5. **Serialize** back to CSS with minification disabled (keeps source
   maps trivial; size differences negligible for theme CSS).
6. **Write** to `themes/.compiled/<id>.css`.

Build flags / dependencies (new in `src-tauri/Cargo.toml`):

- `lightningcss = "1.0.0-alpha.x"` (whichever is current at implementation
  time).
- `zip = "1.x"` for zip extraction. Tauri's existing fs plugin handles
  read/write.

## Frontend integration

### Theme registry (`src/lib/themes.svelte.ts`)

```ts
export interface ThemeMeta {
  id: string                      // file stem
  name: string                    // from header or Title Case stem
  appearance: 'light' | 'dark'    // from header or filename heuristic
  author?: string
  version?: string
  description?: string
  source: string                  // absolute path to source CSS
  compiled: string                // absolute path to compiled CSS
  builtIn: boolean                // id is in BUILTIN_IDS
}

export const themes = $state<{
  list: ThemeMeta[]
  error: string | null
}>({ list: [], error: null })

export async function loadThemes(): Promise<void> { … }   // calls theme_list
export async function reloadThemes(): Promise<void> { … } // forces rescan
```

### Theme loader (`src/lib/theme-loader.ts`)

Two `<style data-theme-slot="light|dark">` elements live in `<head>`,
both populated at app start. Each holds the compiled CSS of the
currently-assigned theme for that slot, read via `readTextFile` from
`themes/.compiled/<id>.css`.

Because every theme's compiled CSS is scoped to its own
`[data-theme="<id>"]` selector, all four scenarios reduce to one
mechanism: **set the `data-theme` attribute on the editor host to the
active theme id**. The non-active theme's rules sit in `<head>` but match
nothing, so they are inert.

`data-theme` is computed reactively from:

- `settings.theme.followSystem`
- `settings.theme.light` / `settings.theme.dark`
- the current system appearance (`prefers-color-scheme` media query)

```
followSystem=true,  systemDark=true   →  data-theme = theme.dark
followSystem=true,  systemDark=false  →  data-theme = theme.light
followSystem=false                    →  data-theme = theme.light
```

Slot content is reloaded only when the assigned theme id changes (not on
every system appearance flip), keeping appearance toggles allocation-free.

### Host attribute

`App.svelte` sets `data-theme` on `<RichEditor>`'s host element, computed
as described in "Theme loader" above. The existing `data-skin` attribute
is **renamed to `data-theme`** for accuracy. All references — the host
binding in `App.svelte`, the share-baker's mobile-override CSS block in
`share-baker.ts`, and the hand-rewritten built-in source CSS — are
migrated in the same change. Once the migration is done, `data-skin`
exists nowhere in the codebase.

### Preferences UI (`SettingsDialog.svelte`)

The current "Core → Skin" row (single dropdown) is replaced with:

```
Themes
─────────────────────────────────────────────
Light theme:   [Default          ▾]
Dark theme:    [Effie            ▾]
☐ Always use light theme (ignore system appearance)

[ Import Typora theme… ]   [ Reveal themes folder ]
[ Reload themes ]           [ Restore built-in themes ]
```

Both dropdowns list all themes from `themes.list`, sorted by display
name. The light/dark assignment isn't constrained — the user can pair any
two themes (or the same theme twice).

## Import flow

### Entry points

1. **Drag a `.zip` onto the M↓ window.** The existing drag handler in
   `App.svelte` routes by extension. New branch: if the dropped file ends
   in `.zip`, prevent default tab-opening and dispatch `theme_import`.
2. **Preferences → "Import Typora theme…" button.** Opens an OS file
   picker scoped to `.zip`.

### Confirmation dialog

After `theme_import` succeeds, the frontend shows a modal:

```
Import Typora theme

Detected 3 themes:
  • Claude-Like       (light)        new
  • Claude-Like Grey  (light)        new
  • Claude-Like Dark  (dark)         new

Asset folders:
  • claude-like/

Target: ~/Library/Application Support/com.laobu.mdeditor/themes/

[ Cancel ]   [ Import ]
```

If a theme id conflicts with an existing file, that row is highlighted:

```
  • Default           (light)        ⚠ will overwrite existing
```

The user must check "Overwrite existing themes" to enable import when
conflicts exist. (We don't ask per-file to keep the dialog small; the
overwrite scope is binary for the whole import.)

On confirm, `theme_install` runs; on success, the dialog closes and a
toast says "Imported N themes."

### Errors handled inside the dialog

- Zip is corrupt → dialog opens with an error message and no theme list.
- Zip has no `.css` at the root → "No Typora themes found in this zip."
- One or more CSS files fail to parse → those rows show "⚠ Invalid CSS:
  <error>" and are excluded from the import set.
- Zip contains paths with `..` → dialog refuses to load: "Zip contains
  suspicious paths."

## Settings schema migration

Old:

```json
{ "skin": "effie" }
```

New:

```json
{
  "theme": {
    "light": "default",
    "dark": "effie",
    "followSystem": true
  }
}
```

Migration in `loadSettings()`:

```ts
const storedSkin = await store.get<string>('skin')
const storedTheme = await store.get<ThemeSettings>('theme')

if (storedTheme) {
  settings.theme = storedTheme
} else if (storedSkin) {
  // Migrate: old single-skin → both light & dark = stored skin, no follow.
  settings.theme = {
    light: storedSkin,
    dark: storedSkin,
    followSystem: false,
  }
  await store.delete('skin')   // remove legacy key
} else {
  settings.theme = { light: 'default', dark: 'default', followSystem: true }
}
```

The old `skin` setting key is deleted after migration so we have one
source of truth going forward. Unknown theme ids (theme file was deleted)
fall back silently to `default`; if `default` itself is missing, M↓ shows
a toast and renders unstyled.

## Security and validation

- **Zip extraction limits.** Cap per-entry uncompressed size at 5 MB and
  total uncompressed size at 20 MB. Reject otherwise (defends against zip
  bombs).
- **Path traversal.** Every path in the zip is normalized; any entry that
  resolves outside the temp extraction root is refused before any disk
  write.
- **CSS content.** lightningcss handles arbitrary CSS without executing
  it; there is no JS in CSS. `url(...)` references that point outside the
  theme folder via `..` are rewritten to a safe placeholder
  (`url(about:blank)`) so a hostile theme can't reference user data on
  disk. Absolute `https://` URLs are allowed (themes legitimately use
  remote webfonts).
- **Manifest of allowed file types in zip.** Accept only `.css` files and
  files inside same-named subdirectories. Other entries are ignored
  silently (READMEs, screenshots, etc.).

## Testing strategy

### Unit tests (Rust)

1. **Header parser** — table-driven cases: full header, missing optional
   keys, no header at all, mixed case keys, extra whitespace, weird line
   endings, multi-line description.
2. **Filename appearance heuristic** — `dark`, `night`, `-dark`,
   `_night-foo`, `darkroom` (must NOT match), `unrelated`.
3. **Selector rewriter** — for each rule above (`#write`, `:root`, `html`,
   `body`, `#write > x`, complex selector lists, nested at-rules), assert
   the rewritten output matches the expected scoped form.
4. **`@include-when-export` stripper** — verify it's removed even with
   weird whitespace.
5. **`@font-face url()` rewriter** — relative path → absolute Tauri URL,
   `https://` URL untouched, `data:` URL untouched.
6. **Zip security** — corrupt zip, zip with `../` path, zip bomb (cap
   exceeded), zip with no `.css` at root, zip with valid CSS + asset
   subfolder.

### Unit tests (TS)

1. **Settings migration** — old `skin: 'effie'` → new
   `theme: { light: 'effie', dark: 'effie', followSystem: false }`,
   legacy key deleted.
2. **Theme registry hydration** — mock `theme_list` invoke, assert
   `themes.list` is populated and sorted.
3. **Theme loader** — slot management: switching `theme.light` updates
   only the light slot; toggling `followSystem` rewires both slots
   correctly.

### Integration / smoke tests (manual)

These extend the existing README "Manual Smoke Test" list (renumbered from
step 68):

68. **Default theme switch** — open a markdown file with H1/H2/H3,
    blockquote, bullet list, table, hr → Preferences → switch *Light
    theme* to "Effie" → editor visually updates to Effie's mint-paper
    palette. Switch back to "Default" → reverts.
69. **Theme persistence** — set light=Effie, dark=Default, quit, relaunch
    → values restored in dropdowns; editor styled by Effie in light
    mode.
70. **Light/dark auto-switch** — set light=Default, dark=Effie, toggle
    macOS Appearance between Light and Dark → editor flips themes
    instantly, no flash.
71. **Always use light theme** — check the box, toggle macOS Appearance
    → editor stays on the light theme regardless.
72. **Import Typora zip via drag** — drag
    `~/Downloads/Typora_Claude-Like_Theme.zip` onto window → confirm
    dialog lists 3 themes (Claude-Like / Claude-Like Grey / Claude-Like
    Dark) with correct appearance → Import → toast "Imported 3 themes."
    → dropdowns now include all three.
73. **Import via Preferences button** — Preferences → "Import Typora
    theme…" → pick same zip → import → no duplicate entries
    (existing-overwrite checkbox auto-required).
74. **Apply imported theme** — Light theme dropdown → "Claude-Like" →
    editor turns into warm paper.
75. **Reveal themes folder** — click "Reveal themes folder" → Finder
    opens `themes/` with all expected files.
76. **Manual delete via Finder** — delete `claude-like-grey.css`, click
    "Reload themes" → dropdown updates, that theme is gone.
77. **Restore built-in themes** — delete `default.css` in Finder →
    "Restore built-in themes" → file reappears, theme works.
78. **Theme + share plugin** — with Effie active, share document via
    `Cmd+Shift+L` → shared HTML uses the same Effie palette (share-baker
    bundles the compiled CSS, not the legacy hand-authored skin file).
79. **Malformed zip** — drag a `.zip` containing no CSS → dialog shows
    "No Typora themes found in this zip." Close → no files written.
80. **Zip bomb / huge file** — try a zip with a 50 MB CSS entry → dialog
    refuses with "Theme file too large."

## Risks and open questions

- **lightningcss version churn.** It's pre-1.0 and the AST visitor API has
  changed across releases. We pin to a specific version and isolate it
  behind a single Rust module so future upgrades are a focused change.
- **Share-baker coupling.** The current share plugin (`share-baker.ts`)
  hand-imports each skin CSS via Vite `?raw`. After migration, share-baker
  needs to read from the compiled theme files at bake time (or the user's
  active theme is baked as a sourced-from-disk blob). This adds an async
  read but keeps shared docs visually consistent.
- **First-launch latency.** Migrating built-ins + compiling them on first
  launch adds a small one-time cost (sub-100 ms expected for two small
  CSS files; lightningcss is fast). We do this synchronously before the
  editor mounts so there's no FOUC. If measurement shows it's slower than
  expected, we move the work to a background task and accept one frame of
  unstyled editor.
- **Hot-reload on manual edit.** The user edits `themes/<id>.css` outside
  the app and expects the change to appear. Current design requires
  clicking "Reload themes" in Preferences. A future revision could add
  `notify`-based file watching, but that adds platform-specific code; we
  defer.

## Out-of-scope follow-ups (future work)

- File watcher on `themes/` for live reload.
- Theme preview thumbnails in the dropdown.
- Per-theme CSS variable override pane (the Typora `base.user.css`
  pattern).
- md2pdf integration of `@media print` blocks.
- Sidebar / window-chrome theming (would need a separate `data-theme-app`
  attribute and a corresponding selector scope).
