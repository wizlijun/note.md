# mdshare Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the share feature as the first M↓ plugin: one click bakes the active tab into a self-contained mobile-friendly HTML, ships it to a tiny Cloudflare Worker, returns a public URL.

**Architecture:** Three independent units glued by the existing plugin platform — `share-baker.ts` (host renders + inlines), `mdshare` (Rust sidecar that does slug + HTTP), Cloudflare Worker (3 routes + KV). One platform extension required (computed bracket indices in `enabled_when`).

**Tech Stack:** Svelte 5 + Tauri 2 (host), Rust + ureq + serde + time (sidecar), Cloudflare Workers + KV + TypeScript + Wrangler + Miniflare.

**Spec:** `docs/superpowers/specs/2026-05-08-mdshare-plugin-design.md`

---

## File Structure

**Create (frontend):**
- `src/lib/plugins/share-baker.ts` — host-side renderer
- `src/lib/plugins/share-baker.test.ts` — vitest tests

**Create (Rust plugin):**
- `mdshare/Cargo.toml` — separate Cargo workspace at repo root
- `mdshare/src/main.rs` — entry: read stdin, dispatch, write stdout
- `mdshare/src/ipc.rs` — Request / Response / Action serde types
- `mdshare/src/slug.rs` — slug generation + tests
- `mdshare/src/publish.rs` — POST /publish flow
- `mdshare/src/unpublish.rs` — DELETE /:slug flow
- `mdshare/src/copy_link.rs` — local clipboard.write + toast
- `mdshare/tests/integration.rs` — spawn-binary integration tests

**Create (Cloudflare Worker):**
- `worker/package.json`
- `worker/tsconfig.json`
- `worker/wrangler.toml`
- `worker/src/index.ts` — three routes
- `worker/tests/index.test.ts` — Miniflare tests
- `worker/README.md` — deployment instructions

**Create (plugin manifest + build glue):**
- `src-tauri/plugins/share/manifest.json`
- `scripts/build-mdshare.sh` — cross-compile + copy binaries

**Modify:**
- `src/lib/plugins/enabled-when.ts` — add computed bracket-index parsing/evaluation
- `src/lib/plugins/enabled-when.test.ts` — add tests
- `src/App.svelte` — pass `htmlBaker` to `invokePlugin`
- `package.json` — add `build:mdshare` script
- `README.md` — smoke checklist items 49-56

**Convention:** Each task ends with one git commit using conventional prefixes (`feat`, `feat(plugins)`, `feat(share)`, `feat(worker)`, `test`, `docs`, `chore`).

---

## Task 1: enabled-when computed bracket index

**Files:**
- Modify: `src/lib/plugins/enabled-when.ts`
- Modify: `src/lib/plugins/enabled-when.test.ts`

The current parser accepts `a["literal"]` or `a[ident]` but not `a[some.path]`. The share manifest's `enabled_when` needs `settings["share.records"][currentTab.path]` — the inner `[currentTab.path]` is a multi-segment path used as a computed lookup key.

- [ ] **Step 1: Add failing tests**

Append to `src/lib/plugins/enabled-when.test.ts` inside the existing `describe('parseEnabledWhen', …)` block:

```ts
  it('parses computed bracket index (multi-segment path)', () => {
    expect(() => parseEnabledWhen('settings["share.records"][currentTab.path]')).not.toThrow()
  })
  it('parses chained computed indices', () => {
    expect(() => parseEnabledWhen('a[b.c][d.e]')).not.toThrow()
  })
```

And inside `describe('evaluateEnabledWhen', …)`:

```ts
  it('uses inner-path value as the lookup key', () => {
    const settings = { 'share.records': { '/foo.md': { slug: 'x' } } }
    const c = ctx({
      currentTab: {
        path: '/foo.md', filename: 'foo.md', extension: 'md',
        hasContent: true, isDirty: false, isUntitled: false,
      },
      settings,
    })
    expect(evaluateEnabledWhen('settings["share.records"][currentTab.path]', c)).toBe(true)
  })
  it('returns false when computed key is not present in container', () => {
    const settings = { 'share.records': { '/other.md': { slug: 'x' } } }
    const c = ctx({
      currentTab: {
        path: '/foo.md', filename: 'foo.md', extension: 'md',
        hasContent: true, isDirty: false, isUntitled: false,
      },
      settings,
    })
    expect(evaluateEnabledWhen('settings["share.records"][currentTab.path]', c)).toBe(false)
  })
  it('returns false when inner path resolves to undefined', () => {
    const c = ctx({ currentTab: null, settings: { 'share.records': { 'x': 1 } } })
    expect(evaluateEnabledWhen('settings["share.records"][currentTab.path]', c)).toBe(false)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -s test src/lib/plugins/enabled-when.test.ts`
Expected: 5 new tests fail (parser throws on the new syntax).

- [ ] **Step 3: Update parser AST**

In `src/lib/plugins/enabled-when.ts`, change the `Node` definition for paths so segments may be a literal string OR a nested AST node. Replace the existing line:

```ts
  | { kind: 'path'; segments: string[] }
```

with:

```ts
  | { kind: 'path'; segments: PathSegment[] }
```

Add the new type alias just above the `Node` union:

```ts
type PathSegment = { kind: 'literal'; value: string } | { kind: 'computed'; node: Node }
```

- [ ] **Step 4: Update `parsePath` to wrap literals and parse computed**

In the same file, replace the existing `parsePath` implementation with:

```ts
  private parsePath(): Node {
    const segments: PathSegment[] = []
    const head = this.consume()
    if (head.kind !== 'ident') throw new Error('path must start with identifier')
    segments.push({ kind: 'literal', value: head.value })
    while (true) {
      if (this.peekSym('.')) {
        this.consume()
        const t = this.consume()
        if (t.kind !== 'ident') throw new Error('expected identifier after `.`')
        segments.push({ kind: 'literal', value: t.value })
        continue
      }
      if (this.peekSym('[')) {
        this.consume()
        const next = this.peek()
        if (next.kind === 'string') {
          this.consume()
          segments.push({ kind: 'literal', value: next.value })
        } else if (next.kind === 'ident') {
          // Multi-segment computed index — recursively parse a full path,
          // then evaluate it at lookup time and use the result as the key.
          const sub = this.parsePath()
          segments.push({ kind: 'computed', node: sub })
        } else {
          throw new Error('expected string or identifier inside `[ ]`')
        }
        this.expectSym(']')
        continue
      }
      break
    }
    return { kind: 'path', segments }
  }
```

- [ ] **Step 5: Update `lookup` evaluator**

Replace the existing `lookup` function in `src/lib/plugins/enabled-when.ts`:

```ts
function lookup(ctx: EnabledWhenContext, segments: PathSegment[]): unknown {
  let cur: unknown = ctx as unknown
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined
    let key: string
    if (seg.kind === 'literal') {
      key = seg.value
    } else {
      const v = evalNode(seg.node, ctx)
      if (v == null) return undefined
      key = String(v)
    }
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `pnpm -s test src/lib/plugins/enabled-when.test.ts`
Expected: all tests pass (existing 20 + 5 new = 25).

- [ ] **Step 7: Run full test suite + type check**

Run: `pnpm -s test && pnpm -s check`
Expected: 174 → 179 tests pass; 0 type errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/plugins/enabled-when.ts src/lib/plugins/enabled-when.test.ts
git commit -m "feat(plugins): enabled-when supports computed bracket indices"
```

---

## Task 2: share-baker pure helpers

**Files:**
- Create: `src/lib/plugins/share-baker.ts`
- Create: `src/lib/plugins/share-baker.test.ts`

Pure helpers first (TDD): filename → header label, ISO date stamp, theme CSS string, viewport meta, size guard, base64 helpers. No moraya rendering yet.

- [ ] **Step 1: Write failing tests**

Create `src/lib/plugins/share-baker.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  shareHeaderLabel, isoDateStamp, viewportMetaTag, themeCssBlock,
  guardSize, MAX_HTML_BYTES,
} from './share-baker'

describe('shareHeaderLabel', () => {
  it('uses basename for normal paths', () => {
    expect(shareHeaderLabel('/Users/bruce/notes/foo.md')).toBe('foo.md')
  })
  it('keeps dotfile name intact', () => {
    expect(shareHeaderLabel('/proj/.env')).toBe('.env')
  })
  it('uses "Untitled" for null path', () => {
    expect(shareHeaderLabel(null)).toBe('Untitled')
  })
})

describe('isoDateStamp', () => {
  it('produces YYYY-MM-DD from a Date', () => {
    expect(isoDateStamp(new Date('2026-05-08T10:30:00Z'))).toBe('2026-05-08')
  })
})

describe('viewportMetaTag', () => {
  it('returns the standard width=device-width tag', () => {
    expect(viewportMetaTag()).toBe(
      '<meta name="viewport" content="width=device-width, initial-scale=1">'
    )
  })
})

describe('themeCssBlock', () => {
  it('contains light defaults and a prefers-color-scheme dark override', () => {
    const css = themeCssBlock()
    expect(css).toContain('color-scheme:')
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).toContain('img { max-width: 100%')
    expect(css).toContain('pre { overflow-x: auto')
  })
})

describe('guardSize', () => {
  it('passes through small payloads', () => {
    expect(() => guardSize('x'.repeat(1000))).not.toThrow()
  })
  it('throws a tagged error for >25MB payloads', () => {
    const big = 'x'.repeat(MAX_HTML_BYTES + 1)
    expect(() => guardSize(big)).toThrow(/^share_too_large:\d+$/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -s test src/lib/plugins/share-baker.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement helpers**

Create `src/lib/plugins/share-baker.ts`:

```ts
import { basename } from '../fs'

