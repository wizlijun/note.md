# md2pdf Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the built-in PDF export (`src-tauri/src/pdf.rs` + `src/lib/pdf-export.ts` + static `Cmd+Shift+E` menu) into an independent `md2pdf` Cargo crate that ships as a signed plugin, so users who never export pay zero CPU/memory for that feature.

**Architecture:** Mirror the `mdshare` plugin shape — separate Cargo crate, Developer ID signed, bundled inside the `.app`'s `<Resources>/plugins/md2pdf/`, invoked via the existing one-shot stdin/stdout JSON contract. Three platform extensions: `manifest.menus[].prompt: { kind: "save-dialog", … }` (host-driven save dialog before invoke), `enabled_when` grammar grows `==`/`!=`, settings.json grows `plugins.enabled.<id>: bool` with a new "Plugins" Preferences tab.

**Tech Stack:** Svelte 5 + Tauri 2 (host), Rust + objc2-app-kit + objc2-web-kit + objc2-pdf-kit + serde (CLI), shared front-end render pipeline (marked + KaTeX + highlight.js + diagram-render).

**Spec:** `docs/superpowers/specs/2026-05-08-md2pdf-plugin-design.md`

---

## File Structure

**Create (frontend):**
- `src/lib/plugins/host-render-html.ts` — shared markdown→inline-body-HTML pipeline (used by both share and md2pdf)
- `src/lib/plugins/host-render-html.test.ts` — vitest
- `src/lib/plugins/prompt.ts` — `default_filename` template renderer
- `src/lib/plugins/prompt.test.ts` — vitest
- `src/components/PluginsSettingsTab.svelte` — Preferences "Plugins" tab body

**Create (Rust plugin):**
- `md2pdf/Cargo.toml` — separate crate at repo root
- `md2pdf/src/main.rs` — entry: NSApp runloop + dispatch
- `md2pdf/src/ipc.rs` — Request / Response / Action serde types
- `md2pdf/src/template.rs` — `wrap(body, title)` → self-contained HTML with embedded `pdf.css`
- `md2pdf/src/pdf.rs` — WKWebView + PDFKit pipeline (NavDelegate, capture loop, A4 expansion, PDFKit merge)
- `md2pdf/assets/pdf.css` — print stylesheet (moved from `src/styles/pdf.css`)
- `md2pdf/tests/smoke.rs` — spawn the binary, render a 1-page HTML, assert the file appears

**Create (build / bundle glue):**
- `scripts/build-md2pdf.sh` — cross-compile + sign + copy
- `src-tauri/plugins/md2pdf/manifest.json`
- `src-tauri/plugins/md2pdf/bin-aarch64-apple-darwin` (committed binary, regenerated each release)
- `src-tauri/plugins/md2pdf/bin-x86_64-apple-darwin`