export const MAX_HTML_BYTES = 25 * 1024 * 1024

export function shareHeaderLabel(path: string | null): string {
  if (!path) return 'Untitled'
  return basename(path)
}

export function isoDateStamp(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

export function viewportMetaTag(): string {
  return '<meta name="viewport" content="width=device-width, initial-scale=1">'
}

export function themeCssBlock(): string {
  return `
:root { color-scheme: light dark; }
body {
  margin: 0; padding: 24px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: clamp(15px, 2.4vw, 18px); line-height: 1.6;
  background: #ffffff; color: #1a1a1a;
}
.share-shell { max-width: 720px; margin: 0 auto; }
.share-header { font-size: 0.85em; opacity: 0.6; margin-bottom: 32px; padding-bottom: 12px; border-bottom: 1px solid rgba(0,0,0,0.1); }
.share-footer { font-size: 0.8em; opacity: 0.5; margin-top: 64px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); text-align: center; }
img { max-width: 100%; height: auto; }
pre { overflow-x: auto; padding: 12px; background: rgba(0,0,0,0.04); border-radius: 6px; }
code { word-wrap: break-word; font-family: ui-monospace, SFMono-Regular, monospace; }
.katex-display { overflow-x: auto; overflow-y: hidden; }
table { border-collapse: collapse; max-width: 100%; }
th, td { padding: 6px 10px; border: 1px solid rgba(0,0,0,0.1); }
@media (prefers-color-scheme: dark) {
  body { background: #1a1a1a; color: #e0e0e0; }
  .share-header, .share-footer { border-color: rgba(255,255,255,0.1); }
  pre { background: rgba(255,255,255,0.06); }
  th, td { border-color: rgba(255,255,255,0.15); }
}
`.trim()
}

export function guardSize(html: string): void {
  const bytes = new TextEncoder().encode(html).byteLength
  if (bytes > MAX_HTML_BYTES) throw new Error(`share_too_large:${bytes}`)
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm -s test src/lib/plugins/share-baker.test.ts`
Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/share-baker.ts src/lib/plugins/share-baker.test.ts
git commit -m "feat(share): share-baker pure helpers (header, theme, viewport, size guard)"
```

---

## Task 3: share-baker markdown rendering

**Files:**
- Modify: `src/lib/plugins/share-baker.ts`
- Modify: `src/lib/plugins/share-baker.test.ts`

Reuse the marked + KaTeX + highlight.js stack already configured in `pdf-export.ts`. Mermaid/dot diagrams via the existing renderer-registry. The output is a body-fragment HTML string; later tasks wrap it in the document shell.

- [ ] **Step 1: Add failing tests**

Append to `src/lib/plugins/share-baker.test.ts`:

```ts
import { renderTabBody } from './share-baker'
import type { Tab } from '../tabs.svelte'

const fakeTab = (over: Partial<Tab> = {}): Tab => ({
  id: 'x',
  filePath: '/tmp/foo.md',
  title: 'foo.md',
  initialContent: '',
  currentContent: '',
  mode: 'source',
  kind: 'markdown',
  externalState: 'fresh',
  externalBannerDismissed: false,
  lastKnownMtime: 0,
  lastKnownHash: '',
  ...over,
})

describe('renderTabBody', () => {
  it('renders markdown headings to <h1>/<h2>', async () => {
    const t = fakeTab({ currentContent: '# Hello\n\n## World\n\nbody' })
    const body = await renderTabBody(t)
    expect(body).toMatch(/<h1[^>]*>Hello/i)
    expect(body).toMatch(/<h2[^>]*>World/i)
  })

  it('passes HTML tabs through unchanged in body', async () => {
    const t = fakeTab({
      kind: 'html', filePath: '/tmp/foo.html', title: 'foo.html',
      currentContent: '<p>raw</p>',
    })
    const body = await renderTabBody(t)
    expect(body).toContain('<p>raw</p>')
  })

  it('wraps code-kind tabs in a highlighted code block', async () => {
    const t = fakeTab({
      kind: 'code', filePath: '/tmp/foo.py', title: 'foo.py', language: 'python',
      currentContent: 'def f():\n    return 1',
    })
    const body = await renderTabBody(t)
    expect(body).toMatch(/<pre>/)
    expect(body).toContain('language-python')
  })

  it('highlights fenced code blocks via highlight.js', async () => {
    const t = fakeTab({ currentContent: '```js\nconst x = 1\n```' })
    const body = await renderTabBody(t)
    expect(body).toContain('hljs language-js')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -s test src/lib/plugins/share-baker.test.ts`
Expected: 4 new tests fail (renderTabBody not exported).

- [ ] **Step 3: Implement renderTabBody**

Append to `src/lib/plugins/share-baker.ts`:

```ts
import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'
import type { Tab } from '../tabs.svelte'
import { htmlEscape } from '../pdf-export'

const shareMarked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: string, lang: string): string {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      return hljs.highlight(code, { language }).value
    },
  }),
  markedKatex({ throwOnError: false }),
)

/**
 * Render a tab to an HTML body fragment (no <html>/<head> wrapper).
 * Pipeline mirrors pdf-export.ts so that share & PDF outputs stay visually
 * consistent.
 */
export async function renderTabBody(tab: Tab): Promise<string> {
  if (tab.kind === 'html') {
    return tab.currentContent
  }
  if (tab.kind === 'code') {
    const lang = tab.language && hljs.getLanguage(tab.language) ? tab.language : 'plaintext'
    const highlighted = hljs.highlight(tab.currentContent, { language: lang }).value
    return `<pre><code class="hljs language-${htmlEscape(lang)}">${highlighted}</code></pre>`
  }
  // markdown
  const result = await shareMarked.parse(tab.currentContent, { async: true })
  return result
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm -s test src/lib/plugins/share-baker.test.ts`
Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/share-baker.ts src/lib/plugins/share-baker.test.ts
git commit -m "feat(share): render markdown / html / code tabs to body fragment"
```

---

## Task 4: share-baker image inlining

**Files:**
- Modify: `src/lib/plugins/share-baker.ts`
- Modify: `src/lib/plugins/share-baker.test.ts`

Walk the rendered fragment as a DOM, find `<img>` tags whose `src` is a relative path or `file://` URL, read bytes via `@tauri-apps/plugin-fs`, base64-encode, replace `src` with a `data:` URL. Remote URLs (`http(s)://`) are left untouched. Read failure → replace `<img>` with the alt text.

- [ ] **Step 1: Add failing tests**

Append to `src/lib/plugins/share-baker.test.ts`:

```ts
import { inlineImages } from './share-baker'

describe('inlineImages', () => {
  function makeReader(map: Record<string, Uint8Array | Error>) {
    return async (path: string) => {
      const v = map[path]
      if (v instanceof Error) throw v
      if (!v) throw new Error(`fixture missing: ${path}`)
      return v
    }
  }
  function pngFixture(): Uint8Array {
    // 1x1 transparent PNG
    return new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ])
  }

  it('inlines a relative png path as base64 data URL', async () => {
    const html = '<p><img src="./pic.png" alt="ok"></p>'
    const out = await inlineImages(html, '/Users/bruce/notes/foo.md', makeReader({
      '/Users/bruce/notes/pic.png': pngFixture(),
    }))
    expect(out).toContain('src="data:image/png;base64,')
    expect(out).not.toContain('./pic.png')
  })

  it('inlines a file:// absolute path', async () => {
    const html = '<img src="file:///tmp/abs.jpg">'
    const out = await inlineImages(html, '/Users/bruce/notes/foo.md', makeReader({
      '/tmp/abs.jpg': new Uint8Array([0xff, 0xd8, 0xff]),
    }))
    expect(out).toContain('src="data:image/jpeg;base64,')
  })

  it('leaves remote https:// untouched', async () => {
    const html = '<img src="https://example.com/x.png">'
    const out = await inlineImages(html, '/p/foo.md', makeReader({}))
    expect(out).toBe(html)
  })

  it('replaces unreadable image with italic alt text', async () => {
    const html = '<img src="./missing.png" alt="missing alt">'
    const out = await inlineImages(html, '/p/foo.md', makeReader({
      '/p/missing.png': new Error('ENOENT'),
    }))
    expect(out).not.toContain('<img')
    expect(out).toContain('<em>missing alt</em>')
  })

  it('uses [image] placeholder when alt is missing', async () => {
    const html = '<img src="./missing.png">'
    const out = await inlineImages(html, '/p/foo.md', makeReader({
      '/p/missing.png': new Error('ENOENT'),
    }))
    expect(out).toContain('<em>[image]</em>')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -s test src/lib/plugins/share-baker.test.ts`
Expected: 5 new tests fail.

- [ ] **Step 3: Implement image inlining**

Append to `src/lib/plugins/share-baker.ts`:

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
  // Process in chunks to avoid stack-overflow with String.fromCharCode(...big).
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
  // Relative — resolve against the tab's directory.
  return `${dirname(tabPath)}/${p}`.replace(/\/\.\//g, '/')
}

/**
 * Replace <img> tags whose src points at local files with base64 data URLs.
 * Remote URLs (https://) are left untouched. Unreadable images become
 * `<em>alt</em>` text (or `<em>[image]</em>` if no alt).
 */
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm -s test src/lib/plugins/share-baker.test.ts`
Expected: all 18 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/share-baker.ts src/lib/plugins/share-baker.test.ts
git commit -m "feat(share): inline local images as base64 data URLs"
```

---

## Task 5: share-baker bakeShareHtml

**Files:**
- Modify: `src/lib/plugins/share-baker.ts`
- Modify: `src/lib/plugins/share-baker.test.ts`

Tie everything together: `bakeShareHtml(tab)` renders body, inlines images via Tauri fs, wraps in shell, applies size guard, returns the full document string.

- [ ] **Step 1: Add failing tests**

Append to `src/lib/plugins/share-baker.test.ts`:

```ts
import { bakeShareHtml, __setImageReaderForTests } from './share-baker'

describe('bakeShareHtml', () => {
  it('produces a full self-contained HTML document', async () => {
    __setImageReaderForTests(async () => new Uint8Array([0]))
    const t = fakeTab({ currentContent: '# Hi\n\nbody' })
    const html = await bakeShareHtml(t)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta name="viewport"')
    expect(html).toContain('@media (prefers-color-scheme: dark)')
    expect(html).toContain('<h1')
    expect(html).toContain('<h1') // body content present
    expect(html).toContain('class="share-shell"')
    expect(html).toContain('class="share-header"')
    expect(html).toContain('class="share-footer"')
    expect(html).toContain('foo.md')   // header label
    __setImageReaderForTests(null)
  })

  it('throws share_too_large for >25MB output', async () => {
    __setImageReaderForTests(async () => new Uint8Array([0]))
    const huge = 'x'.repeat(26 * 1024 * 1024)
    const t = fakeTab({ currentContent: huge })
    await expect(bakeShareHtml(t)).rejects.toThrow(/^share_too_large:/)
    __setImageReaderForTests(null)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -s test src/lib/plugins/share-baker.test.ts`
Expected: 2 new tests fail.

- [ ] **Step 3: Implement bakeShareHtml**

Append to `src/lib/plugins/share-baker.ts`:

```ts
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

/**
 * Render a tab into a fully self-contained HTML document suitable for posting
 * to the share Worker. Inlines images as base64, bakes light + dark themes,
 * adds mobile-responsive viewport, wraps in a minimal header/footer shell.
 *
 * Throws `share_too_large:<bytes>` if the result exceeds 25 MB.
 */
export async function bakeShareHtml(tab: Tab): Promise<string> {
  const body = await renderTabBody(tab)
  const inlined = await inlineImages(body, tab.filePath, pickImageReader())
  const title = htmlEscape(shareHeaderLabel(tab.filePath))
  const date = isoDateStamp()
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${viewportMetaTag()}
<title>${title}</title>
<style>${themeCssBlock()}</style>
</head>
<body>
<div class="share-shell">
<header class="share-header">${title} · ${date}</header>
<main>${inlined}</main>
<footer class="share-footer">Powered by <a href="https://github.com/wizlijun/MdEditor">M↓</a></footer>
</div>
</body>
</html>`
  guardSize(html)
  return html
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm -s test src/lib/plugins/share-baker.test.ts`
Expected: all 20 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/share-baker.ts src/lib/plugins/share-baker.test.ts
git commit -m "feat(share): bakeShareHtml — full pipeline returning self-contained HTML"
```

---

## Task 6: Wire share-baker into App.svelte

**Files:**
- Modify: `src/App.svelte`

The platform's `host.ts` throws when a plugin declares `renderer.html` and the call site doesn't pass an `htmlBaker`. The share plugin needs this — App.svelte must inject the baker.

- [ ] **Step 1: Add import**

Modify `src/App.svelte`. Near the existing plugin imports, add:

```ts
  import { bakeShareHtml } from './lib/plugins/share-baker'
```

- [ ] **Step 2: Pass htmlBaker into invokePlugin**

Find the existing call in `dispatchPlugin`:

```ts
        const result = await invokePlugin(m, command, snap, {
          settingsReader: (id) => getPluginScopedAll(id),
        })
```

Replace with:

```ts
        const result = await invokePlugin(m, command, snap, {
          settingsReader: (id) => getPluginScopedAll(id),
          htmlBaker: async (snapshot) => {
            const t = tabs.find((tab) => tab.filePath === snapshot.path)
            if (!t) throw new Error('share-baker: no matching open tab')
            return bakeShareHtml(t)
          },
        })
```

- [ ] **Step 3: Type-check**

Run: `pnpm -s check`
Expected: 0 errors.

- [ ] **Step 4: Run tests**

Run: `pnpm -s test`
Expected: 179 tests pass (no regression).

- [ ] **Step 5: Commit**

```bash
git add src/App.svelte
git commit -m "feat(share): wire bakeShareHtml as plugin htmlBaker in App.svelte"
```

---

## Task 7: mdshare Cargo project + IPC scaffolding

**Files:**
- Create: `mdshare/Cargo.toml`
- Create: `mdshare/src/main.rs`
- Create: `mdshare/src/ipc.rs`

Set up a separate Cargo workspace at the repo root. Lean dependencies. Stub `main.rs` reads one JSON line from stdin, parses, dispatches by command, writes a default Response.

- [ ] **Step 1: Create Cargo.toml**

Create `mdshare/Cargo.toml`:

```toml
[package]
name = "mdshare"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
ureq = { version = "2", features = ["json", "tls"] }
time = { version = "0.3", features = ["formatting"] }
rand = "0.8"

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

Add to the repo root's `.gitignore` (read first, then append):

```
mdshare/target/
```

- [ ] **Step 2: Create ipc.rs**

Create `mdshare/src/ipc.rs`:

```rust
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Deserialize, Debug)]
pub struct Request {
    pub command: String,
    pub context: Context,
    #[serde(default)]
    pub settings: Option<Map<String, Value>>,
}

#[derive(Deserialize, Debug)]
pub struct Context {
    pub tab: TabMeta,
    #[serde(default)]
    pub rendered_html: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct TabMeta {
    pub path: Option<String>,
    pub filename: Option<String>,
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
    #[serde(rename = "clipboard.write")]
    ClipboardWrite { text: String },
    #[serde(rename = "settings.merge")]
    SettingsMerge { patch: Map<String, Value> },
}

impl Response {
    pub fn ok(actions: Vec<Action>) -> Self {
        Self { success: true, actions }
    }
    pub fn fail(actions: Vec<Action>) -> Self {
        Self { success: false, actions }
    }
}

pub fn toast_error(name: &str, message_zh: &str, detail: Option<&str>) -> Action {
    Action::Toast {
        level: "error".into(),
        message: format!("❌ {name}: {message_zh}"),
        detail: detail.map(|s| s.to_string()),
    }
}
```

- [ ] **Step 3: Create main.rs**

Create `mdshare/src/main.rs`:

```rust
mod ipc;
mod slug;

use std::io::{self, Read, Write};
use ipc::{Request, Response, Action};

const PLUGIN_NAME: &str = "Share";

fn main() {
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        emit(Response::fail(vec![ipc::toast_error(PLUGIN_NAME, "无法读取 stdin", Some(&e.to_string()))]));
        return;
    }
    let req: Request = match serde_json::from_str(input.trim()) {
        Ok(r) => r,
        Err(e) => {
            emit(Response::fail(vec![ipc::toast_error(PLUGIN_NAME, "请求 JSON 解析失败", Some(&e.to_string()))]));
            return;
        }
    };

    let resp = match req.command.as_str() {
        "publish" => Response::ok(vec![Action::Toast {
            level: "info".into(),
            message: "publish stub".into(),
            detail: None,
        }]),
        "unpublish" => Response::ok(vec![Action::Toast {
            level: "info".into(),
            message: "unpublish stub".into(),
            detail: None,
        }]),
        "copy-link" => Response::ok(vec![Action::Toast {
            level: "info".into(),
            message: "copy-link stub".into(),
            detail: None,
        }]),
        other => Response::fail(vec![ipc::toast_error(PLUGIN_NAME, "未知命令", Some(other))]),
    };
    emit(resp);
}

fn emit(resp: Response) {
    let s = serde_json::to_string(&resp).expect("serialize response");
    let stdout = io::stdout();
    let mut h = stdout.lock();
    h.write_all(s.as_bytes()).expect("write stdout");
    h.write_all(b"\n").expect("write newline");
}
```

(Note: `mod slug;` is referenced for the next task — create an empty `mdshare/src/slug.rs` for now so the file compiles.)

Create `mdshare/src/slug.rs`:

```rust
// Implemented in Task 8.
```

- [ ] **Step 4: Cargo build**

Run: `cd mdshare && cargo build 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Smoke check the binary**

Run:
```bash
cd /Users/bruce/git/mdeditor/.worktrees/mdshare
echo '{"command":"publish","context":{"tab":{"path":null,"filename":null}}}' | ./mdshare/target/debug/mdshare
```
Expected output: `{"success":true,"actions":[{"type":"toast","level":"info","message":"publish stub"}]}`

- [ ] **Step 6: Commit**

```bash
git add mdshare/Cargo.toml mdshare/Cargo.lock mdshare/src/main.rs mdshare/src/ipc.rs mdshare/src/slug.rs .gitignore
git commit -m "feat(share): mdshare CLI scaffold — Cargo project + IPC types"
```

---

## Task 8: mdshare slug generation

**Files:**
- Modify: `mdshare/src/slug.rs`

- [ ] **Step 1: Write the implementation + tests**

Replace `mdshare/src/slug.rs`:

```rust
use rand::Rng;
use time::{macros::format_description, OffsetDateTime};

/// Generate a slug per spec rules:
/// 1. Format: YYYY-MM-DD-<filename-slug>[-<3-char base62 suffix>]
/// 2. ASCII alphanumerics preserved, lowercased
/// 3. Non-ASCII characters stripped; ` _.` -> `-`; consecutive `-` collapsed; trim
/// 4. Filename portion capped at 40 chars
/// 5. If stripped filename is empty, fall back to `untitled-<8 hex of content hash>`
/// 6. If filename starts with YYYY-MM-DD already, do not double-prefix
/// 7. Suffix: 3 chars from base62 alphabet, controlled by `with_suffix`
pub fn generate(filename: Option<&str>, content: &str, with_suffix: bool) -> String {
    let date = OffsetDateTime::now_local()
        .unwrap_or_else(|_| OffsetDateTime::now_utc())
        .format(format_description!("[year]-[month]-[day]"))
        .expect("date format");

    let base = filename
        .map(|n| {
            // Strip extension first.
            match n.rfind('.') {
                Some(i) if i > 0 => n[..i].to_string(),
                _ => n.to_string(),
            }
        })
        .unwrap_or_default();

    let stripped = strip_to_ascii_slug(&base);
    let truncated: String = stripped.chars().take(40).collect();

    let filename_part = if truncated.is_empty() {
        format!("untitled-{}", content_hash_hex8(content))
    } else if starts_with_iso_date(&truncated) {
        // Skip date prefix to avoid YYYY-MM-DD-YYYY-MM-DD-...
        truncated
    } else {
        format!("{date}-{truncated}")
    };

    let final_part = if !filename_part.starts_with(&date) && !starts_with_iso_date(&filename_part) {
        format!("{date}-{filename_part}")
    } else {
        filename_part
    };

    if with_suffix {
        format!("{final_part}-{}", random_base62_3())
    } else {
        final_part
    }
}

fn strip_to_ascii_slug(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_dash = false;
    for c in input.chars() {
        let mapped: Option<char> = if c.is_ascii_alphanumeric() {
            Some(c.to_ascii_lowercase())
        } else if c == ' ' || c == '_' || c == '.' || c == '-' {
            Some('-')
        } else if c.is_ascii() {
            None
        } else {
            None
        };
        if let Some(ch) = mapped {
            if ch == '-' {
                if !last_dash && !out.is_empty() {
                    out.push('-');
                    last_dash = true;
                }
            } else {
                out.push(ch);
                last_dash = false;
            }
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn starts_with_iso_date(s: &str) -> bool {
    // Cheap check: 4 digits + dash + 2 digits + dash + 2 digits + dash
    let bytes = s.as_bytes();
    if bytes.len() < 11 { return false }
    bytes[..4].iter().all(|b| b.is_ascii_digit())
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(|b| b.is_ascii_digit())
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(|b| b.is_ascii_digit())
        && bytes[10] == b'-'
}

fn random_base62_3() -> String {
    const ALPHA: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let mut rng = rand::thread_rng();
    (0..3)
        .map(|_| ALPHA[rng.gen_range(0..ALPHA.len())] as char)
        .collect()
}

fn content_hash_hex8(content: &str) -> String {
    // Simple FNV-1a 64-bit, take first 8 hex chars. Avoids pulling in sha2.
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in content.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)[..8].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_suffix(s: &str) -> String {
        // Strip the random 3-char suffix when we want deterministic checks.
        let mut chunks: Vec<&str> = s.split('-').collect();
        chunks.pop();
        chunks.join("-")
    }

    #[test]
    fn ascii_filename_with_date() {
        let s = generate(Some("trip notes.md"), "", true);
        assert!(s.contains("trip-notes"));
        assert_eq!(s.split('-').count(), 6); // YYYY-MM-DD-trip-notes-XXX
    }

    #[test]
    fn underscore_and_dot_become_dash() {
        let s = no_suffix(&generate(Some("a_b.c.md"), "", true));
        assert!(s.ends_with("-a-b-c"));
    }

    #[test]
    fn collapses_consecutive_dashes() {
        let s = no_suffix(&generate(Some("a   b___c.md"), "", true));
        assert!(s.ends_with("-a-b-c"));
    }

    #[test]
    fn pure_chinese_falls_back_to_untitled_hash() {
        let s = no_suffix(&generate(Some("会议纪要.md"), "hello world", true));
        assert!(s.contains("-untitled-"));
        // The hash is deterministic for fixed content.
        let s2 = no_suffix(&generate(Some("不同名字.md"), "hello world", true));
        // Different name, same content → same untitled-<hash> tail (filename is ignored when empty stripped).
        let tail1 = s.split("untitled-").nth(1).unwrap();
        let tail2 = s2.split("untitled-").nth(1).unwrap();
        assert_eq!(tail1, tail2);
    }

    #[test]
    fn truncates_long_filename_to_40() {
        let long = "a".repeat(200);
        let s = no_suffix(&generate(Some(&format!("{long}.md")), "", true));
        // 40 a's, plus YYYY-MM-DD- prefix
        let last_segment_len = s.chars().rev().take_while(|c| *c != '-').count();
        // Iterate again from last dash to find the filename portion length.
        let parts: Vec<&str> = s.rsplitn(2, '-').collect();
        let filename_part = parts[0];
        assert_eq!(filename_part.len(), 40);
        assert!(last_segment_len > 0);
    }

    #[test]
    fn does_not_double_date_prefix() {
        let s = no_suffix(&generate(Some("2024-01-15-meeting.md"), "", true));
        // Should NOT have two date prefixes; check there's only one YYYY-MM-DD-
        let dash_groups: Vec<&str> = s.splitn(4, '-').collect();
        // YYYY-MM-DD-meeting → splitn(4) gives ["YYYY","MM","DD","meeting"]
        // (with no extra date in the tail).
        let tail = dash_groups[3];
        assert!(!starts_with_iso_date(tail));
    }

    #[test]
    fn untitled_filename_uses_hash_fallback() {
        let s = no_suffix(&generate(None, "any content", true));
        assert!(s.contains("-untitled-"));
    }

    #[test]
    fn no_suffix_when_disabled() {
        let s = generate(Some("foo.md"), "", false);
        // Format: YYYY-MM-DD-foo (4 dash-separated parts)
        assert_eq!(s.split('-').count(), 4);
    }

    #[test]
    fn suffix_is_3_chars_from_base62() {
        let s = generate(Some("foo.md"), "", true);
        let suffix = s.rsplit('-').next().unwrap();
        assert_eq!(suffix.len(), 3);
        assert!(suffix.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn strip_to_ascii_slug_basic() {
        assert_eq!(strip_to_ascii_slug("Hello World"), "hello-world");
        assert_eq!(strip_to_ascii_slug("a__b__c"), "a-b-c");
        assert_eq!(strip_to_ascii_slug("---a---"), "a");
        assert_eq!(strip_to_ascii_slug(""), "");
        assert_eq!(strip_to_ascii_slug("中文"), "");
    }

    #[test]
    fn iso_date_recognition() {
        assert!(starts_with_iso_date("2024-01-15-x"));
        assert!(!starts_with_iso_date("2024-01-15")); // missing trailing dash
        assert!(!starts_with_iso_date("hello"));
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd mdshare && cargo test --lib slug 2>&1 | tail -20`
Expected: 11 tests pass.

- [ ] **Step 3: Commit**

```bash
git add mdshare/src/slug.rs mdshare/Cargo.lock
git commit -m "feat(share): slug generation with date prefix + suffix + ascii-only rules"
```

---

## Task 9: mdshare publish command

**Files:**
- Create: `mdshare/src/publish.rs`
- Modify: `mdshare/src/main.rs`

- [ ] **Step 1: Implement publish.rs**

Create `mdshare/src/publish.rs`:

```rust
use crate::ipc::{Action, Request, Response, toast_error};
use crate::slug;
use rand::RngCore;
use serde_json::{json, Map, Value};

const PLUGIN_NAME: &str = "Share";

pub fn run(req: Request) -> Response {
    let tab = &req.context.tab;
    let html = match req.context.rendered_html.as_deref() {
        Some(s) if !s.is_empty() => s,
        _ => {
            return Response::fail(vec![toast_error(PLUGIN_NAME, "内容为空", None)]);
        }
    };
    let path = match tab.path.as_deref() {
        Some(p) => p.to_string(),
        None => {
            return Response::fail(vec![toast_error(PLUGIN_NAME, "请先保存文件", None)]);
        }
    };
    let filename = tab.filename.clone().unwrap_or_else(|| "untitled".to_string());

    let settings = req.settings.unwrap_or_default();
    let base_url = match settings.get("share.baseUrl").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.trim_end_matches('/').to_string(),
        _ => return Response::fail(vec![toast_error(PLUGIN_NAME, "未配置 Service Base URL", None)]),
    };
    let api_key = match settings.get("share.apiKey").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Response::fail(vec![toast_error(PLUGIN_NAME, "未配置 API Key", None)]),
    };
    let with_suffix = settings
        .get("share.slugRandomSuffix")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let expiry = settings
        .get("share.defaultExpiry")
        .and_then(|v| v.as_str())
        .unwrap_or("never");
    let expires_in_seconds = match expiry {
        "7d" => Some(7 * 24 * 3600u64),
        "30d" => Some(30 * 24 * 3600),
        "90d" => Some(90 * 24 * 3600),
        _ => None,
    };

    // Look up existing record for this path.
    let existing_record = settings
        .get("share.records")
        .and_then(|v| v.as_object())
        .and_then(|m| m.get(&path))
        .and_then(|v| v.as_object())
        .cloned();

    let (slug_string, edit_token, is_update) = if let Some(rec) = existing_record.as_ref() {
        let slug = rec.get("slug").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let token = rec.get("edit_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if slug.is_empty() || token.is_empty() {
            return Response::fail(vec![toast_error(PLUGIN_NAME, "本地分享记录损坏，请取消分享后重试", None)]);
        }
        (slug, token, true)
    } else {
        (slug::generate(Some(&filename), html, with_suffix), generate_edit_token(), false)
    };

    // Try to publish, retrying on slug conflict for new shares only.
    let mut current_slug = slug_string.clone();
    let mut attempts = 0;
    let max_attempts = if is_update { 1 } else { 3 };
    loop {
        attempts += 1;
        let body = json!({
            "slug": current_slug,
            "edit_token": edit_token,
            "html": html,
            "expires_in_seconds": expires_in_seconds,
            "metadata": {
                "original_filename": filename,
                "source_ext": filename.rsplit('.').next().unwrap_or(""),
            }
        });
        let url = format!("{base_url}/publish");
        let resp = ureq::post(&url)
            .set("Authorization", &format!("Bearer {api_key}"))
            .set("Content-Type", "application/json")
            .send_string(&body.to_string());

        match resp {
            Ok(_) => {
                // Build the merged records map.
                let mut records: Map<String, Value> = settings
                    .get("share.records")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                let url = format!("{base_url}/{current_slug}");
                let now = current_iso8601();
                records.insert(
                    path.clone(),
                    json!({
                        "slug": current_slug,
                        "edit_token": edit_token,
                        "url": url,
                        "created_at": existing_record
                            .as_ref()
                            .and_then(|r| r.get("created_at"))
                            .cloned()
                            .unwrap_or_else(|| Value::String(now.clone())),
                        "expires_at": expires_in_seconds.map(|_| now.clone()).unwrap_or_else(|| String::new()),
                        "filename": filename.clone(),
                    }),
                );
                let mut patch = Map::new();
                patch.insert("share.records".to_string(), Value::Object(records));
                let msg = if is_update { "✅ 内容已更新（链接已复制）" } else { "✅ 分享成功（已复制）" };
                return Response::ok(vec![
                    Action::SettingsMerge { patch },
                    Action::ClipboardWrite { text: url.clone() },
                    Action::Toast {
                        level: "success".into(),
                        message: format!("{msg}：{url}"),
                        detail: None,
                    },
                ]);
            }
            Err(ureq::Error::Status(409, _)) if !is_update && attempts < max_attempts => {
                // Slug conflict on a new share — append numeric suffix.
                current_slug = format!("{slug_string}-{}", attempts + 1);
                continue;
            }
            Err(ureq::Error::Status(409, _)) => {
                return Response::fail(vec![toast_error(PLUGIN_NAME, "slug 冲突，请稍后重试", None)]);
            }
            Err(ureq::Error::Status(401, r)) => {
                return Response::fail(vec![toast_error(
                    PLUGIN_NAME,
                    "API key 无效，请检查 Preferences",
                    Some(&format!("HTTP 401: {}", r.status_text())),
                )]);
            }
            Err(ureq::Error::Status(413, _)) => {
                return Response::fail(vec![toast_error(PLUGIN_NAME, "文档过大", None)]);
            }
            Err(ureq::Error::Status(s, r)) if s >= 500 => {
                return Response::fail(vec![toast_error(
                    PLUGIN_NAME,
                    "服务器繁忙，请稍后重试",
                    Some(&format!("HTTP {s}: {}", r.status_text())),
                )]);
            }
            Err(ureq::Error::Status(s, r)) => {
                return Response::fail(vec![toast_error(
                    PLUGIN_NAME,
                    "上传失败",
                    Some(&format!("HTTP {s}: {}", r.status_text())),
                )]);
            }
            Err(ureq::Error::Transport(t)) => {
                return Response::fail(vec![toast_error(
                    PLUGIN_NAME,
                    "网络错误，请检查网络",
                    Some(&t.to_string()),
                )]);
            }
        }
    }
}

fn generate_edit_token() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn current_iso8601() -> String {
    OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

use time::OffsetDateTime;
```

- [ ] **Step 2: Wire publish into main.rs**

Modify `mdshare/src/main.rs`:

Replace the `mod` lines and dispatch:

```rust
mod ipc;
mod publish;
mod slug;

use std::io::{self, Read, Write};
use ipc::{Request, Response};

const PLUGIN_NAME: &str = "Share";

fn main() {
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        emit(Response::fail(vec![ipc::toast_error(PLUGIN_NAME, "无法读取 stdin", Some(&e.to_string()))]));
        return;
    }
    let req: Request = match serde_json::from_str(input.trim()) {
        Ok(r) => r,
        Err(e) => {
            emit(Response::fail(vec![ipc::toast_error(PLUGIN_NAME, "请求 JSON 解析失败", Some(&e.to_string()))]));
            return;
        }
    };

    let resp = match req.command.as_str() {
        "publish" => publish::run(req),
        "unpublish" => Response::fail(vec![ipc::toast_error(PLUGIN_NAME, "unpublish 未实现", None)]),
        "copy-link" => Response::fail(vec![ipc::toast_error(PLUGIN_NAME, "copy-link 未实现", None)]),
        other => Response::fail(vec![ipc::toast_error(PLUGIN_NAME, "未知命令", Some(other))]),
    };
    emit(resp);
}

fn emit(resp: Response) {
    let s = serde_json::to_string(&resp).expect("serialize response");
    let stdout = io::stdout();
    let mut h = stdout.lock();
    h.write_all(s.as_bytes()).expect("write stdout");
    h.write_all(b"\n").expect("write newline");
}
```

- [ ] **Step 3: Build**

Run: `cd mdshare && cargo build 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 4: Smoke against a non-existent server (should produce a network-error toast)**

Run:
```bash
cd /Users/bruce/git/mdeditor/.worktrees/mdshare
echo '{"command":"publish","context":{"tab":{"path":"/tmp/x.md","filename":"x.md"},"rendered_html":"<p>hi</p>"},"settings":{"share.baseUrl":"http://127.0.0.1:1","share.apiKey":"k","share.slugRandomSuffix":true,"share.defaultExpiry":"never"}}' | ./mdshare/target/debug/mdshare
```
Expected: JSON with `"success":false` and a toast action containing `"网络错误"`.

- [ ] **Step 5: Commit**

```bash
git add mdshare/src/main.rs mdshare/src/publish.rs mdshare/Cargo.lock
git commit -m "feat(share): mdshare publish command — POST /publish + records merge"
```

---

## Task 10: mdshare unpublish command

**Files:**
- Create: `mdshare/src/unpublish.rs`
- Modify: `mdshare/src/main.rs`

- [ ] **Step 1: Implement unpublish.rs**

Create `mdshare/src/unpublish.rs`:

```rust
use crate::ipc::{Action, Request, Response, toast_error};
use serde_json::{json, Map, Value};

const PLUGIN_NAME: &str = "Share";

pub fn run(req: Request) -> Response {
    let path = match req.context.tab.path.as_deref() {
        Some(p) => p.to_string(),
        None => return Response::fail(vec![toast_error(PLUGIN_NAME, "无路径，无法撤销", None)]),
    };
    let settings = req.settings.unwrap_or_default();
    let base_url = match settings.get("share.baseUrl").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.trim_end_matches('/').to_string(),
        _ => return Response::fail(vec![toast_error(PLUGIN_NAME, "未配置 Service Base URL", None)]),
    };
    let api_key = match settings.get("share.apiKey").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Response::fail(vec![toast_error(PLUGIN_NAME, "未配置 API Key", None)]),
    };

    let mut records: Map<String, Value> = settings
        .get("share.records")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let record = match records.get(&path).and_then(|v| v.as_object()).cloned() {
        Some(r) => r,
        None => return Response::fail(vec![toast_error(PLUGIN_NAME, "本文件未分享过", None)]),
    };
    let slug = record.get("slug").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let edit_token = record.get("edit_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if slug.is_empty() || edit_token.is_empty() {
        return Response::fail(vec![toast_error(PLUGIN_NAME, "本地分享记录损坏", None)]);
    }

    let url = format!("{base_url}/{slug}");
    let body = json!({ "edit_token": edit_token });
    let result = ureq::delete(&url)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string());

    let server_says_ok = match result {
        Ok(_) => true,
        Err(ureq::Error::Status(404, _)) => true, // already gone — accept it
        Err(ureq::Error::Status(401, r)) => {
            return Response::fail(vec![toast_error(
                PLUGIN_NAME, "API key 无效", Some(&format!("HTTP 401: {}", r.status_text())),
            )]);
        }
        Err(ureq::Error::Status(403, _)) => {
            return Response::fail(vec![toast_error(PLUGIN_NAME, "无权撤销该分享（edit_token 不匹配）", None)]);
        }
        Err(ureq::Error::Status(s, r)) => {
            return Response::fail(vec![toast_error(
                PLUGIN_NAME, "撤销失败", Some(&format!("HTTP {s}: {}", r.status_text())),
            )]);
        }
        Err(ureq::Error::Transport(t)) => {
            return Response::fail(vec![toast_error(
                PLUGIN_NAME, "网络错误，请检查网络", Some(&t.to_string()),
            )]);
        }
    };
    let _ = server_says_ok;

    records.remove(&path);
    let mut patch = Map::new();
    patch.insert("share.records".to_string(), Value::Object(records));
    Response::ok(vec![
        Action::SettingsMerge { patch },
        Action::Toast { level: "success".into(), message: "✅ 已撤销分享".into(), detail: None },
    ])
}
```

- [ ] **Step 2: Wire into main.rs**

In `mdshare/src/main.rs`, add `mod unpublish;` and replace the `"unpublish"` arm with:

```rust
        "unpublish" => unpublish::run(req),
```

- [ ] **Step 3: Build**

Run: `cd mdshare && cargo build 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add mdshare/src/main.rs mdshare/src/unpublish.rs
git commit -m "feat(share): mdshare unpublish command — DELETE /:slug + records cleanup"
```

---

## Task 11: mdshare copy-link command

**Files:**
- Create: `mdshare/src/copy_link.rs`
- Modify: `mdshare/src/main.rs`

- [ ] **Step 1: Implement copy_link.rs**

Create `mdshare/src/copy_link.rs`:

```rust
use crate::ipc::{Action, Request, Response, toast_error};