**Modify:**
- `src/lib/plugins/enabled-when.ts` — add `==` / `!=` operators + string literal atoms
- `src/lib/plugins/enabled-when.test.ts` — tests
- `src/lib/plugins/types.ts` — `PromptSpec`, extend `MenuEntry`, `RequestContextTab.kind`/`title`, `EnabledWhenContext.currentTab.kind`, `Capability` unchanged
- `src/lib/plugins/registry.ts` — accept (don't reject) `prompt` block
- `src/lib/plugins/host.ts` — propagate `output_path` into `context`
- `src/lib/plugins/menu-registry.ts` — runtime `evaluateEnabled` already covers it (no change); `tab.kind` exposed via context elsewhere
- `src/lib/settings.svelte.ts` — `plugins.enabled` accessors
- `src/lib/plugins/share-baker.ts` — switch to `host-render-html.ts`
- `src/components/SettingsDialog.svelte` — register the Plugins tab as the leftmost
- `src/App.svelte` — drop `htmlBaker` wiring done in Task 3 + handle `prompt` step before invoke
- `src/lib/commands.ts` — delete `cmdExportPdf`
- `src-tauri/src/lib.rs` — drop `mod pdf`, drop `pdf::export_pdf` from `invoke_handler`, drop the static `export-pdf` File-menu item
- `src-tauri/src/plugin_host.rs` — parse `prompt`; filter manifests by `plugins.enabled.<id>`; expose `get_all_plugin_manifests`; widen `RequestContextTab` to carry `kind` + `title` + `output_path`
- `src-tauri/Cargo.toml` — drop `objc2-pdf-kit`, `objc2`, `objc2-foundation`, `objc2-app-kit`, `objc2-web-kit`, `block2`
- `src-tauri/tauri.conf.json` — no change (`bundle.resources: ["plugins/**/*"]` already covers)
- `package.json` — add `build:md2pdf` script
- `scripts/release.sh` — add `pnpm build:md2pdf` step + `git add` for the new binaries
- `README.md` — smoke checklist items 58-63

**Delete:**
- `src-tauri/src/pdf.rs`
- `src/lib/pdf-export.ts`
- `src/lib/pdf-export.test.ts`
- `src/styles/pdf.css`

**Convention:** Each task ends with one git commit using conventional prefixes (`feat`, `feat(plugins)`, `feat(md2pdf)`, `refactor`, `test`, `docs`, `chore`).

---

## Task 1: enabled-when grammar — `==` / `!=` operators

**Files:**
- Modify: `src/lib/plugins/enabled-when.ts`
- Modify: `src/lib/plugins/enabled-when.test.ts`
- Modify: `src/lib/plugins/types.ts` (small additive change: `currentTab.kind`)

The md2pdf manifest needs `currentTab.kind == 'markdown' || currentTab.kind == 'html'`. Today the parser has no `==`/`!=` and no string-literal atom; we extend both. We also add the `kind` field to `EnabledWhenContext.currentTab` so the tests type-check.

- [ ] **Step 1: Add `kind` to `EnabledWhenContext.currentTab` (in `types.ts`)**

Locate `EnabledWhenContext` in `src/lib/plugins/types.ts`. Add a `kind` field:

```ts
export type TabKind = 'markdown' | 'html' | 'code'

export interface EnabledWhenContext {
  currentTab: {
    path: string | null
    filename: string | null
    extension: string | null
    kind: TabKind | null
    hasContent: boolean
    isDirty: boolean
    isUntitled: boolean
  } | null
  settings: Record<string, unknown>
}
```

(Task 2 will reuse `TabKind` for additional types; defining it here means Task 2's edits to types.ts are additive only.)

- [ ] **Step 2: Append failing tests**

Append to `src/lib/plugins/enabled-when.test.ts` inside the existing `describe('parseEnabledWhen', …)` block:

```ts
  it('parses == comparison with string literal', () => {
    expect(() => parseEnabledWhen("currentTab.kind == 'markdown'")).not.toThrow()
  })
  it('parses != comparison', () => {
    expect(() => parseEnabledWhen("currentTab.kind != 'code'")).not.toThrow()
  })
  it('parses comparison combined with || and &&', () => {
    expect(() => parseEnabledWhen(
      "currentTab.kind == 'markdown' || currentTab.kind == 'html'"
    )).not.toThrow()
  })
```

And inside `describe('evaluateEnabledWhen', …)`:

```ts
  it('== returns true on string match', () => {
    const c = ctx({
      currentTab: {
        path: '/x.md', filename: 'x.md', extension: 'md', kind: 'markdown',
        hasContent: true, isDirty: false, isUntitled: false,
      },
      settings: {},
    })
    expect(evaluateEnabledWhen("currentTab.kind == 'markdown'", c)).toBe(true)
    expect(evaluateEnabledWhen("currentTab.kind == 'html'", c)).toBe(false)
  })
  it('!= returns true on string mismatch', () => {
    const c = ctx({
      currentTab: {
        path: '/x.md', filename: 'x.md', extension: 'md', kind: 'markdown',
        hasContent: true, isDirty: false, isUntitled: false,
      },
      settings: {},
    })
    expect(evaluateEnabledWhen("currentTab.kind != 'code'", c)).toBe(true)
    expect(evaluateEnabledWhen("currentTab.kind != 'markdown'", c)).toBe(false)
  })
  it('comparison composes with || at correct precedence', () => {
    const c = ctx({
      currentTab: {
        path: '/x.html', filename: 'x.html', extension: 'html', kind: 'html',
        hasContent: true, isDirty: false, isUntitled: false,
      },
      settings: {},
    })
    expect(evaluateEnabledWhen(
      "currentTab.kind == 'markdown' || currentTab.kind == 'html'", c
    )).toBe(true)
  })
  it('== against null currentTab returns false', () => {
    const c = ctx({ currentTab: null, settings: {} })
    expect(evaluateEnabledWhen("currentTab.kind == 'markdown'", c)).toBe(false)
  })
```

The `ctx` helper already exists in this test file; the new `kind` field will need to be added to the helper too. Locate the existing `ctx` helper (top of file) and add `kind` to its `currentTab` shape — minimal patch:

```ts
function ctx(o: Partial<EnabledWhenContext>): EnabledWhenContext {
  return {
    currentTab: o.currentTab ?? null,
    settings: o.settings ?? {},
  }
}
```

(No change needed if it already passes through.) Update existing literal `currentTab` blocks in this file to include `kind: 'markdown'` (or the appropriate value) — search/replace `extension: 'md',` → `extension: 'md', kind: 'markdown',` etc., as needed to satisfy the type check.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm -s test src/lib/plugins/enabled-when.test.ts`
Expected: 5 new tests fail (parser throws on `==`).

- [ ] **Step 4: Add `==` / `!=` to tokenizer**

In `src/lib/plugins/enabled-when.ts`, locate the `Token` union and `tokenize` function. Update both:

```ts
type Token =
  | { kind: 'sym'; value: '(' | ')' | '!' | '&&' | '||' | '.' | '[' | ']' | '==' | '!=' }
  | { kind: 'ident'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'eof' }
```

Inside `tokenize`, replace the `c === '!'` branch with:

```ts
    if (c === '!' && src[i + 1] === '=') { out.push({ kind: 'sym', value: '!=' }); i += 2; continue }
    if (c === '!') { out.push({ kind: 'sym', value: '!' }); i++; continue }
    if (c === '=' && src[i + 1] === '=') { out.push({ kind: 'sym', value: '==' }); i += 2; continue }
```

(The `!=` rule must come BEFORE the bare `!` rule so two-char wins.)

- [ ] **Step 5: Add `cmp` AST node + `parseCompare` parser layer**

In the same file, extend the `Node` union:

```ts
type Node =
  | { kind: 'lit'; value: boolean }
  | { kind: 'str'; value: string }
  | { kind: 'path'; segments: PathSegment[] }
  | { kind: 'not'; inner: Node }
  | { kind: 'and'; left: Node; right: Node }
  | { kind: 'or';  left: Node; right: Node }
  | { kind: 'cmp'; op: '==' | '!='; left: Node; right: Node }
```

In the `Parser` class, slot a new compare-precedence layer between `parseAnd` and `parseUnary`. Replace the existing `parseAnd` body:

```ts
  private parseAnd(): Node {
    let left = this.parseCompare()
    while (this.peekSym('&&')) {
      this.consume()
      const right = this.parseCompare()
      left = { kind: 'and', left, right }
    }
    return left
  }

  private parseCompare(): Node {
    const left = this.parseUnary()
    if (this.peekSym('==') || this.peekSym('!=')) {
      const op = (this.consume() as Extract<Token, { kind: 'sym' }>).value as '==' | '!='
      const right = this.parseUnary()
      return { kind: 'cmp', op, left, right }
    }
    return left
  }
```

Then accept string-literal atoms in `parseAtom` — add this branch right after the `lit` branch:

```ts
    if (t.kind === 'string') {
      this.consume()
      return { kind: 'str', value: t.value }
    }
```

- [ ] **Step 6: Wire `cmp` and `str` into the evaluator**

Replace `evalRaw` in `src/lib/plugins/enabled-when.ts`:

```ts
function evalRaw(node: Node, ctx: EnabledWhenContext): unknown {
  if (node.kind === 'path') return lookup(ctx, node.segments)
  if (node.kind === 'str')  return node.value
  if (node.kind === 'lit')  return node.value
  return evalNode(node, ctx)
}
```

Extend the `evalNode` switch (add the two new arms):

```ts
function evalNode(node: Node, ctx: EnabledWhenContext): boolean {
  switch (node.kind) {
    case 'lit': return node.value
    case 'str': return node.value.length > 0
    case 'path': return truthy(lookup(ctx, node.segments))
    case 'not': return !evalNode(node.inner, ctx)
    case 'and': return evalNode(node.left, ctx) && evalNode(node.right, ctx)
    case 'or':  return evalNode(node.left, ctx) || evalNode(node.right, ctx)
    case 'cmp': {
      const l = evalRaw(node.left, ctx)
      const r = evalRaw(node.right, ctx)
      const eq = l === r || (l == null && r == null)
      return node.op === '==' ? eq : !eq
    }
  }
}
```

- [ ] **Step 7: Run tests to verify pass**

Run: `pnpm -s test src/lib/plugins/enabled-when.test.ts`
Expected: all tests pass.

- [ ] **Step 8: Run full check**

Run: `pnpm -s check 2>&1 | grep -E '^(src/lib/plugins/enabled-when\.ts|src/lib/plugins/enabled-when\.test\.ts|src/lib/plugins/types\.ts):' || echo "clean for this task's files"`
Expected: prints `clean for this task's files`. Other files in the repo may have type errors that fan out from the new `kind` field on `EnabledWhenContext.currentTab`; those are addressed by Task 9. Don't fix them here.

- [ ] **Step 9: Commit**

```bash
git add src/lib/plugins/enabled-when.ts src/lib/plugins/enabled-when.test.ts src/lib/plugins/types.ts
git commit -m "feat(plugins): enabled_when grammar adds == / != comparisons"
```

---

## Task 2: Plugin types — `PromptSpec`, `tab.kind`, `tab.title`, `output_path`

**Files:**
- Modify: `src/lib/plugins/types.ts`
- Modify: `src/lib/plugins/registry.ts`

Type-only / validator changes that the rest of the plan depends on. No runtime behaviour change yet.

- [ ] **Step 1: Edit `src/lib/plugins/types.ts`**

Task 1 already added `TabKind` and the `kind` field on `EnabledWhenContext.currentTab`. Add the remaining types now.

Add `PromptSpec` (just above `MenuEntry`):

```ts
export interface PromptSpec {
  kind: 'save-dialog'
  default_filename: string
  filters: Array<{ name: string; extensions: string[] }>
}
```

Replace `MenuEntry` to add the optional `prompt` field:

```ts
export interface MenuEntry {
  location: 'file' | 'edit' | 'view' | 'window' | 'help' | 'plugins'
  label: string
  shortcut?: string
  command: string
  enabled_when?: string
  prompt?: PromptSpec
}
```

Replace `RequestContextTab` to add `kind` and `title` (required, no `?`):

```ts
export interface RequestContextTab {
  path: string | null
  filename: string | null
  extension: string | null
  kind: TabKind
  title: string
  is_dirty: boolean
  is_untitled: boolean
}
```

Replace `PluginRequest['context']` definition (still part of the same `PluginRequest`) to add `output_path`:

```ts
export interface PluginRequest {
  command: string
  context: {
    tab: RequestContextTab
    rendered_html?: string
    raw_content?: string
    output_path?: string
  }
  settings?: Record<string, unknown>
  host_version: string
  plugin_api_version: 1
}
```

- [ ] **Step 2: `registry.ts` — pass-through `prompt` validation**

Locate `validateManifest` in `src/lib/plugins/registry.ts`. After the existing settings validation, add `menus[].prompt` validation. Insert before the final `return { ok: true, … }`:

```ts
  if (Array.isArray(o.menus)) {
    for (const me of o.menus) {
      const mr = me as Record<string, unknown>
      if (mr.prompt != null) {
        const p = mr.prompt as Record<string, unknown>
        if (p.kind !== 'save-dialog')
          return { ok: false, error: `unsupported prompt.kind: ${String(p.kind)}` }
        if (typeof p.default_filename !== 'string' || p.default_filename.length === 0)
          return { ok: false, error: 'prompt.default_filename required' }
        if (!Array.isArray(p.filters))
          return { ok: false, error: 'prompt.filters must be an array' }
      }
    }
  }
```

- [ ] **Step 3: Type check**

Run: `pnpm -s check`
Expected: a handful of type errors elsewhere (callers of `RequestContextTab`, `EnabledWhenContext.currentTab`). They will be fixed by later tasks. Note them and **proceed** — we only need this task's added types to compile in isolation. If `pnpm check` fails on files this task didn't touch, it's the expected fan-out and the **next task fixes it**.

The acceptance gate for this task is: `src/lib/plugins/types.ts` and `src/lib/plugins/registry.ts` themselves type-check (no errors in those two files alone).

Run: `pnpm -s check 2>&1 | grep -E '^(src/lib/plugins/types\.ts|src/lib/plugins/registry\.ts):' || echo "clean"`
Expected: prints `clean`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/plugins/types.ts src/lib/plugins/registry.ts
git commit -m "feat(plugins): types add PromptSpec, tab.kind, tab.title, output_path"
```

---

## Task 3: `host-render-html.ts` — shared markdown→HTML pipeline

**Files:**
- Create: `src/lib/plugins/host-render-html.ts`
- Create: `src/lib/plugins/host-render-html.test.ts`

Pure helpers + the renderTabBody/inlineImages pipeline pulled out so share + md2pdf share one Marked instance, one image-inline impl, one set of utility functions.

- [ ] **Step 1: Write failing tests for pure helpers**

Create `src/lib/plugins/host-render-html.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  htmlEscape,
  extractH1FromMarkdown,
  buildPdfTitle,
  hasMathContent,
} from './host-render-html'

describe('htmlEscape', () => {
  it('escapes the four critical characters', () => {
    expect(htmlEscape('a&b<c>d"e')).toBe('a&amp;b&lt;c&gt;d&quot;e')
  })
  it('passes ASCII through unchanged', () => {
    expect(htmlEscape('plain text 123')).toBe('plain text 123')
  })
})

describe('extractH1FromMarkdown', () => {
  it('returns the first H1 text', () => {
    expect(extractH1FromMarkdown('# Hello\n\nbody')).toBe('Hello')
  })
  it('skips leading whitespace and returns null when missing', () => {
    expect(extractH1FromMarkdown('\n\nNo heading here')).toBeNull()
  })
  it('strips trailing closing #s', () => {
    expect(extractH1FromMarkdown('# Title ##')).toBe('Title')
  })
  it('does NOT recognise setext (===)', () => {
    expect(extractH1FromMarkdown('Title\n===')).toBeNull()
  })
})

describe('buildPdfTitle', () => {
  it('uses H1 when present in markdown tab', () => {
    expect(buildPdfTitle({
      kind: 'markdown', currentContent: '# H1\nbody', filePath: '/tmp/foo.md',
    } as any)).toBe('H1')
  })
  it('falls back to basename without extension', () => {
    expect(buildPdfTitle({
      kind: 'markdown', currentContent: 'no heading', filePath: '/tmp/foo.md',
    } as any)).toBe('foo')
  })
  it('falls back to dotfile basename intact', () => {
    expect(buildPdfTitle({
      kind: 'markdown', currentContent: '', filePath: '/proj/.env',
    } as any)).toBe('.env')
  })
  it('uses basename for html tab (H1 ignored even if present in body)', () => {
    expect(buildPdfTitle({
      kind: 'html', currentContent: '<h1>X</h1>', filePath: '/tmp/page.html',
    } as any)).toBe('page')
  })
})

describe('hasMathContent', () => {
  it('detects $ inline math', () => {
    expect(hasMathContent('cost is $E=mc^2$ in physics')).toBe(true)
  })
  it('detects $$ display math', () => {
    expect(hasMathContent('text\n$$\\int_0^1 x dx$$\n')).toBe(true)
  })
  it('detects \\(...\\)', () => {
    expect(hasMathContent('inline \\(a+b\\)')).toBe(true)
  })
  it('returns false for plain prose', () => {
    expect(hasMathContent('no math here, just words.')).toBe(false)
  })
  it('returns false for prose with isolated dollar signs', () => {
    expect(hasMathContent('cost is $5 today')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm -s test src/lib/plugins/host-render-html.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement pure helpers + renderTabBody**

Create `src/lib/plugins/host-render-html.ts`:

```ts
import { basename } from '../fs'
import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'
import type { Tab } from '../tabs.svelte'

export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function extractH1FromMarkdown(md: string): string | null {
  const match = md.match(/^[ \t]*#[ \t]+(.+?)[ \t#]*$/m)
  return match ? match[1].trim() : null
}

export function buildPdfTitle(tab: Tab): string {
  if (tab.kind === 'markdown') {
    const h1 = extractH1FromMarkdown(tab.currentContent)
    if (h1) return h1
  }
  const base = basename(tab.filePath)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

export function hasMathContent(md: string): boolean {
  if (/\$[^\$\n]+\$/.test(md)) return true
  if (/\$\$[\s\S]+?\$\$/.test(md)) return true
  if (/\\\([\s\S]+?\\\)/.test(md)) return true
  if (/\\\[[\s\S]+?\\\]/.test(md)) return true
  return false
}

const sharedMarked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: string, lang: string): string {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      return hljs.highlight(code, { language }).value
    },
  }),
  markedKatex({ throwOnError: false }),
)

export async function renderTabBody(tab: Tab): Promise<string> {
  if (tab.kind === 'html') return tab.currentContent
  if (tab.kind === 'code') {
    const lang = tab.language && hljs.getLanguage(tab.language) ? tab.language : 'plaintext'
    const highlighted = hljs.highlight(tab.currentContent, { language: lang }).value
    return `<pre><code class="hljs language-${htmlEscape(lang)}">${highlighted}</code></pre>`
  }
  return await sharedMarked.parse(tab.currentContent, { async: true })
}
```

- [ ] **Step 4: Verify the helper tests pass**

Run: `pnpm -s test src/lib/plugins/host-render-html.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Add image inline + diagram render to the module**

Append to `src/lib/plugins/host-render-html.ts`:

```ts
type ImageReader = (absolutePath: string) => Promise<Uint8Array>

function mimeFromExt(p: string): string {
  const lower = p.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  return 'application/octet-stream'
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function resolveImagePath(src: string, tabPath: string): string | null {
  if (/^(https?:|data:|mailto:)/i.test(src)) return null
  let p = src
  if (p.startsWith('file://')) {
    try {
      const u = new URL(p)
      p = decodeURIComponent(u.pathname)
    } catch {
      return null
    }
  }
  if (p.startsWith('/')) return p
  return `${dirname(tabPath)}/${p}`.replace(/\/\.\//g, '/')
}

export async function inlineImages(
  html: string,
  tabPath: string | null,
  reader: ImageReader,
): Promise<string> {
  if (!tabPath) return html
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return html
  const imgs = Array.from(root.querySelectorAll('img'))
  for (const img of imgs) {
    const src = img.getAttribute('src') ?? ''
    if (!src) continue
    if (/^(https?:|data:|mailto:)/i.test(src)) continue
    const abs = resolveImagePath(src, tabPath)
    if (!abs) continue
    try {
      const bytes = await reader(abs)
      const mime = mimeFromExt(abs)
      img.setAttribute('src', `data:${mime};base64,${bytesToBase64(bytes)}`)
    } catch {
      const alt = img.getAttribute('alt')?.trim() || '[image]'
      const em = doc.createElement('em')
      em.textContent = alt
      img.replaceWith(em)
    }
  }
  return root.innerHTML
}

let testImageReader: ImageReader | null = null
export function __setImageReaderForTests(r: ImageReader | null): void {
  testImageReader = r
}

async function realImageReader(absolutePath: string): Promise<Uint8Array> {
  const { readFile } = await import('@tauri-apps/plugin-fs')
  return readFile(absolutePath)
}

function pickImageReader(): ImageReader {
  return testImageReader ?? realImageReader
}

async function renderDiagramsToString(html: string): Promise<string> {
  const { renderDiagrams } = await import('../diagram-render')
  const staging = document.createElement('div')
  staging.setAttribute(
    'style',
    'position:absolute;left:-10000px;top:0;width:800px;visibility:hidden;',
  )
  staging.innerHTML = html
  document.body.appendChild(staging)
  try {
    await renderDiagrams(staging)
    return staging.innerHTML
  } finally {
    staging.remove()
  }
}

/**
 * Render a tab to inline-body HTML, with images inlined as data URIs and
 * mermaid/graphviz blocks rendered to inline SVG. Returns just the body —
 * no <!doctype>, no <head>, no wrapping. Caller (share / md2pdf) wraps as
 * needed.
 */
export async function renderTabAsInlineBody(tab: Tab): Promise<string> {
  const body = await renderTabBody(tab)
  const inlined = await inlineImages(body, tab.filePath, pickImageReader())
  return await renderDiagramsToString(inlined)
}
```

- [ ] **Step 6: Add inlineImages tests**

Append to `src/lib/plugins/host-render-html.test.ts`:

```ts
import { inlineImages, __setImageReaderForTests } from './host-render-html'

describe('inlineImages', () => {
  beforeEach(() => __setImageReaderForTests(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])))
  afterEach(() => __setImageReaderForTests(null))

  it('replaces relative-path <img> with data: URL', async () => {
    const html = '<p><img src="./foo.png" alt="x"></p>'
    const out = await inlineImages(html, '/Users/bruce/notes/doc.md', async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    expect(out).toMatch(/data:image\/png;base64,[A-Za-z0-9+/=]+/)
  })
  it('leaves https:// images untouched', async () => {
    const html = '<p><img src="https://x.test/a.png"></p>'
    const out = await inlineImages(html, '/foo/bar.md', async () => new Uint8Array())
    expect(out).toContain('https://x.test/a.png')
    expect(out).not.toContain('data:')
  })
  it('replaces unreadable image with <em>alt</em>', async () => {
    const html = '<p><img src="./missing.png" alt="oops"></p>'
    const out = await inlineImages(html, '/x.md', async () => { throw new Error('enoent') })
    expect(out).toContain('<em>oops</em>')
  })
  it('returns input unchanged when tabPath is null', async () => {
    const html = '<p><img src="./x.png"></p>'
    const out = await inlineImages(html, null, async () => new Uint8Array())
    expect(out).toBe(html)
  })
})
```

Add the missing imports at the top of the test file (immediately after the existing import line):

```ts
import { beforeEach, afterEach } from 'vitest'
```

- [ ] **Step 7: Verify all tests pass**

Run: `pnpm -s test src/lib/plugins/host-render-html.test.ts`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/plugins/host-render-html.ts src/lib/plugins/host-render-html.test.ts
git commit -m "feat(plugins): add host-render-html shared markdown→inline-body pipeline"
```

---

## Task 4: `prompt.ts` — save-dialog filename template

**Files:**
- Create: `src/lib/plugins/prompt.ts`
- Create: `src/lib/plugins/prompt.test.ts`

Pure utility: render `{stem}.pdf` against an active-tab path.

- [ ] **Step 1: Write failing tests**

Create `src/lib/plugins/prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderFilenameTemplate } from './prompt'

describe('renderFilenameTemplate', () => {
  it('expands {stem}.pdf', () => {
    expect(renderFilenameTemplate('{stem}.pdf', '/Users/bruce/notes/foo.md')).toBe('foo.pdf')
  })
  it('expands {basename}', () => {
    expect(renderFilenameTemplate('{basename}.bak', '/x/foo.md')).toBe('foo.md.bak')
  })
  it('expands {ext}', () => {
    expect(renderFilenameTemplate('archive.{ext}.gz', '/p/file.tar')).toBe('archive.tar.gz')
  })
  it('expands {dir}', () => {
    expect(renderFilenameTemplate('{dir}/x.pdf', '/Users/bruce/notes/foo.md')).toBe('/Users/bruce/notes/x.pdf')
  })
  it('keeps unknown placeholders as literal', () => {
    expect(renderFilenameTemplate('a-{wat}-b', '/x/foo.md')).toBe('a-{wat}-b')
  })
  it('treats dotfile as stemless basename', () => {
    expect(renderFilenameTemplate('{stem}.pdf', '/proj/.env')).toBe('.env.pdf')
  })
  it('falls back to "untitled" when filePath is null', () => {
    expect(renderFilenameTemplate('{stem}.pdf', null)).toBe('untitled.pdf')
  })
  it('falls back when filePath is empty string', () => {
    expect(renderFilenameTemplate('{stem}.pdf', '')).toBe('untitled.pdf')
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm -s test src/lib/plugins/prompt.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `renderFilenameTemplate`**

Create `src/lib/plugins/prompt.ts`:

```ts
import { basename } from '../fs'

/**
 * Render a `default_filename` template string against the active tab path.
 * Supported placeholders:
 *   {basename}  - filename including extension (e.g. "foo.md")
 *   {stem}      - basename minus the last extension; dotfiles keep their full name
 *   {ext}       - the last extension (no dot); empty for files with no extension
 *   {dir}       - parent directory (no trailing slash); "/" for root paths
 *
 * Unknown placeholders are kept verbatim (no errors thrown).
 *
 * When `filePath` is null or empty, all placeholders fall back to a synthetic
 * "untitled" path so the user still sees a sensible default.
 */
export function renderFilenameTemplate(template: string, filePath: string | null): string {
  const path = filePath && filePath.length > 0 ? filePath : '/untitled'

  const base = basename(path)
  const dot = base.lastIndexOf('.')
  const stem = dot <= 0 ? base : base.slice(0, dot)
  const ext  = dot <= 0 ? '' : base.slice(dot + 1)
  const slash = path.lastIndexOf('/')
  const dir  = slash <= 0 ? '/' : path.slice(0, slash)

  return template.replace(/\{(basename|stem|ext|dir)\}/g, (_, name) => {
    switch (name) {
      case 'basename': return base
      case 'stem':     return stem
      case 'ext':      return ext
      case 'dir':      return dir
      default:         return `{${name}}`  // unreachable due to regex group
    }
  })
}
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm -s test src/lib/plugins/prompt.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/prompt.ts src/lib/plugins/prompt.test.ts
git commit -m "feat(plugins): prompt.ts renders save-dialog filename templates"
```

---

## Task 5: switch `share-baker.ts` to `host-render-html.ts`

**Files:**
- Modify: `src/lib/plugins/share-baker.ts`

The pipeline (marked + KaTeX + hljs + diagrams + image inline) and `htmlEscape` already exist in `host-render-html.ts`. Drop share's local copy; import instead. **Behaviour must be identical** — share keeps its own viewport meta, theme CSS, header/footer wrapping. Verify via the existing share tests.

- [ ] **Step 1: Edit `src/lib/plugins/share-baker.ts`**

Replace the imports block at the top:

```ts
import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'
import type { Tab } from '../tabs.svelte'
import { htmlEscape } from '../pdf-export'
import katexCss from 'katex/dist/katex.min.css?raw'
import hljsLightCss from 'highlight.js/styles/github.css?raw'
import hljsDarkCss from 'highlight.js/styles/github-dark.css?raw'
import { basename } from '../fs'
```

with:

```ts
import type { Tab } from '../tabs.svelte'
import { basename } from '../fs'
import {
  htmlEscape,
  renderTabAsInlineBody,
  __setImageReaderForTests as __setSharedImageReader,
} from './host-render-html'
import katexCss from 'katex/dist/katex.min.css?raw'
import hljsLightCss from 'highlight.js/styles/github.css?raw'
import hljsDarkCss from 'highlight.js/styles/github-dark.css?raw'
```

(note `basename` already imported in original file, line 1; preserve.)

- [ ] **Step 2: Delete the local marked/inline/diagram code**

Delete the following blocks from `src/lib/plugins/share-baker.ts`:

- The `const shareMarked = new Marked(...)` declaration and its argument block.
- The `type ImageReader = …` line, `mimeFromExt`, `bytesToBase64`, `dirname`, `resolveImagePath`, `inlineImages`, `let testImageReader`, `__setImageReaderForTests`, `realImageReader`, `pickImageReader` declarations.
- `renderDiagramsToString` and `renderTabBody` declarations.

Re-export the shared image-reader override under the existing local name to keep tests passing:

```ts
export const __setImageReaderForTests = __setSharedImageReader
```

- [ ] **Step 3: Replace the `bakeShareHtml` body**

Replace the existing `bakeShareHtml` function with one that uses the shared pipeline:

```ts
export async function bakeShareHtml(tab: Tab): Promise<string> {
  // Guard raw content size before running the rendering pipeline to avoid
  // stack overflows in the markdown parser on pathologically large inputs.
  const rawBytes = new TextEncoder().encode(tab.currentContent).byteLength
  if (rawBytes > MAX_HTML_BYTES) throw new Error(`share_too_large:${rawBytes}`)

  const inlineBody = await renderTabAsInlineBody(tab)
  const title = htmlEscape(shareHeaderLabel(tab.filePath))
  const date = isoDateStamp()
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${viewportMetaTag()}
<title>${title}</title>
<style>${katexCss}</style>
<style>${hljsLightCss}</style>
<style>@media (prefers-color-scheme: dark) { ${hljsDarkCss} }</style>
<style>${themeCssBlock()}</style>
</head>
<body>
<div class="share-shell">
<header class="share-header">${title} · ${date}</header>
<main>${inlineBody}</main>
<footer class="share-footer">Powered by <a href="https://github.com/wizlijun/MdEditor">M↓</a></footer>
</div>
</body>
</html>`
  guardSize(html)
  return html
}
```

- [ ] **Step 4: Run share-baker tests**

Run: `pnpm -s test src/lib/plugins/share-baker.test.ts`
Expected: all existing tests pass (no behavioural change).

- [ ] **Step 5: Run full test suite**

Run: `pnpm -s test`
Expected: all suites green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/plugins/share-baker.ts
git commit -m "refactor(plugins): share-baker delegates rendering to host-render-html"
```

---

## Task 6: settings — `plugins.enabled.<id>` accessors

**Files:**
- Modify: `src/lib/settings.svelte.ts`
- Modify: `src/lib/settings.test.ts`

Add typed read/write helpers.

- [ ] **Step 1: Read the existing accessor pattern**

Run: `grep -n 'getPluginScopedAll\|mergePluginScoped' src/lib/settings.svelte.ts`
Note the surrounding code; the new helpers go directly below them.

- [ ] **Step 2: Write failing tests**

Append to `src/lib/settings.test.ts` (or create new tests if no plugin tests exist there). Add at end of file:

```ts
import {
  setPluginEnabled,
  isPluginEnabled,
} from './settings.svelte'

describe('plugins.enabled', () => {
  it('returns true for a plugin not in the map (default-on)', () => {
    expect(isPluginEnabled('newplugin')).toBe(true)
  })
  it('round-trips a disabled plugin', async () => {
    await setPluginEnabled('foo', false)
    expect(isPluginEnabled('foo')).toBe(false)
    await setPluginEnabled('foo', true)
    expect(isPluginEnabled('foo')).toBe(true)
  })
})
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `pnpm -s test src/lib/settings.test.ts`
Expected: `setPluginEnabled` / `isPluginEnabled` not exported.

- [ ] **Step 4: Implement the helpers**

In `src/lib/settings.svelte.ts`, add at the bottom of the file:

```ts
const PLUGINS_ENABLED_PREFIX = 'plugins.enabled.'

/**
 * Whether the given plugin id is enabled. Default-on: a plugin not present
 * in the settings map is treated as enabled (so newly bundled plugins are
 * usable on first launch without migration).
 */
export function isPluginEnabled(pluginId: string): boolean {
  const key = `${PLUGINS_ENABLED_PREFIX}${pluginId}`
  const v = (settings as unknown as Record<string, unknown>)[key]
  if (v === undefined) return true
  return v === true
}

export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  const key = `${PLUGINS_ENABLED_PREFIX}${pluginId}`
  ;(settings as unknown as Record<string, unknown>)[key] = enabled
  await saveSettings()
}
```

If the existing `settings` store is structured (e.g. a typed object) rather than a flat map, store the `plugins.enabled` map under a typed `plugins` key instead. Inspect the file before deciding; the principle is: the on-disk JSON ends up with `{ "plugins": { "enabled": { "foo": false } } }`.

- [ ] **Step 5: Verify tests pass**

Run: `pnpm -s test src/lib/settings.test.ts`
Expected: new tests pass; existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/settings.svelte.ts src/lib/settings.test.ts
git commit -m "feat(settings): plugins.enabled.<id> accessors (default-on)"
```

---

## Task 7: Rust `plugin_host.rs` — `prompt`, enabled filter, `get_all_plugin_manifests`

**Files:**
- Modify: `src-tauri/src/plugin_host.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tests/plugin_host.rs` (if exists; otherwise create)

Three changes: parse `prompt` into the manifest struct so the frontend sees it (Tauri serializes the struct verbatim); split STATE into "enabled" (driving menus etc.) and "all" (for the Plugins UI); register `get_all_plugin_manifests`.

- [ ] **Step 1: Add `Prompt` types to plugin_host.rs**

Edit `src-tauri/src/plugin_host.rs`. After the `MenuEntry` struct, insert:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptSpec {
    pub kind: String,                           // "save-dialog" only in v1
    pub default_filename: String,
    pub filters: Vec<PromptFilter>,
}
```

Update `MenuEntry`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MenuEntry {
    pub location: String,
    pub label: String,
    #[serde(default)]
    pub shortcut: Option<String>,
    pub command: String,
    #[serde(default)]
    pub enabled_when: Option<String>,
    #[serde(default)]
    pub prompt: Option<PromptSpec>,
}
```

- [ ] **Step 2: Split STATE into `enabled` + `all`**

Replace the `State` struct and the `STATE` static:

```rust
#[derive(Debug, Default)]
struct State {
    /// Manifests the host considers active (passed plugins.enabled filter).
    /// Drives menu registration, settings tabs, invocation lookups.
    enabled: HashMap<String, (PluginManifest, PathBuf)>,
    /// Every manifest discovered on disk (including disabled). Used only
    /// by the Preferences "Plugins" tab to render the on/off list.
    all: Vec<PluginManifest>,
}
```

Update `init` to read `plugins.enabled.<id>` from the settings file before assigning:

```rust
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let plugins_dir = match app.path().resource_dir() {
        Ok(rd) => rd.join("plugins"),
        Err(e) => { eprintln!("[plugin_host] resource_dir failed: {e}"); return; }
    };
    if !plugins_dir.exists() { return }

    let entries = match std::fs::read_dir(&plugins_dir) {
        Ok(e) => e,
        Err(e) => { eprintln!("[plugin_host] read_dir {:?}: {e}", plugins_dir); return; }
    };

    let enabled_map = read_enabled_map(app);

    let mut state = STATE.write().unwrap();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() { continue }
        let manifest_path = dir.join("manifest.json");
        if !manifest_path.exists() { continue }

        let bytes = match std::fs::read(&manifest_path) {
            Ok(b) => b,
            Err(e) => { eprintln!("[plugin_host] read {:?}: {e}", manifest_path); continue }
        };
        let manifest: PluginManifest = match serde_json::from_slice(&bytes) {
            Ok(m) => m,
            Err(e) => { eprintln!("[plugin_host] parse {:?}: {e}", manifest_path); continue }
        };

        // Always record the manifest in the "all" list.
        state.all.push(manifest.clone());

        // Default-on rule: missing key → enabled.
        let is_enabled = enabled_map.get(&manifest.id).copied().unwrap_or(true);
        if !is_enabled { continue }

        if state.enabled.contains_key(&manifest.id) {
            eprintln!("[plugin_host] duplicate id '{}' — keeping first", manifest.id);
            continue
        }
        state.enabled.insert(manifest.id.clone(), (manifest, dir));
    }
}

/// Read `plugins.enabled.<id>: bool` map from settings.json. Best-effort —
/// any error returns an empty map so all plugins fall through to the
/// default-on rule.
fn read_enabled_map<R: Runtime>(app: &AppHandle<R>) -> HashMap<String, bool> {
    let path = match app.path().app_config_dir() {
        Ok(p) => p.join("settings.json"),
        Err(_) => return HashMap::new(),
    };
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    let v: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    let mut out = HashMap::new();
    // Two storage shapes accepted: nested `plugins.enabled.<id>` object,
    // or flat `"plugins.enabled.<id>"` keys at the top level.
    if let Some(obj) = v.get("plugins").and_then(|p| p.get("enabled")).and_then(|e| e.as_object()) {
        for (k, vv) in obj { if let Some(b) = vv.as_bool() { out.insert(k.clone(), b); } }
    }
    if let Some(top) = v.as_object() {
        for (k, vv) in top {
            if let Some(rest) = k.strip_prefix("plugins.enabled.") {
                if let Some(b) = vv.as_bool() { out.insert(rest.to_string(), b); }
            }
        }
    }
    out
}
```

- [ ] **Step 3: Replace existing reads of `state.plugins`**

Find every `state.plugins` reference in `plugin_host.rs` and rename to `state.enabled`. Specifically:

- `get_plugin_manifests` — return `state.enabled.values()...`
- `invoke_plugin` — look up in `state.enabled`
- `collect_top_menu_items` — iterate `state.enabled`
- `init_from` (test helper) — assign to `state.enabled` (also clear `state.all` and refill it)

For `init_from`, also clear and refill `state.all`:

```rust
pub fn init_from(plugins_dir: &PathBuf) -> usize {
    let mut state = STATE.write().unwrap();
    state.enabled.clear();
    state.all.clear();
    let entries = match std::fs::read_dir(plugins_dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() { continue }
        let manifest_path = dir.join("manifest.json");
        if !manifest_path.exists() { continue }
        let bytes = match std::fs::read(&manifest_path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let manifest: PluginManifest = match serde_json::from_slice(&bytes) {
            Ok(m) => m,
            Err(_) => continue,
        };
        state.all.push(manifest.clone());
        if state.enabled.contains_key(&manifest.id) { continue }
        state.enabled.insert(manifest.id.clone(), (manifest, dir));
    }
    state.enabled.len()
}
```

- [ ] **Step 4: Add `get_all_plugin_manifests` command**

After `get_plugin_manifests`, insert:

```rust
#[tauri::command]
pub fn get_all_plugin_manifests() -> Vec<PluginManifest> {
    STATE.read().unwrap().all.clone()
}
```

- [ ] **Step 5: Register the new command in `lib.rs`**

In `src-tauri/src/lib.rs`, add to the `invoke_handler` list (right after `plugin_host::invoke_plugin`):

```rust
            plugin_host::get_all_plugin_manifests,
```

- [ ] **Step 6: Verify Rust compiles and tests pass**

Run: `(cd src-tauri && cargo check)`
Expected: clean.

Run: `(cd src-tauri && cargo test --lib plugin_host)`
Expected: existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/plugin_host.rs src-tauri/src/lib.rs
git commit -m "feat(plugin_host): prompt parsing + plugins.enabled filter + get_all_plugin_manifests"
```

---

## Task 8: Preferences "Plugins" tab

**Files:**
- Create: `src/components/PluginsSettingsTab.svelte`
- Modify: `src/components/SettingsDialog.svelte`

- [ ] **Step 1: Create `PluginsSettingsTab.svelte`**

Create `src/components/PluginsSettingsTab.svelte`:

```svelte
<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { onMount } from 'svelte'
  import type { PluginManifest } from '../lib/plugins/types'
  import { isPluginEnabled, setPluginEnabled } from '../lib/settings.svelte'

  type Row = { manifest: PluginManifest; enabled: boolean }

  let rows = $state<Row[]>([])

  onMount(async () => {
    try {
      const all = await invoke<PluginManifest[]>('get_all_plugin_manifests')
      rows = all.map((m) => ({ manifest: m, enabled: isPluginEnabled(m.id) }))
    } catch (e) {
      console.warn('[PluginsSettingsTab] load:', e)
    }
  })

  async function toggle(row: Row, value: boolean) {
    row.enabled = value
    rows = [...rows]
    await setPluginEnabled(row.manifest.id, value)
  }
</script>

<div class="plugins-list">
  {#each rows as r (r.manifest.id)}
    <div class="row">
      <label class="head">
        <input type="checkbox" checked={r.enabled}
               onchange={(e) => toggle(r, (e.currentTarget as HTMLInputElement).checked)} />
        <span class="name">{r.manifest.name}</span>
        <span class="version">{r.manifest.version}</span>
      </label>
      {#if r.manifest.description}
        <p class="desc">{r.manifest.description}</p>
      {/if}
      <p class="caps">Capabilities: {r.manifest.host_capabilities.join(', ')}</p>
    </div>
  {/each}
  {#if rows.length === 0}
    <p class="empty">No plugins detected.</p>
  {/if}
  <p class="restart-note">改动需要重启 M↓ 后生效</p>
</div>

<style>
  .plugins-list { display: flex; flex-direction: column; gap: 14px; }
  .row { padding: 10px 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
  .row:last-of-type { border-bottom: 0; }
  .head { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .name { font-weight: 600; font-size: 13px; flex: 1; }
  .version { font-size: 11px; color: color-mix(in srgb, CanvasText 55%, transparent); font-family: ui-monospace, monospace; }
  .desc { margin: 4px 0 4px 22px; font-size: 12px; color: color-mix(in srgb, CanvasText 75%, transparent); line-height: 1.4; }
  .caps { margin: 0 0 0 22px; font-size: 11px; color: color-mix(in srgb, CanvasText 55%, transparent); font-family: ui-monospace, monospace; }
  .empty { font-size: 12px; color: color-mix(in srgb, CanvasText 60%, transparent); }
  .restart-note { margin-top: 12px; font-size: 11px; color: color-mix(in srgb, CanvasText 60%, transparent); }
</style>
```

- [ ] **Step 2: Wire the tab into `SettingsDialog.svelte`**

In `src/components/SettingsDialog.svelte`:

1. Add the import:
   ```ts
   import PluginsSettingsTab from './PluginsSettingsTab.svelte'
   ```

2. Change the `selectedTab` type and default:
   ```ts
   let selectedTab = $state<'core' | 'plugins' | string>('core')
   ```

3. In the `<nav class="tab-strip">` block, insert the Plugins tab as the first item (before Core):
   ```svelte
   <nav class="tab-strip">
     <button class:active={selectedTab === 'plugins'} onclick={() => selectedTab = 'plugins'}>Plugins</button>
     <button class:active={selectedTab === 'core'} onclick={() => selectedTab = 'core'}>Core</button>
     {#each pluginTabs as t (t.pluginId)}
       <button class:active={selectedTab === t.pluginId} onclick={() => selectedTab = t.pluginId}>{t.label}</button>
     {/each}
   </nav>
   ```

   Always show the strip (drop the `{#if pluginTabs.length > 0}` guard so the Plugins tab is reachable even with no plugin-contributed tabs):
   ```svelte
   <nav class="tab-strip">…as above…</nav>
   ```

4. Add the rendered branch for `selectedTab === 'plugins'` BEFORE the existing `{#if selectedTab === 'core'}` branch:

   ```svelte
   {#if selectedTab === 'plugins'}
     <PluginsSettingsTab />
   {:else if selectedTab === 'core'}
     ...existing core block unchanged...
   {:else}
     ...existing plugin tabs block unchanged...
   {/if}
   ```

- [ ] **Step 3: Run type check**

Run: `pnpm -s check`
Expected: 0 errors.

- [ ] **Step 4: Manual smoke (do this in `pnpm tauri dev`)**

```
1. Run `pnpm tauri dev`
2. Cmd+, → Plugins tab is the leftmost
3. Both `share` and (eventual) `md2pdf` are listed; description + caps visible
4. Toggle off `share` → restart M↓ → File menu has no Share items, Cmd+Shift+L unbound
5. Toggle on → restart → menu items return
```

- [ ] **Step 5: Commit**

```bash
git add src/components/PluginsSettingsTab.svelte src/components/SettingsDialog.svelte
git commit -m "feat(settings): add Plugins tab for enabling/disabling bundled plugins"
```

---

## Task 9: dispatch — handle `prompt` save dialog and `output_path`

**Files:**
- Modify: `src/lib/plugins/host.ts`
- Modify: `src/App.svelte`

When a menu dispatch lands on a manifest item with `prompt.kind === 'save-dialog'`, show the dialog before invoking; pass the chosen path through `context.output_path`. User cancel → silent return.

- [ ] **Step 1: Extend `host.ts` `BuildContextOpts` and `invokePlugin`**

In `src/lib/plugins/host.ts`:

1. Extend `BuildContextOpts`:
   ```ts
   export interface BuildContextOpts {
     htmlBaker?: (tab: TabSnapshot) => Promise<string>
     settingsReader?: (pluginId: string) => Record<string, unknown>
     outputPath?: string
   }
   ```

2. In `buildContext`, after the `renderer.html` block, append:
   ```ts
   if (opts.outputPath != null) {
     ctx.output_path = opts.outputPath
   }
   ```

3. Extend `TabSnapshot` to carry the new tab metadata the protocol now requires:
   ```ts
   export interface TabSnapshot {
     path: string | null
     filename: string | null
     extension: string | null
     kind: 'markdown' | 'html' | 'code'
     title: string
     isDirty: boolean
     isUntitled: boolean
     content: string
   }
   ```

4. In `buildContext`, populate `kind` and `title` on the request tab:
   ```ts
   const ctx: PluginRequest['context'] = {
     tab: {
       path: tab.path,
       filename: tab.filename,
       extension: tab.extension,
       kind: tab.kind,
       title: tab.title,
       is_dirty: tab.isDirty,
       is_untitled: tab.isUntitled,
     },
   }
   ```

- [ ] **Step 2: Update `host.test.ts` snapshots / fixtures**

Run: `pnpm -s test src/lib/plugins/host.test.ts`
For each test that constructs a `TabSnapshot` literal, add the two missing fields. Sample patch (apply to every literal in the file):

```ts
const tab: TabSnapshot = {
  path: '/tmp/x.md', filename: 'x.md', extension: 'md',
  kind: 'markdown', title: 'x',
  isDirty: false, isUntitled: false, content: '# x',
}
```

Re-run; expected: all green.

- [ ] **Step 3: Wire `App.svelte` dispatcher to handle `prompt`**

In `src/App.svelte`, locate the function that resolves a plugin menu event and calls `invokePlugin`. Find the manifest-lookup block and modify the dispatch path:

```ts
async function dispatchPlugin(pluginId: string, command: string): Promise<void> {
  const manifest = manifests.find((m) => m.id === pluginId)
  if (!manifest) return
  const menu = manifest.menus?.find((me) => me.command === command)
  const tab = activeTab()
  if (!tab) return

  let outputPath: string | undefined
  if (menu?.prompt?.kind === 'save-dialog') {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { renderFilenameTemplate } = await import('./lib/plugins/prompt')
    const defaultPath = renderFilenameTemplate(menu.prompt.default_filename, tab.filePath)
    const picked = await save({
      defaultPath,
      filters: menu.prompt.filters,
    })
    if (!picked) return  // user cancelled
    outputPath = picked
  }

  const snap: TabSnapshot = {
    path: tab.filePath, filename: basename(tab.filePath),
    extension: tab.filePath ? (tab.filePath.split('.').pop() ?? null) : null,
    kind: tab.kind, title: buildPdfTitle(tab),
    isDirty: tab.isDirty, isUntitled: tab.isUntitled,
    content: tab.currentContent,
  }
  const result = await invokePlugin(manifest, command, snap, {
    htmlBaker: async (t) => {
      const tabForBake = activeTab()
      if (!tabForBake) throw new Error('no tab')
      return await renderTabAsInlineBody(tabForBake)
    },
    settingsReader: (pluginId) => getPluginScopedAll(pluginId),
    outputPath,
  })
  await applyResult(manifest, result)
}
```

(Adapt to the surrounding code's existing imports / helpers; the principle is: prompt before invoke, propagate `outputPath`.)

If `App.svelte` currently calls a different entrypoint (`bakeShareHtml`) for `htmlBaker`, this is the moment to switch it to `renderTabAsInlineBody` so md2pdf and share share the same pre-rendered body. Add the import:

```ts
import { renderTabAsInlineBody, buildPdfTitle } from './lib/plugins/host-render-html'
```

- [ ] **Step 4: Type-check + smoke**

Run: `pnpm -s check`
Expected: 0 errors.

Run: `pnpm -s test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/host.ts src/App.svelte src/lib/plugins/host.test.ts
git commit -m "feat(plugins): dispatch handles save-dialog prompt and output_path"
```

---

## Task 10: md2pdf crate skeleton — `Cargo.toml`, `ipc.rs`, `template.rs`, `main.rs`

**Files:**
- Create: `md2pdf/Cargo.toml`
- Create: `md2pdf/src/main.rs`
- Create: `md2pdf/src/ipc.rs`
- Create: `md2pdf/src/template.rs`
- Create: `md2pdf/assets/pdf.css`

The CLI starts as "wrap HTML in template, write to output_path" — no actual PDF rendering yet. This isolates the IPC/template work so we can land it green before introducing AppKit code.

- [ ] **Step 1: Move `pdf.css` to the new location**

```bash
mkdir -p md2pdf/assets
git mv src/styles/pdf.css md2pdf/assets/pdf.css
```

- [ ] **Step 2: Create `md2pdf/Cargo.toml`**

```toml
[package]
name = "md2pdf"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.6"
objc2-foundation = { version = "0.3", features = [
  "NSString",
  "NSURL",
  "NSData",
  "NSError",
  "NSValue",
  "NSGeometry",
] }
objc2-app-kit = { version = "0.3", features = [
  "NSApplication",
  "NSWindow",
  "NSView",
] }
objc2-web-kit = { version = "0.3", features = [
  "WKWebView",
  "WKWebViewConfiguration",
  "WKNavigationDelegate",
  "WKNavigation",
  "WKPDFConfiguration",
  "block2",
] }
objc2-pdf-kit = { version = "0.3", features = ["PDFDocument", "PDFPage"] }
block2 = "0.6"

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

- [ ] **Step 3: Create `md2pdf/src/ipc.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Debug)]
pub struct Request {
    pub command: String,
    pub context: Context,
}

#[derive(Deserialize, Debug)]
pub struct Context {
    pub tab: Tab,
    pub rendered_html: String,
    pub output_path: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Tab {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub title: String,
}

#[derive(Serialize, Debug)]
pub struct Response {
    pub success: bool,
    pub actions: Vec<Action>,
}

#[derive(Serialize, Debug)]
#[serde(tag = "type")]
pub enum Action {
    #[serde(rename = "toast")]
    Toast {
        level: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

impl Response {
    pub fn ok(actions: Vec<Action>) -> Self { Self { success: true,  actions } }
    pub fn fail(actions: Vec<Action>) -> Self { Self { success: false, actions } }
}

pub fn toast_success(message: String) -> Action {
    Action::Toast { level: "success".into(), message, detail: None }
}
pub fn toast_error(message: String, detail: Option<String>) -> Action {
    Action::Toast { level: "error".into(), message, detail }
}
```

- [ ] **Step 4: Create `md2pdf/src/template.rs`**

```rust
const PDF_CSS: &str = include_str!("../assets/pdf.css");

pub fn wrap_html(body: &str, title: &str) -> String {
    let title = html_escape(title);
    format!(
        "<!doctype html>\n\
         <html lang=\"en\">\n\
         <head>\n\
         <meta charset=\"utf-8\">\n\
         <title>{title}</title>\n\
         <style>{PDF_CSS}</style>\n\
         </head>\n\
         <body data-pdf-title=\"{title}\">\n\
         {body}\n\
         </body>\n\
         </html>"
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
     .replace('<', "&lt;")
     .replace('>', "&gt;")
     .replace('"', "&quot;")
}
```

- [ ] **Step 5: Create a stub `md2pdf/src/main.rs`**

```rust
mod ipc;
mod template;

use std::io::{self, Read, Write};
use ipc::{Request, Response};

const PLUGIN_NAME: &str = "md2pdf";

fn main() {
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        emit(Response::fail(vec![ipc::toast_error(
            format!("❌ {PLUGIN_NAME}: 无法读取 stdin"),
            Some(e.to_string()),
        )]));
        return;
    }
    let req: Request = match serde_json::from_str(input.trim()) {
        Ok(r) => r,
        Err(e) => {
            emit(Response::fail(vec![ipc::toast_error(
                format!("❌ {PLUGIN_NAME}: 请求 JSON 解析失败"),
                Some(e.to_string()),
            )]));
            return;
        }
    };

    let resp = match req.command.as_str() {
        "export" => run_export(&req),
        other => Response::fail(vec![ipc::toast_error(
            format!("❌ {PLUGIN_NAME}: 未知命令"),
            Some(other.to_string()),
        )]),
    };
    emit(resp);
}

fn run_export(req: &Request) -> Response {
    // Stub: write the wrapped HTML to disk for now (PDF rendering arrives in Task 11).
    let html = template::wrap_html(&req.context.rendered_html, &req.context.tab.title);
    match std::fs::write(&req.context.output_path, html.as_bytes()) {
        Ok(()) => Response::ok(vec![ipc::toast_success(
            format!("✅ 已导出到 {}", req.context.output_path),
        )]),
        Err(e) => Response::fail(vec![ipc::toast_error(
            format!("❌ {PLUGIN_NAME}: 写入失败"),
            Some(e.to_string()),
        )]),
    }
}

fn emit(resp: Response) {
    let s = serde_json::to_string(&resp).expect("serialize response");
    let stdout = io::stdout();
    let mut h = stdout.lock();
    h.write_all(s.as_bytes()).expect("write stdout");
    h.write_all(b"\n").expect("write newline");
}
```

- [ ] **Step 6: Create `md2pdf/tests/smoke.rs`**

```rust
//! Spawn the built binary, hand it a Request, assert it writes a non-empty
//! file to `output_path` and reports success.

use std::process::{Command, Stdio};
use std::io::Write;

#[test]
fn happy_path_writes_a_file() {
    let bin = env!("CARGO_BIN_EXE_md2pdf");
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let out_path = tmp.path().to_str().unwrap().to_string();
    drop(tmp);  // we want the path to NOT exist when md2pdf runs

    let req = serde_json::json!({
        "command": "export",
        "context": {
            "tab": { "path": "/tmp/x.md", "filename": "x.md", "title": "X" },
            "rendered_html": "<h1>X</h1><p>hello</p>",
            "output_path": out_path,
        }
    });

    let mut child = Command::new(bin)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().expect("spawn md2pdf");
    {
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(req.to_string().as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "md2pdf exit non-zero; stderr: {}",
            String::from_utf8_lossy(&output.stderr));

    let stdout = String::from_utf8_lossy(&output.stdout);
    let v: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect(&format!("response not JSON: {stdout}"));
    assert_eq!(v["success"], true);

    let bytes = std::fs::read(&out_path).expect("output file exists");
    assert!(bytes.len() > 0);

    let _ = std::fs::remove_file(&out_path);
}
```

Add `tempfile = "3"` as a `[dev-dependencies]` entry in `md2pdf/Cargo.toml`.

- [ ] **Step 7: Verify compile + test passes**

Run: `(cd md2pdf && cargo build && cargo test)`
Expected: smoke test green.

- [ ] **Step 8: Commit**

```bash
git add md2pdf/ src/styles/  # captures both the rename and new files
git commit -m "feat(md2pdf): crate skeleton with HTML template + smoke test stub"
```

---

## Task 11: md2pdf — port the WKWebView + PDFKit pipeline as a CLI

**Files:**
- Create: `md2pdf/src/pdf.rs`
- Modify: `md2pdf/src/main.rs`

Port the existing `imp` module from `src-tauri/src/pdf.rs` into a standalone CLI form — replace Tauri's `app.run_on_main_thread` with `NSApp.run` + `NSApp.stop`, replace the `tokio::oneshot` with a sync `Rc<RefCell<…>>` since the CLI has no async runtime.

- [ ] **Step 1: Copy the existing pdf imp module**

Read `src-tauri/src/pdf.rs` thoroughly. The `imp` module body (constants, `DelegateIvars`, `NavDelegate`, `expand_to_a4_with_margins`, `merge_page_pdfs`, `NSDataToVec`) is portable verbatim. The only public function (`export_pdf` async wrapper) needs rewriting.

Create `md2pdf/src/pdf.rs`:

```rust
//! PDF generation pipeline. Same algorithm as the prior in-process
//! src-tauri/src/pdf.rs — offscreen WKWebView, evaluateJavaScript to read
//! scrollHeight, per-page createPDFWithConfiguration, PDFKit merge with
//! A4 + margin expansion. Adapted for a CLI process: NSApp::run / NSApp::stop
//! drive the runloop instead of Tauri's run_on_main_thread; a sync
//! Rc<RefCell<…>> replaces tokio::oneshot.

#![cfg(target_os = "macos")]

use std::cell::{Cell, RefCell};
use std::path::Path;
use std::rc::Rc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{class, define_class, msg_send, AnyThread, DefinedClass, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
use objc2_foundation::{
    MainThreadMarker, NSData, NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol,
    NSRect, NSString, NSURL,
};
use objc2_pdf_kit::{
    PDFDisplayBox, PDFDocument, PDFDocumentOptimizeImagesForScreenOption,
    PDFDocumentSaveImagesAsJPEGOption, PDFPage,
};
use objc2_web_kit::{
    WKNavigation, WKNavigationDelegate, WKPDFConfiguration, WKWebView, WKWebViewConfiguration,
};

/// A4 page size in PostScript points (1pt = 1/72 inch).
const A4_W: f64 = 595.0;
const A4_H: f64 = 842.0;
const MARGIN_H: f64 = 57.0;
const MARGIN_V: f64 = 71.0;
const INNER_W: f64 = A4_W - 2.0 * MARGIN_H;
const INNER_H: f64 = A4_H - 2.0 * MARGIN_V;

/// Result is written here by the navigation delegate; main() observes it
/// after NSApp::run returns.
pub type ResultCell = Rc<RefCell<Option<Result<(), String>>>>;

struct DelegateIvars {
    webview: RefCell<Option<Retained<WKWebView>>>,
    self_ref: RefCell<Option<Retained<NavDelegate>>>,
    output_path: String,
    pages: RefCell<Vec<Retained<NSData>>>,
    num_pages: Cell<usize>,
    current_page: Cell<usize>,
    result: ResultCell,
    app: Retained<NSApplication>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateIvars]
    #[name = "Md2PdfNavDelegate"]
    pub(super) struct NavDelegate;

    unsafe impl NSObjectProtocol for NavDelegate {}

    unsafe impl WKNavigationDelegate for NavDelegate {
        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish(&self, _w: &WKWebView, _n: Option<&WKNavigation>) {
            self.start_height_measurement();
        }
        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail(&self, _w: &WKWebView, _n: Option<&WKNavigation>, error: &NSError) {
            let msg = error.localizedDescription().to_string();
            self.dispatch_result(Err(format!("WKWebView navigation failed: {msg}")));
        }
        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional(
            &self,
            _w: &WKWebView,
            _n: Option<&WKNavigation>,
            error: &NSError,
        ) {
            let msg = error.localizedDescription().to_string();
            self.dispatch_result(Err(format!("WKWebView provisional navigation failed: {msg}")));
        }
    }
);

impl NavDelegate {
    fn new(
        mtm: MainThreadMarker,
        webview: Retained<WKWebView>,
        output_path: String,
        result: ResultCell,
        app: Retained<NSApplication>,
    ) -> Retained<Self> {
        let ivars = DelegateIvars {
            webview: RefCell::new(Some(webview)),
            self_ref: RefCell::new(None),
            output_path,
            pages: RefCell::new(Vec::new()),
            num_pages: Cell::new(0),
            current_page: Cell::new(0),
            result,
            app,
        };
        let this = Self::alloc(mtm).set_ivars(ivars);
        let retained: Retained<Self> = unsafe { msg_send![super(this), init] };
        *retained.ivars().self_ref.borrow_mut() = Some(retained.clone());
        retained
    }

    fn dispatch_result(&self, result: Result<(), String>) {
        *self.ivars().result.borrow_mut() = Some(result);
        let _ = self.ivars().webview.borrow_mut().take();
        let _ = self.ivars().self_ref.borrow_mut().take();
        unsafe { self.ivars().app.stop(None) };
    }

    fn start_height_measurement(&self) {
        let webview = match self.ivars().webview.borrow().as_ref() {
            Some(w) => w.clone(),
            None => { self.dispatch_result(Err("WKWebView dropped before height read".into())); return; }
        };
        let self_for_block: Retained<NavDelegate> = self
            .ivars().self_ref.borrow().as_ref()
            .expect("self_ref set before nav finish").clone();

        let block = RcBlock::new(move |result: *mut AnyObject, err: *mut NSError| {
            if !err.is_null() {
                let err_obj = unsafe { &*err };
                let msg = err_obj.localizedDescription().to_string();
                self_for_block.dispatch_result(Err(format!("evaluateJavaScript failed: {msg}")));
                return;
            }
            if result.is_null() {
                self_for_block.dispatch_result(Err("evaluateJavaScript returned no result".into()));
                return;
            }
            let number = unsafe { &*(result as *mut NSNumber) };
            let height: f64 = number.doubleValue();
            let num_pages = ((height / INNER_H as f64).ceil() as usize).max(1);
            self_for_block.ivars().num_pages.set(num_pages);
            self_for_block.ivars().current_page.set(0);
            self_for_block.capture_next_page();
        });
        let js = NSString::from_str("document.documentElement.scrollHeight");
        unsafe { webview.evaluateJavaScript_completionHandler(&js, Some(&block)); }
    }

    fn capture_next_page(&self) {
        let i = self.ivars().current_page.get();
        let n = self.ivars().num_pages.get();
        if i >= n { self.finalize(); return; }
        let webview = match self.ivars().webview.borrow().as_ref() {
            Some(w) => w.clone(),
            None => { self.dispatch_result(Err("WKWebView dropped during page capture".into())); return; }
        };
        let rect = NSRect::new(
            objc2_foundation::NSPoint::new(0.0, i as f64 * INNER_H),
            objc2_foundation::NSSize::new(INNER_W, INNER_H),
        );
        let self_for_block: Retained<NavDelegate> = self
            .ivars().self_ref.borrow().as_ref()
            .expect("self_ref set during page capture").clone();
        let block = RcBlock::new(move |data: *mut NSData, err: *mut NSError| {
            if !err.is_null() {
                let err_obj = unsafe { &*err };
                let msg = err_obj.localizedDescription().to_string();
                self_for_block.dispatch_result(Err(format!("createPDF page failed: {msg}")));
                return;
            }
            if data.is_null() {
                self_for_block.dispatch_result(Err("createPDF returned null data".into()));
                return;
            }
            let nsdata = unsafe { Retained::retain(data).expect("non-null data") };
            self_for_block.ivars().pages.borrow_mut().push(nsdata);
            self_for_block.ivars().current_page.set(i + 1);
            self_for_block.capture_next_page();
        });
        unsafe {
            let config = WKPDFConfiguration::new(self.mtm());
            config.setRect(rect);
            webview.createPDFWithConfiguration_completionHandler(Some(&config), &block);
        }
    }

    fn finalize(&self) {
        let pieces: Vec<Retained<NSData>> = self.ivars().pages.borrow_mut().drain(..).collect();
        let output_path = self.ivars().output_path.clone();
        let merged = match merge_page_pdfs(&pieces) {
            Ok(d) => d,
            Err(e) => { self.dispatch_result(Err(e)); return; }
        };
        let bytes: Vec<u8> = merged.to_vec();
        if let Err(e) = std::fs::write(&output_path, bytes) {
            self.dispatch_result(Err(format!("Failed to write PDF: {e}")));
            return;
        }
        if !Path::new(&output_path).exists() {
            self.dispatch_result(Err(format!("PDF reportedly written but no file at {output_path}")));
            return;
        }
        self.dispatch_result(Ok(()));
    }
}

fn expand_to_a4_with_margins(page: &PDFPage) {
    let new_box = NSRect::new(
        objc2_foundation::NSPoint::new(-MARGIN_H, -MARGIN_V),
        objc2_foundation::NSSize::new(A4_W, A4_H),
    );
    unsafe {
        page.setBounds_forBox(new_box, PDFDisplayBox::MediaBox);
        page.setBounds_forBox(new_box, PDFDisplayBox::CropBox);
        page.setBounds_forBox(new_box, PDFDisplayBox::BleedBox);
        page.setBounds_forBox(new_box, PDFDisplayBox::TrimBox);
        page.setBounds_forBox(new_box, PDFDisplayBox::ArtBox);
    }
}

fn merge_page_pdfs(pieces: &[Retained<NSData>]) -> Result<Retained<NSData>, String> {
    if pieces.is_empty() { return Err("no pages to merge".into()); }
    let combined = unsafe { PDFDocument::new() };
    for (idx, piece) in pieces.iter().enumerate() {
        let alloc = PDFDocument::alloc();
        let single = unsafe { PDFDocument::initWithData(alloc, piece) }
            .ok_or_else(|| format!("PDFDocument::initWithData failed for page {idx}"))?;
        let page = unsafe { single.pageAtIndex(0) }
            .ok_or_else(|| format!("page {idx} missing in single-page PDF"))?;
        expand_to_a4_with_margins(&page);
        let insert_at = unsafe { combined.pageCount() };
        unsafe { combined.insertPage_atIndex(&page, insert_at) };
    }
    let data = unsafe {
        let yes_obj: Retained<NSNumber> = NSNumber::numberWithBool(true);
        let dict_cls = class!(NSMutableDictionary);
        let dict: *mut AnyObject = msg_send![dict_cls, dictionary];
        let key1: &NSString = PDFDocumentOptimizeImagesForScreenOption;
        let key2: &NSString = PDFDocumentSaveImagesAsJPEGOption;
        let _: () = msg_send![dict, setObject: &*yes_obj, forKey: key1];
        let _: () = msg_send![dict, setObject: &*yes_obj, forKey: key2];
        let dict_ref = &*(dict as *const NSDictionary);
        combined.dataRepresentationWithOptions(dict_ref).or_else(|| combined.dataRepresentation())
    }.ok_or_else(|| "merged PDF dataRepresentation returned nil".to_string())?;
    Ok(data)
}

trait NSDataToVec { fn to_vec(&self) -> Vec<u8>; }
impl NSDataToVec for Retained<NSData> {
    fn to_vec(&self) -> Vec<u8> { (**self).to_vec() }
}

/// Render `html` to a PDF at `output_path`, blocking until done.
/// Must be called on the macOS main thread (CLI's `main` qualifies).
pub fn render_to_path(html: &str, output_path: &str) -> Result<(), String> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "render_to_path must run on the main thread".to_string())?;
    let app = NSApplication::sharedApplication(mtm);
    unsafe { app.setActivationPolicy(NSApplicationActivationPolicy::Prohibited); }

    let result: ResultCell = Rc::new(RefCell::new(None));
    let frame = NSRect::new(
        objc2_foundation::NSPoint::new(0.0, 0.0),
        objc2_foundation::NSSize::new(INNER_W, INNER_H),
    );

    unsafe {
        let config = WKWebViewConfiguration::new(mtm);
        let webview: Retained<WKWebView> = WKWebView::initWithFrame_configuration(
            WKWebView::alloc(mtm), frame, &config,
        );
        let delegate = NavDelegate::new(
            mtm, webview.clone(), output_path.to_string(), result.clone(), app.clone(),
        );
        let proto = ProtocolObject::from_ref(&*delegate);
        webview.setNavigationDelegate(Some(proto));

        let html_ns = NSString::from_str(html);
        let base_ns = NSString::from_str("file:///");
        let base_url_obj = NSURL::URLWithString(&base_ns);
        let _ = webview.loadHTMLString_baseURL(&html_ns, base_url_obj.as_deref());

        // Drop our local refs; the navigation delegate owns its self_ref.
        drop(webview);
        drop(delegate);
    }

    unsafe { app.run() };

    match result.borrow_mut().take() {
        Some(Ok(())) => Ok(()),
        Some(Err(e)) => Err(e),
        None => Err("PDF generation completed without setting a result".into()),
    }
}
```

- [ ] **Step 2: Wire `pdf::render_to_path` into `main.rs`**

Replace the existing `run_export` body in `md2pdf/src/main.rs`:

```rust
fn run_export(req: &Request) -> Response {
    let html = template::wrap_html(&req.context.rendered_html, &req.context.tab.title);
    match crate::pdf::render_to_path(&html, &req.context.output_path) {
        Ok(()) => Response::ok(vec![ipc::toast_success(
            format!("✅ 已导出到 {}", req.context.output_path),
        )]),
        Err(e) => Response::fail(vec![ipc::toast_error(
            format!("❌ {PLUGIN_NAME}: 渲染失败"),
            Some(e),
        )]),
    }
}
```

Add `mod pdf;` near the top of `main.rs` (next to `mod ipc;` and `mod template;`).

For non-macOS platforms, gate the pdf module behind cfg and surface an error:

```rust
#[cfg(target_os = "macos")] mod pdf;
#[cfg(not(target_os = "macos"))]
mod pdf {
    pub fn render_to_path(_html: &str, _path: &str) -> Result<(), String> {
        Err("md2pdf is macOS-only".into())
    }
}
```

- [ ] **Step 3: Build + run smoke test**

Run: `(cd md2pdf && cargo build --release)`
Expected: clean compile.

Run: `(cd md2pdf && cargo test --release)`
Expected: smoke test passes; `output_path` now contains a real PDF (≥ 1 KB; starts with `%PDF`).

If the smoke test still wrote raw HTML, update its assertion to verify the magic bytes:

```rust
let bytes = std::fs::read(&out_path).expect("output file exists");
assert!(bytes.len() > 1024, "PDF should be ≥ 1 KB, got {}", bytes.len());
assert!(bytes.starts_with(b"%PDF"), "expected PDF magic bytes");
```

Re-run; expected: pass.

- [ ] **Step 4: Commit**

```bash
git add md2pdf/src/pdf.rs md2pdf/src/main.rs md2pdf/tests/smoke.rs
git commit -m "feat(md2pdf): port WKWebView + PDFKit pipeline as a CLI"
```

---

## Task 12: build script + manifest + first signed binary

**Files:**
- Create: `scripts/build-md2pdf.sh`
- Create: `src-tauri/plugins/md2pdf/manifest.json`
- Create: `src-tauri/plugins/md2pdf/bin-aarch64-apple-darwin` (binary, `git add` after build)
- Create: `src-tauri/plugins/md2pdf/bin-x86_64-apple-darwin` (binary, `git add` after build)
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/build-md2pdf.sh`**

```bash
#!/usr/bin/env bash
# Build the md2pdf CLI for both macOS architectures and copy into the
# bundled plugin directory. Run before `pnpm tauri build` for release.
set -euo pipefail
cd "$(dirname "$0")/.."

# Prefer rustup-managed toolchain over any system Rust (e.g. Homebrew) that
# may be earlier in PATH and lack cross-compilation std libraries.
export PATH="$HOME/.cargo/bin:$PATH"

echo "[md2pdf] ensuring rustup targets…"
rustup target add aarch64-apple-darwin >/dev/null
rustup target add x86_64-apple-darwin >/dev/null

echo "[md2pdf] cargo build --release × 2…"
( cd md2pdf && cargo build --release --target aarch64-apple-darwin )
( cd md2pdf && cargo build --release --target x86_64-apple-darwin )

DEST="src-tauri/plugins/md2pdf"
mkdir -p "$DEST"
cp md2pdf/target/aarch64-apple-darwin/release/md2pdf "$DEST/bin-aarch64-apple-darwin"
cp md2pdf/target/x86_64-apple-darwin/release/md2pdf  "$DEST/bin-x86_64-apple-darwin"
chmod +x "$DEST"/bin-*-apple-darwin
strip      "$DEST"/bin-*-apple-darwin

# Codesign with hardened runtime + secure timestamp so Apple notarization
# accepts the binaries when they're embedded in the release .app bundle.
APPLE_TEAM_ID="${APPLE_TEAM_ID:-T5G56DH47L}"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  SIGNING_IDENTITY=$(
    security find-identity -v -p codesigning \
      | awk -F\" -v t="$APPLE_TEAM_ID" '/Developer ID Application/ && index($0,"("t")") {print $2; exit}'
  ) || true
fi
if [[ -z "$SIGNING_IDENTITY" ]]; then
  SIGNING_IDENTITY=$(
    security find-identity -v -p codesigning \
      | awk -F\" '/Developer ID Application/ {print $2; exit}'
  ) || true
fi
if [[ -n "$SIGNING_IDENTITY" ]]; then
  echo "[md2pdf] codesign with: $SIGNING_IDENTITY"
  for b in "$DEST"/bin-*-apple-darwin; do
    codesign --force --options runtime --timestamp \
      --sign "$SIGNING_IDENTITY" "$b"
  done
else
  echo "[md2pdf] WARNING: no Developer ID Application identity in keychain — binaries left unsigned (release.sh will fail notarization)"
fi

echo "[md2pdf] binaries written:"
ls -lh "$DEST"/bin-*-apple-darwin
```

Make executable:
```bash
chmod +x scripts/build-md2pdf.sh
```

- [ ] **Step 2: Add `package.json` script**

Edit `package.json`'s `"scripts"` block, add directly after `"build:mdshare"`:

```json
    "build:md2pdf": "bash scripts/build-md2pdf.sh",
```

- [ ] **Step 3: Create `src-tauri/plugins/md2pdf/manifest.json`**

```json
{
  "id": "md2pdf",
  "name": "Export to PDF",
  "version": "0.1.0",
  "description": "Export the current Markdown or HTML tab to a typographically-clean A4 PDF",
  "binary": "bin",
  "menus": [
    {
      "location": "file",
      "label": "Export to PDF…",
      "shortcut": "Cmd+Shift+E",
      "command": "export",
      "enabled_when": "currentTab.kind == 'markdown' || currentTab.kind == 'html'",
      "prompt": {
        "kind": "save-dialog",
        "default_filename": "{stem}.pdf",
        "filters": [{ "name": "PDF", "extensions": ["pdf"] }]
      }
    }
  ],
  "host_capabilities": ["renderer.html", "toast"],
  "timeout_seconds": 60
}
```

- [ ] **Step 4: Run the build**

Run: `pnpm build:md2pdf`
Expected: two signed (or warning-with-unsigned) binaries land in `src-tauri/plugins/md2pdf/`.

- [ ] **Step 5: Smoke check via `pnpm tauri dev`**

Run: `pnpm tauri dev`
Expected: app launches; File menu has "Export to PDF…" with `Cmd+Shift+E` shortcut. Open a `.md` tab, hit `Cmd+Shift+E` → save dialog → choose path → toast `✅ 已导出到 …`. Open the PDF → renders as expected.

If the menu does NOT show up: check the dev console for plugin loader errors; verify the manifest passes JSON Schema validation.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-md2pdf.sh package.json \
        src-tauri/plugins/md2pdf/manifest.json \
        src-tauri/plugins/md2pdf/bin-aarch64-apple-darwin \
        src-tauri/plugins/md2pdf/bin-x86_64-apple-darwin
git commit -m "feat(md2pdf): build script + manifest + first signed binaries"
```

---

## Task 13: drop the in-process PDF code

**Files:**
- Delete: `src-tauri/src/pdf.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`

This is the moment of truth — the main binary loses PDFKit/WebKit. md2pdf takes over. **Run a smoke test BEFORE this task** (Task 12 step 5) so a regression here is unambiguously this task's fault.

- [ ] **Step 1: Remove the static `Export to PDF…` File-menu item**

In `src-tauri/src/lib.rs`, locate the `MenuItemBuilder::with_id("export-pdf", "Export to PDF…")` chain inside `build_menu`. Delete it (and the `.separator()` directly above if it now doubles up).

After removal the `file_b` chain should look like:

```rust
    let mut file_b = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("open", "Open…").accelerator("Cmd+O").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("close-tab", "Close Tab")
                .accelerator("Cmd+W")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("save", "Save").accelerator("Cmd+S").build(app)?)
        .item(
            &MenuItemBuilder::with_id("save-as", "Save As…")
                .accelerator("Cmd+Shift+S")
                .build(app)?,
        );
    for it in plugin_items.iter().filter(|p| p.location == "file") {
```

- [ ] **Step 2: Drop the `pdf` module + Tauri command**

In `src-tauri/src/lib.rs`:

1. Delete `mod pdf;` (line 13).
2. Inside `tauri::generate_handler![…]`, delete `pdf::export_pdf,`.

- [ ] **Step 3: Delete `src-tauri/src/pdf.rs`**

```bash
git rm src-tauri/src/pdf.rs
```

- [ ] **Step 4: Drop the now-unused crate dependencies**

In `src-tauri/Cargo.toml`, replace the entire `[target.'cfg(target_os = "macos")'.dependencies]` block with the slimmed-down version (only `core-foundation` is still used, by `macos_defaults`):

```toml
[target.'cfg(target_os = "macos")'.dependencies]
core-foundation = "0.10"
```

- [ ] **Step 5: Verify Rust still compiles**

Run: `(cd src-tauri && cargo check)`
Expected: clean. If a dependency the deletion overlooked is still referenced, the compile error will name it.

- [ ] **Step 6: End-to-end smoke**

Run: `pnpm tauri dev`
Expected: editor launches; `Cmd+Shift+E` still works (now via the md2pdf plugin); PDF output identical to before.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "refactor: remove in-process PDF code (md2pdf plugin owns it now)"
```

---

## Task 14: drop `pdf-export.ts` and `cmdExportPdf`

**Files:**
- Delete: `src/lib/pdf-export.ts`
- Delete: `src/lib/pdf-export.test.ts`
- Modify: `src/lib/commands.ts`
- Modify: `src/App.svelte`

Front-end clean-up. The renderer pipeline lives in `host-render-html.ts` now; `cmdExportPdf` is unused once md2pdf owns the menu.

- [ ] **Step 1: Verify `pdf-export.ts` has no remaining importers**

Run: `grep -rn "from '.*pdf-export'" src/ src-tauri/ md2pdf/ 2>/dev/null || echo "no importers"`
Expected: only matches in the file itself / its test, plus possibly `commands.ts`.

- [ ] **Step 2: Delete `cmdExportPdf` from `src/lib/commands.ts`**

Edit `src/lib/commands.ts`:

1. Remove the import:
   ```ts
   import { exportTabAsPdf, suggestedPdfFilename } from './pdf-export'
   ```

2. Delete the entire `cmdExportPdf` function (lines 37-62 in the snapshot).

3. Remove `message` and `saveDialog` imports if `cmdExportPdf` was their only consumer. Check first:

   Run: `grep -nE 'message\(|saveDialog\(' src/lib/commands.ts`

   Drop the import lines for any name that no longer appears.

- [ ] **Step 3: Drop the `export-pdf` menu-event branch in `App.svelte`**

In `src/App.svelte`, search for `'export-pdf'` (the menu-event id). Remove the `case` / `if` branch that called `cmdExportPdf`. Drop the import of `cmdExportPdf`.

- [ ] **Step 4: Delete the source files**

```bash
git rm src/lib/pdf-export.ts src/lib/pdf-export.test.ts
```

- [ ] **Step 5: Verify type check + tests**

Run: `pnpm -s check`
Expected: 0 errors.

Run: `pnpm -s test`
Expected: all suites green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/commands.ts src/App.svelte
git commit -m "refactor: drop front-end pdf-export.ts and cmdExportPdf (md2pdf owns the path)"
```

---

## Task 15: release script + README smoke checklist

**Files:**
- Modify: `scripts/release.sh`
- Modify: `README.md`

- [ ] **Step 1: Add `pnpm build:md2pdf` to release.sh**

In `scripts/release.sh`, find the line `say "building mdshare plugin binaries"` followed by `pnpm build:mdshare`. Right after that block, insert:

```bash
say "building md2pdf plugin binaries"
pnpm build:md2pdf
```

Then locate the `git add src-tauri/plugins/share/bin-*-apple-darwin` line and append md2pdf's binaries:

```bash
git add src-tauri/plugins/share/bin-aarch64-apple-darwin \
        src-tauri/plugins/share/bin-x86_64-apple-darwin \
        src-tauri/plugins/md2pdf/bin-aarch64-apple-darwin \
        src-tauri/plugins/md2pdf/bin-x86_64-apple-darwin 2>/dev/null || true
```

- [ ] **Step 2: Verify release.sh syntax**

Run: `bash -n scripts/release.sh`
Expected: no output (script parses).

- [ ] **Step 3: Update README smoke checklist**

In `README.md`, append (after the existing item 57):

```
58. **Disable md2pdf** — Preferences → Plugins → uncheck "Export to PDF" →
    restart M↓ → File menu has no "Export to PDF…", `Cmd+Shift+E` does not
    respond.
59. **Re-enable md2pdf** — re-check → restart → menu item returns,
    `Cmd+Shift+E` works.
60. **Disable share** — same flow, just to confirm enabling works for any
    plugin (uncheck → restart → no Share items in File menu).
61. **Default-on for new plugin** — delete the `plugins.enabled` segment
    from `~/Library/Application Support/com.bruce.mdeditor/settings.json`
    → restart → both `share` and `md2pdf` are still active (default-on
    rule).
62. **md2pdf timeout** — temporarily edit `src-tauri/plugins/md2pdf/manifest.json`
    `timeout_seconds: 1`, export a sizable doc → toast `❌ md2pdf: 未响应（1s）`,
    M↓ stays responsive. Restore the manifest after the smoke test.
63. **md2pdf write failure** — try saving a PDF into a read-only directory →
    toast `❌ md2pdf: 渲染失败` (or `写入失败` depending on which step failed),
    M↓ stays responsive.
```

- [ ] **Step 4: Manual run-through**

Walk through items 58-63 by hand against a `pnpm tauri dev` build. Note any deviations.

- [ ] **Step 5: Commit**

```bash
git add scripts/release.sh README.md
git commit -m "docs(release): wire md2pdf into release.sh; expand smoke checklist"
```

---

## Self-Review Notes

After all 15 tasks, verify:

1. `grep -rn 'pdf-export' src/` returns nothing.
2. `grep -rn 'export_pdf' src-tauri/` returns nothing.
3. `grep -n 'objc2-pdf-kit\|objc2-web-kit' src-tauri/Cargo.toml` returns nothing.
4. `ls src-tauri/plugins/md2pdf/` lists `manifest.json`, `bin-aarch64-apple-darwin`, `bin-x86_64-apple-darwin`.
5. `pnpm test && pnpm check && (cd src-tauri && cargo check) && (cd md2pdf && cargo test)` all green.
6. README items 58-63 pass against `pnpm tauri dev`.
7. Preferences → Plugins lists both `share` and `md2pdf`; toggling and restarting honors the choice.
8. Disabling `md2pdf` from Preferences then restarting hides "Export to PDF…" from File menu, with `Cmd+Shift+E` un-bound.