const PLUGIN_NAME: &str = "Share";

pub fn run(req: Request) -> Response {
    let path = match req.context.tab.path.as_deref() {
        Some(p) => p.to_string(),
        None => return Response::fail(vec![toast_error(PLUGIN_NAME, "无路径，无法复制链接", None)]),
    };
    let settings = req.settings.unwrap_or_default();
    let records = match settings.get("share.records").and_then(|v| v.as_object()) {
        Some(r) => r,
        None => return Response::fail(vec![toast_error(PLUGIN_NAME, "本文件未分享过", None)]),
    };
    let record = match records.get(&path).and_then(|v| v.as_object()) {
        Some(r) => r,
        None => return Response::fail(vec![toast_error(PLUGIN_NAME, "本文件未分享过", None)]),
    };
    let url = match record.get("url").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Response::fail(vec![toast_error(PLUGIN_NAME, "本地分享记录损坏", None)]),
    };
    Response::ok(vec![
        Action::ClipboardWrite { text: url.clone() },
        Action::Toast {
            level: "success".into(),
            message: format!("✅ 已复制：{url}"),
            detail: None,
        },
    ])
}
```

- [ ] **Step 2: Wire into main.rs**

In `mdshare/src/main.rs`, add `mod copy_link;` and replace the `"copy-link"` arm with:

```rust
        "copy-link" => copy_link::run(req),
```

- [ ] **Step 3: Build**

Run: `cd mdshare && cargo build 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 4: Smoke**

Run:
```bash
cd /Users/bruce/git/mdeditor/.worktrees/mdshare
echo '{"command":"copy-link","context":{"tab":{"path":"/tmp/x.md","filename":"x.md"}},"settings":{"share.records":{"/tmp/x.md":{"slug":"s","edit_token":"e","url":"https://x.example/s","filename":"x.md"}}}}' | ./mdshare/target/debug/mdshare
```
Expected: response with `clipboard.write` text=`"https://x.example/s"` and a success toast.

- [ ] **Step 5: Commit**

```bash
git add mdshare/src/main.rs mdshare/src/copy_link.rs
git commit -m "feat(share): mdshare copy-link command — local URL emit"
```

---

## Task 12: mdshare integration tests

**Files:**
- Create: `mdshare/tests/integration.rs`

End-to-end tests that spawn the compiled binary and pipe JSON through stdin/stdout. These guard against regressions in the dispatch loop, IPC encoding, and `unknown command` path. (Per-command HTTP testing is harder without a mock server; we cover the no-network paths here.)

- [ ] **Step 1: Write tests**

Create `mdshare/tests/integration.rs`:

```rust
use std::io::Write;
use std::process::{Command, Stdio};

fn binary() -> std::path::PathBuf {
    let target = std::env::var("CARGO_BIN_EXE_mdshare")
        .expect("CARGO_BIN_EXE_mdshare set by cargo test");
    std::path::PathBuf::from(target)
}

fn run_with_input(input: &str) -> String {
    let mut child = Command::new(binary())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn mdshare");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(input.as_bytes())
        .expect("write stdin");
    let out = child.wait_with_output().expect("wait");
    assert!(out.status.success());
    String::from_utf8(out.stdout).expect("utf8 stdout")
}

#[test]
fn copy_link_returns_clipboard_action() {
    let req = r#"{
      "command":"copy-link",
      "context":{"tab":{"path":"/p.md","filename":"p.md"}},
      "settings":{"share.records":{"/p.md":{"slug":"s","edit_token":"e","url":"https://x/s","filename":"p.md"}}}
    }"#;
    let out = run_with_input(req);
    assert!(out.contains("\"clipboard.write\""));
    assert!(out.contains("https://x/s"));
}

#[test]
fn copy_link_without_record_fails() {
    let req = r#"{"command":"copy-link","context":{"tab":{"path":"/p.md","filename":"p.md"}},"settings":{}}"#;
    let out = run_with_input(req);
    assert!(out.contains("\"success\":false"));
    assert!(out.contains("未分享过"));
}

#[test]
fn unknown_command_fails() {
    let req = r#"{"command":"explode","context":{"tab":{"path":null,"filename":null}}}"#;
    let out = run_with_input(req);
    assert!(out.contains("\"success\":false"));
    assert!(out.contains("未知命令"));
}

#[test]
fn invalid_json_fails_gracefully() {
    let out = run_with_input("not json");
    assert!(out.contains("\"success\":false"));
    assert!(out.contains("解析失败"));
}

#[test]
fn publish_without_baseurl_fails() {
    let req = r#"{
      "command":"publish",
      "context":{"tab":{"path":"/p.md","filename":"p.md"},"rendered_html":"<p>x</p>"},
      "settings":{}
    }"#;
    let out = run_with_input(req);
    assert!(out.contains("\"success\":false"));
    assert!(out.contains("Service Base URL"));
}
```

- [ ] **Step 2: Run tests**

Run: `cd mdshare && cargo test --test integration 2>&1 | tail -10`
Expected: 5 PASS.

- [ ] **Step 3: Commit**

```bash
git add mdshare/tests/integration.rs
git commit -m "test(share): mdshare integration tests via spawn-binary stdin/stdout"
```

---

## Task 13: build-mdshare script

**Files:**
- Create: `scripts/build-mdshare.sh`
- Modify: `package.json`

- [ ] **Step 1: Write the build script**

Create `scripts/build-mdshare.sh`:

```bash
#!/usr/bin/env bash
# Build the mdshare CLI for both macOS architectures and copy into the
# bundled plugin directory. Run before `pnpm tauri build` for release.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[mdshare] ensuring rustup targets…"
rustup target add aarch64-apple-darwin >/dev/null
rustup target add x86_64-apple-darwin >/dev/null

echo "[mdshare] cargo build --release × 2…"
( cd mdshare && cargo build --release --target aarch64-apple-darwin )
( cd mdshare && cargo build --release --target x86_64-apple-darwin )

DEST="src-tauri/plugins/share"
mkdir -p "$DEST"
cp mdshare/target/aarch64-apple-darwin/release/mdshare "$DEST/bin-aarch64-apple-darwin"
cp mdshare/target/x86_64-apple-darwin/release/mdshare  "$DEST/bin-x86_64-apple-darwin"
chmod +x "$DEST"/bin-*-apple-darwin
strip      "$DEST"/bin-*-apple-darwin

echo "[mdshare] binaries written:"
ls -lh "$DEST"/bin-*-apple-darwin
```

Make it executable:

```bash
chmod +x scripts/build-mdshare.sh
```

- [ ] **Step 2: Add pnpm script**

Read `package.json`, then modify the `"scripts"` object to add a `build:mdshare` entry. The result should look like (preserving the existing scripts):

```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-check --tsconfig ./tsconfig.json",
    "tauri": "tauri",
    "test": "vitest run",
    "test:watch": "vitest",
    "build:mdshare": "bash scripts/build-mdshare.sh"
  },
```

- [ ] **Step 3: Smoke run**

Run: `pnpm build:mdshare 2>&1 | tail -10`
Expected: builds both targets, copies into `src-tauri/plugins/share/bin-*-apple-darwin`. Verify with `ls -lh src-tauri/plugins/share/`.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-mdshare.sh package.json src-tauri/plugins/share/bin-aarch64-apple-darwin src-tauri/plugins/share/bin-x86_64-apple-darwin
git commit -m "chore(share): build-mdshare script + pnpm script entry"
```

---

## Task 14: share manifest.json

**Files:**
- Create: `src-tauri/plugins/share/manifest.json`

The manifest is what makes the plugin discoverable to the platform at startup.

- [ ] **Step 1: Create manifest**

Create `src-tauri/plugins/share/manifest.json`:

```json
{
  "id": "share",
  "name": "Share",
  "version": "0.1.0",
  "description": "Publish current file as a shareable web page",
  "binary": "bin",
  "menus": [
    {
      "location": "file",
      "label": "Share Current File...",
      "shortcut": "Cmd+Shift+L",
      "command": "publish",
      "enabled_when": "currentTab.hasContent"
    },
    {
      "location": "file",
      "label": "Unshare Current File...",
      "command": "unpublish",
      "enabled_when": "settings[\"share.records\"][currentTab.path]"
    },
    {
      "location": "file",
      "label": "Copy Share Link",
      "command": "copy-link",
      "enabled_when": "settings[\"share.records\"][currentTab.path]"
    }
  ],
  "context_menus": [
    {
      "location": "tab",
      "label": "Share This Tab...",
      "command": "publish",
      "enabled_when": "currentTab.hasContent"
    }
  ],
  "settings": {
    "tab_label": "Share",
    "schema": [
      {
        "key": "share.baseUrl",
        "type": "string",
        "label": "Service Base URL",
        "default": "https://mdeditor-share.your-account.workers.dev",
        "placeholder": "https://share.example.com"
      },
      {
        "key": "share.apiKey",
        "type": "secret",
        "label": "API Key"
      },
      {
        "key": "share.defaultExpiry",
        "type": "select",
        "label": "Default expiry",
        "options": ["never", "7d", "30d", "90d"],
        "default": "never"
      },
      {
        "key": "share.slugRandomSuffix",
        "type": "boolean",
        "label": "Append 3-char random suffix to URL (recommended)",
        "default": true
      }
    ]
  },
  "host_capabilities": [
    "renderer.html",
    "settings.read",
    "settings.write:share.records",
    "clipboard.write",
    "toast",
    "dialog"
  ],
  "timeout_seconds": 30
}
```

- [ ] **Step 2: Smoke launch**

Run: `pnpm tauri dev` briefly. Open File menu → verify "Share Current File..." appears with "Cmd+Shift+L" shown. Without any tab open, the item is enabled (because `currentTab.hasContent` is false but no tab → `currentTab` is null and `hasContent` lookup returns `undefined` → falsy → disabled). Actually verify it IS disabled with no tab. Quit with Cmd+Q.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/plugins/share/manifest.json
git commit -m "feat(share): plugin manifest with menus, context menus, settings schema"
```

---

## Task 15: Worker scaffolding

**Files:**
- Create: `worker/package.json`
- Create: `worker/tsconfig.json`
- Create: `worker/wrangler.toml`
- Create: `worker/src/index.ts`

- [ ] **Step 1: package.json**

Create `worker/package.json`:

```json
{
  "name": "mdeditor-share-worker",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev",
    "test": "vitest run"
  },
  "devDependencies": {
    "wrangler": "^3",
    "@cloudflare/workers-types": "^4",
    "typescript": "^5",
    "vitest": "^4",
    "@cloudflare/vitest-pool-workers": "^0.5"
  }
}
```

- [ ] **Step 2: tsconfig.json**

Create `worker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "types": ["@cloudflare/workers-types"],
    "lib": ["ES2022"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: wrangler.toml**

Create `worker/wrangler.toml`:

```toml
name = "mdeditor-share"
main = "src/index.ts"
compatibility_date = "2026-05-01"

# Created via `wrangler kv:namespace create SHARES` and ID pasted in.
# Until then a placeholder is fine — `pnpm test` (Miniflare) doesn't need it.
kv_namespaces = [
  { binding = "SHARES", id = "0000000000000000000000000000000000" }
]

# Custom domain: uncomment after pointing DNS at Cloudflare.
# routes = [
#   { pattern = "share.example.com/*", custom_domain = true }
# ]
```

- [ ] **Step 4: Stub Worker entrypoint (will fail tests until later tasks)**

Create `worker/src/index.ts`:

```ts
export interface Env {
  SHARES: KVNamespace
  SHARE_API_KEY: string
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.slice(1) // strip leading slash
    if (req.method === 'POST' && path === 'publish') {
      return new Response('not implemented', { status: 501 })
    }
    if (req.method === 'GET' && path) {
      return new Response('not implemented', { status: 501 })
    }
    if (req.method === 'DELETE' && path) {
      return new Response('not implemented', { status: 501 })
    }
    return new Response('Not Found', { status: 404 })
  }
}
```

- [ ] **Step 5: Install + verify**

Run:
```bash
cd /Users/bruce/git/mdeditor/.worktrees/mdshare/worker
pnpm install 2>&1 | tail -5
```

Expected: deps install cleanly.

- [ ] **Step 6: Commit**

```bash
git add worker/package.json worker/tsconfig.json worker/wrangler.toml worker/src/index.ts worker/pnpm-lock.yaml
git commit -m "feat(worker): scaffolding — package.json, wrangler.toml, stub index.ts"
```

---

## Task 16: Worker POST /publish + GET /:slug

**Files:**
- Modify: `worker/src/index.ts`
- Create: `worker/tests/index.test.ts`
- Modify: `worker/package.json` (vitest config)
- Create: `worker/vitest.config.ts`

- [ ] **Step 1: vitest config for Workers**

Create `worker/vitest.config.ts`:

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: { SHARE_API_KEY: 'test-key' },
        },
      },
    },
  },
})
```

- [ ] **Step 2: Write failing tests for /publish + /:slug**

Create `worker/tests/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

const HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': 'Bearer test-key',
}

const VALID_SLUG = '2026-05-08-foo-x7k'
const VALID_TOKEN = 'a'.repeat(32)

describe('POST /publish', () => {
  it('rejects 401 without Authorization', async () => {
    const r = await SELF.fetch('http://x/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<p>x</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    expect(r.status).toBe(401)
  })

  it('rejects 400 on bad slug format', async () => {
    const r = await SELF.fetch('http://x/publish', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ slug: 'BADSLUG', edit_token: VALID_TOKEN, html: '<p>x</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    expect(r.status).toBe(400)
  })

  it('publishes a new share and returns 200 with URL', async () => {
    const r = await SELF.fetch('http://x/publish', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<p>hello</p>', metadata: { original_filename: 'foo.md', source_ext: 'md' } }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { slug: string; url: string }
    expect(body.slug).toBe(VALID_SLUG)
  })

  it('returns 409 when republishing same slug with wrong token', async () => {
    await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<p>v1</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    const r = await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: 'b'.repeat(32), html: '<p>v2</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    expect(r.status).toBe(409)
  })

  it('overwrites with matching token', async () => {
    await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<p>v1</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    const r = await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<p>v2</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    expect(r.status).toBe(200)
    const get = await SELF.fetch(`http://x/${VALID_SLUG}`)
    expect(await get.text()).toContain('v2')
  })
})

describe('GET /:slug', () => {
  it('returns 410 for missing slug', async () => {
    const r = await SELF.fetch('http://x/2026-01-01-doesnotexist-abc')
    expect(r.status).toBe(410)
    expect(r.headers.get('Content-Type')).toContain('text/html')
  })

  it('returns the stored HTML with proper headers', async () => {
    await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<!doctype html><p>page</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    const r = await SELF.fetch(`http://x/${VALID_SLUG}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('Content-Type')).toContain('text/html')
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex')
    expect(await r.text()).toContain('<p>page</p>')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd worker && pnpm -s test 2>&1 | tail -15`
Expected: tests fail (501 from stubs).

- [ ] **Step 4: Implement /publish + /:slug in worker/src/index.ts**

Replace `worker/src/index.ts`:

```ts
export interface Env {
  SHARES: KVNamespace
  SHARE_API_KEY: string
}

const SLUG_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?$/
const TOKEN_RE = /^[a-zA-Z0-9]{16,128}$/
const MAX_HTML_BYTES = 25 * 1024 * 1024

interface PublishBody {
  slug: string
  edit_token: string
  html: string
  expires_in_seconds?: number
  metadata: { original_filename: string; source_ext: string }
}

interface KvMeta {
  edit_token: string
  created_at: string
  expires_at: string | null
  original_filename: string
  source_ext: string
  size_bytes: number
}

const NOT_FOUND_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Link expired — M↓</title>
<style>body{font-family:system-ui,sans-serif;max-width:36em;margin:6em auto;padding:0 1em;color:#333}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}}</style>
</head><body>
<h1>This share link doesn't exist or has expired.</h1>
<p><small>Powered by <a href="https://github.com/wizlijun/MdEditor">M↓</a>.</small></p>
</body></html>`

function unauthorized(req: Request, env: Env): boolean {
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return true
  return auth.slice('Bearer '.length) !== env.SHARE_API_KEY
}

async function handlePublish(req: Request, env: Env, baseUrl: string): Promise<Response> {
  if (unauthorized(req, env)) return new Response('Unauthorized', { status: 401 })
  let body: PublishBody
  try {
    body = await req.json() as PublishBody
  } catch {
    return new Response('Bad JSON', { status: 400 })
  }
  if (!body || typeof body.slug !== 'string' || !SLUG_RE.test(body.slug)) {
    return new Response('Bad slug', { status: 400 })
  }
  if (!TOKEN_RE.test(body.edit_token ?? '')) return new Response('Bad edit_token', { status: 400 })
  if (typeof body.html !== 'string') return new Response('Bad html', { status: 400 })
  if (new TextEncoder().encode(body.html).byteLength > MAX_HTML_BYTES) {
    return new Response('Payload too large', { status: 413 })
  }

  const existing = await env.SHARES.getWithMetadata<KvMeta>(body.slug)
  let createdAt: string
  if (existing.value && existing.metadata) {
    if (existing.metadata.edit_token !== body.edit_token) {
      return new Response(JSON.stringify({ error: 'slug_conflict' }), { status: 409 })
    }
    createdAt = existing.metadata.created_at
  } else {
    createdAt = new Date().toISOString()
  }

  const expirationTtl = body.expires_in_seconds && body.expires_in_seconds > 60
    ? body.expires_in_seconds : undefined
  const expiresAt = expirationTtl
    ? new Date(Date.now() + expirationTtl * 1000).toISOString() : null

  const meta: KvMeta = {
    edit_token: body.edit_token,
    created_at: createdAt,
    expires_at: expiresAt,
    original_filename: body.metadata?.original_filename ?? '',
    source_ext: body.metadata?.source_ext ?? '',
    size_bytes: new TextEncoder().encode(body.html).byteLength,
  }
  await env.SHARES.put(body.slug, body.html, {
    metadata: meta,
    ...(expirationTtl ? { expirationTtl } : {}),
  })

  return new Response(JSON.stringify({
    slug: body.slug,
    edit_token: body.edit_token,
    url: `${baseUrl}/${body.slug}`,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleGet(slug: string, env: Env): Promise<Response> {
  if (!SLUG_RE.test(slug)) {
    return new Response(NOT_FOUND_HTML, { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }
  const result = await env.SHARES.getWithMetadata<KvMeta>(slug)
  if (!result.value) {
    return new Response(NOT_FOUND_HTML, { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }
  return new Response(result.value, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=86400',
      'X-Robots-Tag': 'noindex',
    },
  })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.slice(1)
    const baseUrl = `${url.protocol}//${url.host}`
    if (req.method === 'POST' && path === 'publish') return handlePublish(req, env, baseUrl)
    if (req.method === 'GET' && path) return handleGet(path, env)
    if (req.method === 'DELETE' && path) return new Response('not implemented', { status: 501 })
    return new Response('Not Found', { status: 404 })
  }
}
```

- [ ] **Step 5: Run tests**

Run: `cd worker && pnpm -s test 2>&1 | tail -15`
Expected: 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.ts worker/tests/index.test.ts worker/vitest.config.ts worker/package.json worker/pnpm-lock.yaml
git commit -m "feat(worker): POST /publish + GET /:slug with KV storage"
```

---

## Task 17: Worker DELETE /:slug

**Files:**
- Modify: `worker/src/index.ts`
- Modify: `worker/tests/index.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `worker/tests/index.test.ts`:

```ts
describe('DELETE /:slug', () => {
  it('rejects 401 without Authorization', async () => {
    const r = await SELF.fetch('http://x/2026-05-08-x-aaa', {
      method: 'DELETE',
      body: JSON.stringify({ edit_token: VALID_TOKEN }),
    })
    expect(r.status).toBe(401)
  })

  it('returns 404 for missing slug', async () => {
    const r = await SELF.fetch('http://x/2026-05-08-x-aaa', {
      method: 'DELETE',
      headers: HEADERS,
      body: JSON.stringify({ edit_token: VALID_TOKEN }),
    })
    expect(r.status).toBe(404)
  })

  it('returns 403 for token mismatch', async () => {
    await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<p>x</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    const r = await SELF.fetch(`http://x/${VALID_SLUG}`, {
      method: 'DELETE',
      headers: HEADERS,
      body: JSON.stringify({ edit_token: 'z'.repeat(32) }),
    })
    expect(r.status).toBe(403)
  })

  it('deletes with matching token (204)', async () => {
    await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<p>x</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    const r = await SELF.fetch(`http://x/${VALID_SLUG}`, {
      method: 'DELETE',
      headers: HEADERS,
      body: JSON.stringify({ edit_token: VALID_TOKEN }),
    })
    expect(r.status).toBe(204)
    const get = await SELF.fetch(`http://x/${VALID_SLUG}`)
    expect(get.status).toBe(410)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && pnpm -s test 2>&1 | tail -15`
Expected: 4 new tests fail.

- [ ] **Step 3: Implement DELETE handler**

In `worker/src/index.ts`, add `handleDelete`:

```ts
async function handleDelete(slug: string, req: Request, env: Env): Promise<Response> {
  if (unauthorized(req, env)) return new Response('Unauthorized', { status: 401 })
  if (!SLUG_RE.test(slug)) return new Response('Bad slug', { status: 400 })
  let body: { edit_token?: string }
  try { body = await req.json() } catch { return new Response('Bad JSON', { status: 400 }) }
  if (!TOKEN_RE.test(body?.edit_token ?? '')) return new Response('Bad edit_token', { status: 400 })

  const existing = await env.SHARES.getWithMetadata<KvMeta>(slug)
  if (!existing.value || !existing.metadata) {
    return new Response('Not Found', { status: 404 })
  }
  if (existing.metadata.edit_token !== body.edit_token) {
    return new Response('Forbidden', { status: 403 })
  }
  await env.SHARES.delete(slug)
  return new Response(null, { status: 204 })
}
```

Replace the `DELETE` arm in the default `fetch`:

```ts
    if (req.method === 'DELETE' && path) return handleDelete(path, req, env)
```

- [ ] **Step 4: Run tests**

Run: `cd worker && pnpm -s test 2>&1 | tail -15`
Expected: 11 tests pass total.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.ts worker/tests/index.test.ts
git commit -m "feat(worker): DELETE /:slug with edit_token verification"
```

---

## Task 18: Worker README + deploy docs

**Files:**
- Create: `worker/README.md`

- [ ] **Step 1: Write README**

Create `worker/README.md`:

````markdown
# mdeditor-share Worker

Cloudflare Worker backing the M↓ "Share" plugin. Three routes, KV-backed.

## Routes

- `POST /publish` — `Authorization: Bearer <SHARE_API_KEY>`. Body: `{slug, edit_token, html, expires_in_seconds?, metadata}`.
- `GET /:slug` — public; returns the stored HTML or a 410 page.
- `DELETE /:slug` — `Authorization: Bearer <SHARE_API_KEY>`. Body: `{edit_token}`.

## One-time setup

```bash
cd worker
pnpm install
wrangler login

# Create the KV namespace; copy the printed `id` into `kv_namespaces[0].id`
# inside wrangler.toml.
wrangler kv:namespace create SHARES

# Generate and store the API key as a secret. Use the same value in M↓
# Preferences → Share → API Key.
openssl rand -hex 32 | wrangler secret put SHARE_API_KEY

# Deploy.
wrangler deploy
```

The deploy step prints the public URL (`https://mdeditor-share.<account>.workers.dev`).
Paste this into M↓ Preferences → Share → Service Base URL.

## Custom domain (optional)

1. Make sure your domain is on Cloudflare (DNS proxied through Cloudflare).
2. Uncomment the `routes` block in `wrangler.toml` and set the pattern to your subdomain.
3. `wrangler deploy` again.

## Local development

```bash
pnpm dev        # wrangler dev with Miniflare
pnpm test       # vitest + Miniflare
```

## Storage layout

```
SHARES (KV namespace)
  key:      <slug>                       e.g. 2026-05-08-trip-notes-x7k
  value:    <self-contained HTML blob>
  metadata: {edit_token, created_at, expires_at, original_filename,
             source_ext, size_bytes}
  TTL:      respects `expires_in_seconds` from publish requests
```
````

- [ ] **Step 2: Commit**

```bash
git add worker/README.md
git commit -m "docs(worker): deployment + setup README"
```

---

## Task 19: README smoke checklist 49-56

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append items 49-56**

Read `README.md`, find the end of the smoke checklist (last item is 48). Append:

```md
49. **Plugin: install share** — run `pnpm build:mdshare`, then in `worker/`
    deploy via `wrangler deploy` and copy the URL + API key into M↓
    Preferences → Share. Restart M↓.
50. `Cmd+Shift+L` on a saved markdown file → toast "✅ 分享成功（已复制）：…";
    paste from clipboard → URL works in browser.
51. Same file, edit a paragraph, `Cmd+Shift+L` again → toast "✅ 内容已更新（链接已复制）";
    same URL still in clipboard; recipient page reflects new content.
52. File → Unshare Current File → toast "✅ 已撤销分享"; reload recipient
    page → 410 page shown.
53. Right-click a tab → "Share This Tab..." appears; click → publishes.
54. Open M↓ on iPhone Safari → recipient page is readable, no horizontal
    scroll, code blocks scroll within their container.
55. Switch system to dark mode → recipient page automatically switches.
56. Disconnect network, click `Cmd+Shift+L` → toast "❌ Share: 网络错误";
    M↓ remains responsive throughout.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): smoke checklist items 49-56 for share plugin"
```

---

## Self-Review

**Spec coverage check** (each requirement → task):

- ✅ Q1.A pre-render in host → Tasks 2-5 (share-baker)
- ✅ Q2.B idempotent updates → Task 9 (publish detects existing record, reuses slug)
- ✅ Q2.C optional expiry → Task 9 (defaultExpiry → expires_in_seconds → KV TTL)
- ✅ Q3.A SHARE_API_KEY → Task 16 (worker checks Authorization)
- ✅ Q4.D slug rules → Task 8 (slug.rs)
- ✅ Q5.A image inlining → Task 4
- ✅ Q6.A KV only → Task 16 (single binding)
- ✅ Q7.C configurable domain → Task 14 (manifest baseUrl with default)
- ✅ Q8.A minimal menu + Cmd+Shift+L → Task 14 (manifest)
- ✅ Q9.1A silent overwrite → Task 9 (no confirmation prompt)
- ✅ Q9.2A default expiry in Prefs → Task 14 (settings schema)
- ✅ Q9.3C menu + Preferences both unshare → Task 14 (menu) + existing Preferences UI auto-renders schema
- ✅ Q9.4 size check → Task 5 (guardSize) + Task 16 (Worker 413)
- ✅ Q9.5 toast on errors → Tasks 9-11 (toast_error helper)
- ✅ Q10.1B double theme → Task 2 (themeCssBlock)
- ✅ Q10.2B minimal shell → Task 5 (header/footer)
- ✅ Q10.3A minimal 410 page → Task 16 (NOT_FOUND_HTML)
- ✅ Mobile-optimized viewport → Task 2 (viewportMetaTag) + Task 5 (used in template)
- ✅ Platform extension (computed bracket index) → Task 1
- ✅ Wiring htmlBaker → Task 6
- ✅ Bundle binaries → Task 13
- ✅ Smoke documentation → Task 19

**Placeholder scan:** No "TBD", "TODO", "implement later", or
"add appropriate error handling" patterns. All steps include actual code.

**Type consistency:**
- Rust types `Request` / `Context` / `TabMeta` / `Response` / `Action` defined in Task 7, used consistently in Tasks 9-11.
- `KvMeta` interface defined in Task 16 (publish), used in Task 17 (delete).
- `Env` interface defined in Task 15 (scaffold), used in Tasks 16-17.
- Frontend `bakeShareHtml(tab)` signature: `(Tab) => Promise<string>` — defined Task 5, used Task 6.
- `__setImageReaderForTests` test seam mirrors action-handlers' `configureActionHandlers` pattern — consistent.

**Open issues found and fixed inline:**
- Originally Task 12 referenced HTTP testing but no mock server is provided. Refactored
  to test only no-network paths (copy-link, unknown command, missing baseUrl, invalid JSON).
  HTTP path coverage comes from manual smoke test 50-56.
- Initial draft had Task 14 ordered before Task 13 — but the manifest references the
  binary which Task 13 produces. Reordered: Task 13 (build script) → Task 14 (manifest).
- Confirmed `enabled_when: settings["share.records"][currentTab.path]` requires Task 1's
  parser extension (computed bracket index). Task 1 ships before Task 14.

No further gaps.
