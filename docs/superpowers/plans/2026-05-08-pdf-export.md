# PDF Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "File → Export to PDF…" menu item that produces a typographically elegant A4 PDF from the active Markdown or HTML tab.

**Architecture:** Frontend renders the markdown/html to fully-settled static HTML in a hidden staging div (waits for fonts, images, mermaid). Static HTML + base-URL is handed to a Rust command that spins up an offscreen `WKWebView`, loads the HTML, and calls `createPDF` (macOS 11+). Result written to user-chosen path.

**Tech Stack:** Svelte 5, marked.js (already in @moraya/core's dep tree), KaTeX, highlight.js, mermaid (already vendored), Rust + objc2 + objc2-web-kit for the macOS WKWebView FFI bridge, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-08-pdf-export-design.md`

---

## File Structure

**Create:**
- `src/lib/pdf-export.ts` — Frontend orchestrator + pure helpers
- `src/lib/pdf-export.test.ts` — vitest for pure helpers
- `src/styles/pdf.css` — Print stylesheet (A4 + typography + page rules)
- `src-tauri/src/pdf.rs` — Rust `export_pdf` command using WKWebView

**Modify:**
- `src-tauri/Cargo.toml` — add objc2-web-kit / objc2-foundation / block2 deps
- `src-tauri/src/lib.rs` — `mod pdf;` + invoke_handler + File submenu item
- `src/App.svelte` — `'export-pdf'` menu-event branch
- `src/lib/commands.ts` — new `cmdExportPdf()`
- `README.md` — smoke checklist items 31-39

**Convention:** Each task ends with one commit. Use conventional-commits prefixes.

---

## Task 1: Pure helpers — `extractH1FromMarkdown`, `suggestedPdfFilename`, `buildPdfTitle`, `htmlEscape`

**Files:**
- Create: `src/lib/pdf-export.ts`
- Create: `src/lib/pdf-export.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/pdf-export.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  extractH1FromMarkdown,
  suggestedPdfFilename,
  buildPdfTitle,
  htmlEscape,
} from './pdf-export'

describe('extractH1FromMarkdown', () => {
  it('returns the first ATX H1', () => {
    expect(extractH1FromMarkdown('# Hello World\n\ntext')).toBe('Hello World')
  })
  it('skips leading whitespace and finds H1', () => {
    expect(extractH1FromMarkdown('\n\n# Title\nbody')).toBe('Title')
  })
  it('returns null when no H1 present', () => {
    expect(extractH1FromMarkdown('## sub\nplain text')).toBe(null)
    expect(extractH1FromMarkdown('')).toBe(null)
  })
  it('does not match setext-style underline (===)', () => {
    expect(extractH1FromMarkdown('Title\n=====\nbody')).toBe(null)
  })
  it('trims trailing whitespace and hash', () => {
    expect(extractH1FromMarkdown('#   Padded   #\n')).toBe('Padded')
  })
  it('finds H1 even when not at top (after frontmatter etc.)', () => {
    expect(extractH1FromMarkdown('---\nfoo: bar\n---\n\n# After Front')).toBe('After Front')
  })
})

describe('suggestedPdfFilename', () => {
  it('replaces extension with .pdf', () => {
    expect(suggestedPdfFilename('/tmp/foo.md')).toBe('foo.pdf')
    expect(suggestedPdfFilename('report.markdown')).toBe('report.pdf')
  })
  it('handles names without extension', () => {
    expect(suggestedPdfFilename('Dockerfile')).toBe('Dockerfile.pdf')
    expect(suggestedPdfFilename('/path/to/Makefile')).toBe('Makefile.pdf')
  })
  it('takes only the basename', () => {
    expect(suggestedPdfFilename('/Users/foo/Documents/notes.md')).toBe('notes.pdf')
  })
  it('handles dotfiles by appending .pdf', () => {
    expect(suggestedPdfFilename('/proj/.env')).toBe('.env.pdf')
  })
})

describe('buildPdfTitle', () => {
  const tab = (overrides: Record<string, unknown> = {}) => ({
    id: 'x', filePath: '/tmp/foo.md', title: 'foo.md',
    initialContent: '', currentContent: '', mode: 'source' as const,
    kind: 'markdown' as const,
    externalState: 'fresh' as const,
    externalBannerDismissed: false,
    lastKnownMtime: 0, lastKnownHash: '',
    ...overrides,
  })

  it('uses H1 when present in markdown', () => {
    expect(buildPdfTitle(tab({ currentContent: '# My Doc\nbody' }))).toBe('My Doc')
  })
  it('falls back to basename without extension', () => {
    expect(buildPdfTitle(tab({ currentContent: 'no headings here' }))).toBe('foo')
  })
  it('uses basename for HTML tabs (no markdown parsing)', () => {
    expect(buildPdfTitle(tab({
      filePath: '/tmp/page.html', kind: 'html',
      currentContent: '<h1>Inside HTML</h1>',
    }))).toBe('page')
  })
})

describe('htmlEscape', () => {
  it('escapes the four html-significant characters', () => {
    expect(htmlEscape('<a href="x">&copy;</a>'))
      .toBe('&lt;a href=&quot;x&quot;&gt;&amp;copy;&lt;/a&gt;')
  })
  it('passes plain text through', () => {
    expect(htmlEscape('Hello World')).toBe('Hello World')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -s test src/lib/pdf-export.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

Create `src/lib/pdf-export.ts`:

```ts
import { basename } from './fs'
import type { Tab } from './tabs.svelte'

/**
 * Extract the first ATX-style `# ` heading text from markdown source.
 * Setext-style (`Title\n===`) is intentionally not supported — too rare in
 * the wild and complicates the regex.
 *
 * @returns the heading text, trimmed of leading/trailing `#` and whitespace,
 *          or `null` if no H1 is present
 */
export function extractH1FromMarkdown(md: string): string | null {
  const match = md.match(/^[ \t]*#[ \t]+(.+?)[ \t#]*$/m)
  return match ? match[1].trim() : null
}

/**
 * Suggest a default `.pdf` filename for a source file's path.
 * Strips one extension if present; appends `.pdf` either way.
 *
 *   /tmp/foo.md         → foo.pdf
 *   /path/to/Dockerfile → Dockerfile.pdf
 *   /proj/.env          → .env.pdf       (dotfile → keep full name)
 */
export function suggestedPdfFilename(filePath: string): string {
  const base = basename(filePath)
  const dot = base.lastIndexOf('.')
  // dot <= 0 catches both "no extension" (-1) and "dotfile" (0)
  const stem = dot <= 0 ? base : base.slice(0, dot)
  return `${stem}.pdf`
}

/** Title that goes in the PDF header (and `<title>`). */
export function buildPdfTitle(tab: Tab): string {
  if (tab.kind === 'markdown') {
    const h1 = extractH1FromMarkdown(tab.currentContent)
    if (h1) return h1
  }
  // Fallback: basename without extension
  const base = basename(tab.filePath)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

/** Escape the four HTML-significant characters for safe insertion as text. */
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -s test src/lib/pdf-export.test.ts`
Expected: PASS — all helpers green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pdf-export.ts src/lib/pdf-export.test.ts
git commit -m "feat(pdf-export): pure helpers extractH1 / suggestedFilename / title / htmlEscape"
```

---

## Task 2: `wrapInPrintTemplate` — assemble self-contained HTML doc

**Files:**
- Modify: `src/lib/pdf-export.ts` (append)
- Modify: `src/lib/pdf-export.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/pdf-export.test.ts`:

```ts
import { wrapInPrintTemplate } from './pdf-export'

describe('wrapInPrintTemplate', () => {
  const inputBody = '<h1>Title</h1><p>Body</p>'

  it('produces an HTML5 document with utf-8 charset', () => {
    const out = wrapInPrintTemplate(inputBody, 'My Doc')
    expect(out).toMatch(/^<!doctype html>/i)
    expect(out).toContain('<meta charset="utf-8">')
  })

  it('escapes the title in <title> and on data-pdf-title', () => {
    const out = wrapInPrintTemplate(inputBody, 'A & B <c>')
    expect(out).toContain('<title>A &amp; B &lt;c&gt;</title>')
    expect(out).toContain('data-pdf-title="A &amp; B &lt;c&gt;"')
  })

  it('inlines the print stylesheet (non-empty <style> block)', () => {
    const out = wrapInPrintTemplate(inputBody, 'X')
    // The injected <style> for pdf.css should be substantial — assert it
    // contains a sentinel rule we know lives in pdf.css.
    expect(out).toMatch(/@page\s*{[^}]*size:\s*A4/)
  })

  it('places the body html inside <body>', () => {
    const out = wrapInPrintTemplate(inputBody, 'X')
    const bodyMatch = out.match(/<body[^>]*>([\s\S]*?)<\/body>/)
    expect(bodyMatch?.[1]).toContain(inputBody)
  })

  it('includes lang attr on <html>', () => {
    const out = wrapInPrintTemplate(inputBody, 'X')
    expect(out).toMatch(/<html\s+lang="en"/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s test src/lib/pdf-export.test.ts -t wrapInPrintTemplate`
Expected: FAIL — `wrapInPrintTemplate` not exported.

- [ ] **Step 3: Implement `wrapInPrintTemplate`**

Append to `src/lib/pdf-export.ts`:

```ts
import pdfCss from '../styles/pdf.css?raw'

/**
 * Assemble a fully self-contained HTML5 document suitable for handing to
 * WKWebView. All CSS is inlined so the offscreen webview need not fetch
 * external resources.
 */
export function wrapInPrintTemplate(bodyHtml: string, title: string): string {
  const escTitle = htmlEscape(title)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escTitle}</title>
  <style>${pdfCss}</style>
</head>
<body data-pdf-title="${escTitle}">
${bodyHtml}
</body>
</html>`
}
```

(Note: `?raw` is a Vite import suffix — pulls the file's contents as a
string. The file `src/styles/pdf.css` doesn't exist yet; Task 3 creates it.
For Step 4 below, use a temporary stub.)

- [ ] **Step 4: Create a stub pdf.css so the test passes**

Create `src/styles/pdf.css` with a minimal stub:

```css
@page { size: A4; margin: 25mm 20mm; }
```

(Task 3 will replace this with the full template.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -s test src/lib/pdf-export.test.ts`
Expected: PASS — all tests including new `wrapInPrintTemplate` block.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pdf-export.ts src/lib/pdf-export.test.ts src/styles/pdf.css
git commit -m "feat(pdf-export): wrapInPrintTemplate assembles self-contained HTML doc"
```

---

## Task 3: Print stylesheet `pdf.css`

**Files:**
- Modify: `src/styles/pdf.css` (replace stub with full template)

- [ ] **Step 1: Write the stylesheet**

Replace `src/styles/pdf.css` with:

```css
/* === Page setup === */
@page {
  size: A4;
  margin: 25mm 20mm;
  @top-center {
    content: attr(data-pdf-title);
    font-family: -apple-system, system-ui, sans-serif;
    font-size: 9pt;
    color: #555;
    margin-top: 12mm;
  }
  @bottom-right {
    content: counter(page) " / " counter(pages);
    font-family: -apple-system, system-ui, sans-serif;
    font-size: 9pt;
    color: #555;
    margin-bottom: 12mm;
  }
}
@page :first {
  @top-center { content: none; }
}

/* === Reset & body === */
* { box-sizing: border-box; }
body {
  font-family: 'Charter', 'Iowan Old Style', 'Georgia', serif;
  font-size: 11pt;
  line-height: 1.7;
  color: #1a1a1a;
  background: white;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  margin: 0;
}

/* === Headings === */
h1 {
  font-family: -apple-system, system-ui, sans-serif;
  font-size: 22pt;
  font-weight: 700;
  line-height: 1.25;
  margin: 0 0 0.6em 0;
  break-after: avoid;
}
h2 {
  font-family: -apple-system, system-ui, sans-serif;
  font-size: 16pt;
  font-weight: 600;
  margin: 1.6em 0 0.4em 0;
  break-after: avoid;
}
h3 {
  font-family: -apple-system, system-ui, sans-serif;
  font-size: 13pt;
  font-weight: 600;
  margin: 1.3em 0 0.3em 0;
  break-after: avoid;
}
h4 {
  font-size: 11pt;
  font-weight: 600;
  margin: 1em 0 0.3em 0;
  break-after: avoid;
}

/* === Paragraphs / lists === */
p { margin: 0 0 0.7em 0; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 0.7em 0; padding-left: 1.4em; }
li { margin-bottom: 0.2em; }
li > p { margin-bottom: 0.3em; }

/* === Inline code & code blocks === */
code {
  font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
  font-size: 9.5pt;
  background: #f4f4f4;
  padding: 1px 5px;
  border-radius: 3px;
}
pre {
  font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
  font-size: 9.5pt;
  line-height: 1.5;
  background: #f8f8fa;
  border: 1px solid #e1e4e8;
  border-radius: 4px;
  padding: 0.9em 1.1em;
  margin: 0.8em 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  break-inside: avoid;
}
pre code { background: transparent; padding: 0; font-size: inherit; }

/* === Blockquote === */
blockquote {
  margin: 0.8em 0;
  padding: 0.4em 1em;
  border-left: 3px solid #d0d7de;
  color: #555;
  background: #fafbfc;
}

/* === Tables === */
table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8em 0;
  break-inside: avoid;
  font-size: 10pt;
}
th, td {
  padding: 6px 10px;
  border: 1px solid #d0d7de;
  text-align: left;
  vertical-align: top;
}
th { background: #f6f8fa; font-weight: 600; }

/* === Images / figures === */
img { max-width: 100%; height: auto; break-inside: avoid; }
figure { margin: 0.8em 0; break-inside: avoid; }
figcaption {
  font-size: 9pt;
  color: #555;
  text-align: center;
  margin-top: 0.3em;
}

/* === Math (KaTeX) === */
.katex-display { margin: 0.8em 0; break-inside: avoid; overflow-wrap: anywhere; }
.katex { font-size: 11pt; }

/* === Mermaid === */
.mermaid {
  display: block;
  max-width: 100%;
  margin: 0.8em auto;
  break-inside: avoid;
}
.mermaid svg { max-width: 100%; height: auto; }

/* === Horizontal rule === */
hr { border: 0; border-top: 1px solid #d0d7de; margin: 1.5em 0; }

/* === Links: keep visible color, do not auto-append URL === */
a { color: #0366d6; text-decoration: none; }
```

- [ ] **Step 2: Verify tests still pass**

Run: `pnpm -s test src/lib/pdf-export.test.ts`
Expected: PASS — `wrapInPrintTemplate` test that asserts `@page { size: A4 }` still finds it.

- [ ] **Step 3: Commit**

```bash
git add src/styles/pdf.css
git commit -m "feat(pdf-export): elegant print stylesheet (A4 + serif body + page rules)"
```

---

## Task 4: `renderForPrint` — staging div + async settling

**Files:**
- Modify: `src/lib/pdf-export.ts` (append)
- Modify: `src/lib/pdf-export.test.ts` (append happy-dom test)

- [ ] **Step 1: Add happy-dom directive at top of pdf-export.test.ts**

Add this directive to the very first line of `src/lib/pdf-export.test.ts` (above the existing `import` statements):

```ts
/**
 * @vitest-environment happy-dom
 */
```

(happy-dom was installed in the file-watcher feature; it provides `document`,
`window`, `Image`, etc.)

- [ ] **Step 2: Write the failing test**

Append to `src/lib/pdf-export.test.ts`:

```ts
import { renderForPrint } from './pdf-export'

describe('renderForPrint', () => {
  it('renders markdown body to HTML and returns a full document', async () => {
    const tab = {
      id: 'x', filePath: '/tmp/foo.md', title: 'foo.md',
      initialContent: '# Hi\n\nbody', currentContent: '# Hi\n\nbody',
      mode: 'source' as const,
      kind: 'markdown' as const,
      externalState: 'fresh' as const,
      externalBannerDismissed: false,
      lastKnownMtime: 0, lastKnownHash: '',
    }
    const html = await renderForPrint(tab)
    expect(html).toMatch(/^<!doctype html>/i)
    expect(html).toContain('<h1')
    expect(html).toContain('Hi')
    expect(html).toMatch(/<body[^>]*data-pdf-title="Hi"/)
  })

  it('renders html body verbatim inside print template', async () => {
    const tab = {
      id: 'y', filePath: '/tmp/page.html', title: 'page.html',
      initialContent: '', currentContent: '<h1>Hello</h1><p>World</p>',
      mode: 'source' as const,
      kind: 'html' as const,
      externalState: 'fresh' as const,
      externalBannerDismissed: false,
      lastKnownMtime: 0, lastKnownHash: '',
    }
    const html = await renderForPrint(tab)
    expect(html).toContain('<h1>Hello</h1>')
    expect(html).toContain('<p>World</p>')
    expect(html).toMatch(/data-pdf-title="page"/)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -s test src/lib/pdf-export.test.ts -t renderForPrint`
Expected: FAIL — `renderForPrint` not exported.

- [ ] **Step 4: Add `marked` + KaTeX/hljs marked plugins**

Run: `pnpm add marked marked-katex-extension marked-highlight highlight.js`

These four:
- `marked` — markdown → HTML
- `marked-katex-extension` — render `$...$` and `$$...$$` to KaTeX inline
- `marked-highlight` — apply hljs class names to code blocks
- `highlight.js` — actual syntax highlighter (sync)

KaTeX is already installed (used by RichEditor). Mermaid integration is
deferred to a follow-up task (see Notes section) because it's async per-block
and shares state with the existing renderer-registry.

Verify all four in `package.json`:

```bash
grep -E '"marked"|"marked-katex|"marked-highlight|"highlight\.js"' package.json
```

- [ ] **Step 4b: Add a test that KaTeX renders inline math**

Append to `src/lib/pdf-export.test.ts`:

```ts
describe('renderForPrint with KaTeX + hljs', () => {
  it('renders $...$ as KaTeX HTML (not raw dollars)', async () => {
    const tab = {
      id: 'k', filePath: '/tmp/eq.md', title: 'eq.md',
      initialContent: '', currentContent: 'Mass-energy: $E=mc^2$ done.',
      mode: 'source' as const, kind: 'markdown' as const,
      externalState: 'fresh' as const, externalBannerDismissed: false,
      lastKnownMtime: 0, lastKnownHash: '',
    }
    const html = await renderForPrint(tab)
    expect(html).toContain('class="katex"')
    expect(html).not.toMatch(/\$E=mc\^2\$/)
  })

  it('applies hljs class names to fenced code blocks', async () => {
    const tab = {
      id: 'c', filePath: '/tmp/code.md', title: 'code.md',
      initialContent: '',
      currentContent: '```js\nconst x = 1\n```',
      mode: 'source' as const, kind: 'markdown' as const,
      externalState: 'fresh' as const, externalBannerDismissed: false,
      lastKnownMtime: 0, lastKnownHash: '',
    }
    const html = await renderForPrint(tab)
    expect(html).toMatch(/class="hljs language-js"/)
  })
})
```

- [ ] **Step 5: Implement `renderForPrint` with KaTeX + hljs integration**

Append to `src/lib/pdf-export.ts`:

```ts
import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'
import type { Tab } from './tabs.svelte'

/**
 * A marked instance with KaTeX + hljs plugins installed. Module-scoped so
 * the plugin setup only runs once.
 */
const printMarked = new Marked(
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
 * Render the tab's content to a fully-settled, self-contained HTML document
 * ready to hand off to the Rust PDF generator.
 *
 * For markdown tabs: marked + marked-katex-extension + marked-highlight (hljs).
 *   Mermaid is NOT yet integrated — fenced ```mermaid blocks render as
 *   plain code blocks in v1. Follow-up task adds mermaid.
 *
 * For HTML tabs: the content is wrapped verbatim in the print template.
 *
 * Awaits font loading and image loading before returning, so the static HTML
 * is layout-stable in the offscreen WKWebView.
 */
export async function renderForPrint(tab: Tab): Promise<string> {
  let bodyHtml: string
  if (tab.kind === 'markdown') {
    bodyHtml = await printMarked.parse(tab.currentContent, { async: true })
  } else if (tab.kind === 'html') {
    bodyHtml = tab.currentContent
  } else {
    throw new Error(`PDF export does not support ${tab.kind} tabs`)
  }

  // Mount a hidden staging element so we can await async settling on real
  // DOM (fonts, images). Subscribe to fonts.ready and image load events.
  const staging = document.createElement('div')
  staging.id = 'pdf-staging'
  staging.setAttribute(
    'style',
    'position:absolute;left:-10000px;top:0;width:170mm;visibility:hidden;',
  )
  staging.innerHTML = bodyHtml
  document.body.appendChild(staging)

  try {
    // Fonts (no-op in happy-dom; behaves correctly in WKWebView)
    if ((document as Document & { fonts?: { ready: Promise<unknown> } }).fonts) {
      await (document as Document & { fonts: { ready: Promise<unknown> } }).fonts.ready
    }
    // Images
    const imgs = Array.from(staging.querySelectorAll('img'))
    await Promise.all(
      imgs.map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise<void>((r) => {
              img.addEventListener('load', () => r(), { once: true })
              img.addEventListener('error', () => r(), { once: true })
            }),
      ),
    )
    // Re-extract serialized HTML after any DOM mutations
    bodyHtml = staging.innerHTML
  } finally {
    staging.remove()
  }

  const title = buildPdfTitle(tab)
  return wrapInPrintTemplate(bodyHtml, title)
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm -s test src/lib/pdf-export.test.ts`
Expected: PASS — all tests including renderForPrint.

- [ ] **Step 7: Inline KaTeX CSS into the print template**

KaTeX renders to HTML that *requires* its accompanying stylesheet to display
math correctly. The print template needs to include it.

Update `src/lib/pdf-export.ts`'s template assembly. Change:

```ts
import pdfCss from '../styles/pdf.css?raw'
```

to also import the KaTeX stylesheet:

```ts
import pdfCss from '../styles/pdf.css?raw'
import katexCss from 'katex/dist/katex.min.css?raw'
```

And update `wrapInPrintTemplate` to inline both:

```ts
export function wrapInPrintTemplate(bodyHtml: string, title: string): string {
  const escTitle = htmlEscape(title)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escTitle}</title>
  <style>${katexCss}</style>
  <style>${pdfCss}</style>
</head>
<body data-pdf-title="${escTitle}">
${bodyHtml}
</body>
</html>`
}
```

(KaTeX CSS first; pdf.css last so it can override KaTeX font sizing if needed.
The earlier `wrapInPrintTemplate` test that asserts `@page { size: A4 }` will
still pass — the regex looks for the rule anywhere.)

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm -s test src/lib/pdf-export.test.ts`
Expected: PASS — all tests including the KaTeX/hljs integration tests.

- [ ] **Step 9: Commit**

```bash
git add src/lib/pdf-export.ts src/lib/pdf-export.test.ts package.json pnpm-lock.yaml
git commit -m "feat(pdf-export): renderForPrint with KaTeX + hljs + staging-div async settle"
```

---

## Task 5: Rust deps + dummy `export_pdf` command

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/pdf.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add Rust dependencies**

Edit `src-tauri/Cargo.toml` and update the macOS-only target dependencies block to include the WKWebView FFI crates:

```toml
[target.'cfg(target_os = "macos")'.dependencies]
core-foundation = "0.10"
objc2 = "0.5"
objc2-foundation = { version = "0.2", features = [
  "NSString",
  "NSURL",
  "NSData",
  "NSError",
  "NSValue",
  "NSGeometry",
] }
objc2-app-kit = { version = "0.2", features = [
  "NSApplication",
  "NSWindow",
  "NSView",
] }
objc2-web-kit = { version = "0.2", features = [
  "WKWebView",
  "WKWebViewConfiguration",
  "WKNavigationDelegate",
  "WKNavigation",
  "WKPDFConfiguration",
] }
block2 = "0.5"
```

(Versions may need adjustment if the latest published versions of these
crates differ. If `cargo check` fails on a version mismatch, run
`cargo search objc2-web-kit` and pick the latest 0.x release.)

- [ ] **Step 2: Create Rust module with stub command**

Create `src-tauri/src/pdf.rs`:

```rust
//! PDF export via WKWebView's createPDF API.
//!
//! Frontend hands us a fully-rendered, self-contained HTML document plus a
//! base URL (file:// of the source file's directory, used so relative-path
//! images can resolve). We spin up an offscreen WKWebView on the main
//! thread, load the HTML, wait for navigation completion, call createPDF,
//! and write the result to the user-chosen path.

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn export_pdf(
    app: tauri::AppHandle,
    html: String,
    output_path: String,
    base_url: String,
) -> Result<String, String> {
    // Stub: Task 6 implements the real WKWebView path.
    let _ = (app, html, base_url);
    Err(format!(
        "export_pdf is not yet implemented (would have written to {})",
        output_path
    ))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn export_pdf(
    _app: tauri::AppHandle,
    _html: String,
    _output_path: String,
    _base_url: String,
) -> Result<String, String> {
    Err("PDF export is only supported on macOS".into())
}
```

- [ ] **Step 3: Register the module + command in `lib.rs`**

In `src-tauri/src/lib.rs`, near the top of the file (after the other `use`
statements), add:

```rust
mod pdf;
```

In the `invoke_handler` call inside `pub fn run()`, add `pdf::export_pdf` to the handler list:

```rust
.invoke_handler(tauri::generate_handler![
    quit_app,
    set_default_app_for_extensions,
    pdf::export_pdf,
])
```

- [ ] **Step 4: Verify cargo check passes**

Run: `cd src-tauri && cargo check`
Expected: clean compile (with the stub).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/pdf.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): scaffold export_pdf command + WKWebView FFI deps"
```

---

## Task 6: Rust WKWebView createPDF implementation

**Files:**
- Modify: `src-tauri/src/pdf.rs` (replace stub with real impl)

> **High-risk task.** macOS Obj-C FFI with main-thread requirement, async navigation delegate, completion handler. The exact `objc2-web-kit` API surface depends on the crate version — adjust import paths if the methods don't resolve.

- [ ] **Step 1: Replace the stub with the real implementation**

Replace `src-tauri/src/pdf.rs` (the macOS branch only) with:

```rust
//! PDF export via WKWebView's createPDF API.

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::{Arc, Mutex};
    use std::path::Path;

    use block2::RcBlock;
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::ProtocolObject;
    use objc2::{declare_class, msg_send_id, mutability, ClassType, DeclaredClass};
    use objc2_foundation::{
        CGRect, CGSize, CGPoint, NSData, NSError, NSObject, NSString, NSURL,
    };
    use objc2_web_kit::{
        WKNavigation, WKNavigationDelegate, WKPDFConfiguration, WKWebView,
        WKWebViewConfiguration,
    };

    /// A Rust-side delegate that bridges WKNavigationDelegate's didFinish
    /// into a oneshot channel.
    declare_class!(
        struct NavDelegate;

        unsafe impl ClassType for NavDelegate {
            type Super = NSObject;
            type Mutability = mutability::Mutable;
            const NAME: &'static str = "MdEditorPdfNavDelegate";
        }

        impl DeclaredClass for NavDelegate {
            type Ivars = Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>;
        }

        unsafe impl NavDelegate {
            #[method(webView:didFinishNavigation:)]
            fn did_finish(&self, _webview: &WKWebView, _nav: &WKNavigation) {
                if let Ok(mut guard) = self.ivars().lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(());
                    }
                }
            }
        }

        unsafe impl NSObjectProtocol for NavDelegate {}
        unsafe impl WKNavigationDelegate for NavDelegate {}
    );

    pub async fn export_pdf(
        app: tauri::AppHandle,
        html: String,
        output_path: String,
        base_url: String,
    ) -> Result<String, String> {
        // (1) Marshal to the main thread; AppKit / WKWebView require it.
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
        let html_for_main = html.clone();
        let base_for_main = base_url.clone();

        app.run_on_main_thread(move || {
            // (2) Build the offscreen WKWebView (A4 at 72dpi: 595 x 842 pts).
            let frame = CGRect {
                origin: CGPoint { x: 0.0, y: 0.0 },
                size: CGSize { width: 595.0, height: 842.0 },
            };
            unsafe {
                let config = WKWebViewConfiguration::new();
                let webview: Retained<WKWebView> =
                    WKWebView::initWithFrame_configuration(WKWebView::alloc(), frame, &config);

                // (3) Wire up the navigation delegate so we know when load completes.
                let (nav_tx, nav_rx) = tokio::sync::oneshot::channel::<()>();
                let nav_state: Arc<Mutex<Option<_>>> = Arc::new(Mutex::new(Some(nav_tx)));
                let delegate = NavDelegate::alloc().set_ivars(nav_state);
                let delegate: Retained<NavDelegate> = msg_send_id![super(delegate), init];
                let proto = ProtocolObject::from_ref(&*delegate);
                webview.setNavigationDelegate(Some(proto));

                // (4) Load the HTML with a base URL (lets relative <img src> work).
                let html_ns = NSString::from_str(&html_for_main);
                let base_ns = NSString::from_str(&base_for_main);
                let base_url_obj = NSURL::URLWithString(&base_ns);
                webview.loadHTMLString_baseURL(&html_ns, base_url_obj.as_deref());

                // (5) When navigation finishes, call createPDF.
                let webview_for_pdf = webview.clone();
                let done_tx_inner = done_tx;
                tauri::async_runtime::spawn(async move {
                    if nav_rx.await.is_err() {
                        let _ = done_tx_inner.send(Err("navigation channel closed".into()));
                        return;
                    }
                    // Hop back to main thread for createPDF.
                    let (pdf_tx, pdf_rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
                    let webview_for_call = webview_for_pdf.clone();
                    let result = tauri::async_runtime::block_on(async move {
                        let pdf_state: Arc<Mutex<Option<_>>> = Arc::new(Mutex::new(Some(pdf_tx)));
                        let pdf_state_clone = pdf_state.clone();
                        let block = RcBlock::new(move |data: *mut NSData, err: *mut NSError| {
                            let result: Result<Vec<u8>, String> = if !err.is_null() {
                                let err_obj = unsafe { &*(err as *mut NSError) };
                                let msg = unsafe { err_obj.localizedDescription() };
                                Err(msg.to_string())
                            } else if !data.is_null() {
                                let nsdata = unsafe { &*(data as *mut NSData) };
                                Ok(unsafe { nsdata.bytes().to_vec() })
                            } else {
                                Err("createPDF returned no data and no error".into())
                            };
                            if let Ok(mut guard) = pdf_state_clone.lock() {
                                if let Some(sender) = guard.take() {
                                    let _ = sender.send(result);
                                }
                            }
                        });
                        unsafe {
                            let config = WKPDFConfiguration::new();
                            webview_for_call.createPDFWithConfiguration_completionHandler(
                                Some(&config),
                                &block,
                            );
                        }
                        match pdf_rx.await {
                            Ok(r) => r,
                            Err(_) => Err("PDF channel closed".into()),
                        }
                    });
                    let _ = done_tx_inner.send(result);
                });
            }
        })
        .map_err(|e| format!("run_on_main_thread failed: {}", e))?;

        // (6) Await the bytes, write to disk.
        let bytes = done_rx
            .await
            .map_err(|_| "PDF generation channel closed unexpectedly".to_string())??;
        std::fs::write(&output_path, bytes)
            .map_err(|e| format!("Failed to write PDF: {}", e))?;
        Path::new(&output_path)
            .canonicalize()
            .map(|p| p.to_string_lossy().into_owned())
            .or_else(|_| Ok(output_path))
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn export_pdf(
    app: tauri::AppHandle,
    html: String,
    output_path: String,
    base_url: String,
) -> Result<String, String> {
    imp::export_pdf(app, html, output_path, base_url).await
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn export_pdf(
    _app: tauri::AppHandle,
    _html: String,
    _output_path: String,
    _base_url: String,
) -> Result<String, String> {
    Err("PDF export is only supported on macOS".into())
}
```

- [ ] **Step 2: Verify cargo check passes**

Run: `cd src-tauri && cargo check`
Expected: clean compile.

If errors arise from the objc2-web-kit API surface, the most likely fixes are:
- The selector method names differ (`createPDFWithConfiguration_completionHandler` vs `createPDFWithConfiguration_completionHandler:`). Check with `cargo doc --open -p objc2-web-kit` and search for `createPDF`.
- `loadHTMLString_baseURL` may need `_:_:` style; same lookup approach.
- `NSData::bytes()` may return `*const u8` rather than `&[u8]`; adjust `to_vec()` accordingly using `std::slice::from_raw_parts(ptr, nsdata.length())`.

If the API mismatch is non-trivial, try simplifying by using raw `objc2::msg_send!` macros instead of the strongly-typed bindings:

```rust
let _: () = msg_send![&webview, loadHTMLString: &*html_ns baseURL: base_url_obj.as_deref()];
```

- [ ] **Step 3: Manual smoke (no automated test for FFI)**

Build and launch the app:

```bash
cd /Users/bruce/git/mdeditor
pnpm tauri dev
```

In the app, open `index.html` (any markdown / html file). The menu/UI for PDF export doesn't exist yet (Task 8) — to verify Task 6 in isolation, run this in the dev tools console:

```js
const r = await window.__TAURI__.core.invoke('export_pdf', {
  html: '<!doctype html><html><body><h1>Test</h1><p>Hello world</p></body></html>',
  outputPath: '/tmp/mdeditor-test.pdf',
  baseUrl: 'file:///tmp/',
})
console.log(r)
```

Expected: returns the absolute path; a 1-page PDF appears at `/tmp/mdeditor-test.pdf`. Open it in Preview.app and verify it shows "Test" and "Hello world".

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/pdf.rs
git commit -m "feat(tauri): export_pdf via offscreen WKWebView.createPDF"
```

---

## Task 7: Frontend `exportTabAsPdf` glue

**Files:**
- Modify: `src/lib/pdf-export.ts` (append public function)

- [ ] **Step 1: Implement `exportTabAsPdf`**

Append to `src/lib/pdf-export.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'

/**
 * Render the tab to PDF and write to `outputPath`. Returns the canonical
 * absolute path on success.
 *
 * Caller is responsible for showing a save dialog and supplying the path.
 */
export async function exportTabAsPdf(tab: Tab, outputPath: string): Promise<string> {
  const html = await renderForPrint(tab)
  // Base URL = parent dir of the source file, so <img src="./foo.png"> can
  // resolve when the offscreen WKWebView loads the document.
  const dir = tab.filePath.replace(/[^/]+$/, '')
  const baseUrl = 'file://' + (dir.endsWith('/') ? dir : dir + '/')
  return await invoke<string>('export_pdf', {
    html,
    outputPath,
    baseUrl,
  })
}
```

- [ ] **Step 2: Verify type-check passes**

Run: `pnpm -s check`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/pdf-export.ts
git commit -m "feat(pdf-export): exportTabAsPdf renders + invokes Rust"
```

---

## Task 8: Menu item + `cmdExportPdf` + App wiring

**Files:**
- Modify: `src-tauri/src/lib.rs` (File submenu)
- Modify: `src/lib/commands.ts`
- Modify: `src/App.svelte`

- [ ] **Step 1: Add the File menu item in `lib.rs`**

In `src-tauri/src/lib.rs`, find the `file_menu` definition (in `build_menu`).
Add an "Export to PDF…" item after the "Save As…" item:

Existing block:

```rust
let file_menu: Submenu<R> = SubmenuBuilder::new(app, "File")
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
    )
    .build()?;
```

Replace with:

```rust
let file_menu: Submenu<R> = SubmenuBuilder::new(app, "File")
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
    )
    .separator()
    .item(
        &MenuItemBuilder::with_id("export-pdf", "Export to PDF…")
            .accelerator("Cmd+Shift+E")
            .build(app)?,
    )
    .build()?;
```

- [ ] **Step 2: Add `cmdExportPdf` in `commands.ts`**

In `src/lib/commands.ts`, add the new command. First read the existing file:

```bash
cat src/lib/commands.ts
```

Add an import at the top:

```ts
import { exportTabAsPdf, suggestedPdfFilename } from './pdf-export'
```

Add the import for the dialog helpers if they aren't already imported (likely they are; check what's already there):

```ts
import { save as saveDialog, message } from '@tauri-apps/plugin-dialog'
```

Append at the end of the file:

```ts
export async function cmdExportPdf(): Promise<void> {
  const tab = activeTab()
  if (!tab) return
  if (tab.kind !== 'markdown' && tab.kind !== 'html') {
    await message('PDF export only supports Markdown and HTML files.', {
      title: 'M↓',
      kind: 'info',
    })
    return
  }
  const outputPath = await saveDialog({
    defaultPath: suggestedPdfFilename(tab.filePath),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (!outputPath) return
  // Defensively ensure .pdf extension if user typed something else.
  const finalPath = outputPath.endsWith('.pdf') ? outputPath : `${outputPath}.pdf`
  try {
    await exportTabAsPdf(tab, finalPath)
  } catch (e) {
    await message(`Export failed: ${e instanceof Error ? e.message : String(e)}`, {
      title: 'M↓',
      kind: 'error',
    })
  }
}
```

(If `activeTab` is not already imported, add `import { activeTab } from './tabs.svelte'`.)

- [ ] **Step 3: Wire menu event in App.svelte**

In `src/App.svelte`, find the `listen<string>('menu-event', ...)` switch
statement. Add an import:

```ts
import { cmdOpen, cmdSave, cmdSaveAs, cmdCloseActive, cmdToggleMode, cmdExportPdf } from './lib/commands'
```

(The existing line already imports the others; just add `cmdExportPdf` to the
imported names.)

In the switch:

```ts
switch (e.payload) {
  case 'open':        cmdOpen(); break
  case 'save':        cmdSave(); break
  case 'save-as':     cmdSaveAs(); break
  case 'close-tab':   cmdCloseActive(); break
  case 'toggle-mode': cmdToggleMode(); break
  case 'export-pdf':  cmdExportPdf(); break          // <-- new
  case 'preferences': showSettings = true; break
  case 'docs':
    // ... unchanged
}
```

Also add a Cmd+Shift+E keyboard shortcut handler in the `onKeyDown` function in `App.svelte`:

```ts
function onKeyDown(e: KeyboardEvent) {
  if (!e.metaKey) return
  const k = e.key.toLowerCase()
  if (k === 'o') { e.preventDefault(); cmdOpen() }
  else if (k === 's' && !e.shiftKey) { e.preventDefault(); cmdSave() }
  else if (k === 's' && e.shiftKey) { e.preventDefault(); cmdSaveAs() }
  else if (k === 'e' && e.shiftKey) { e.preventDefault(); cmdExportPdf() }   // <-- new
  else if (k === 'w') { e.preventDefault(); cmdCloseActive() }
  else if (k === '/') { e.preventDefault(); cmdToggleMode() }
}
```

- [ ] **Step 4: Verify type-check + tests**

Run: `pnpm -s check && pnpm -s test`
Expected: 0 errors; all tests pass.

- [ ] **Step 5: Manual smoke**

```bash
pnpm tauri dev
```

- Open a `.md` file with headings, code, math, mermaid.
- File → Export to PDF… (or Cmd+Shift+E)
- Default filename should be `<basename>.pdf`. Save to `/tmp/`.
- Open `/tmp/<basename>.pdf` in Preview.app — verify content.
- Repeat for an `.html` file.
- Try Export to PDF on a `.py` file — info dialog "PDF export only supports Markdown and HTML."

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs src/lib/commands.ts src/App.svelte
git commit -m "feat(menu): wire File → Export to PDF… (Cmd+Shift+E)"
```

---

## Task 9: README smoke checklist additions

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append items 31-39 to the smoke checklist**

In `README.md`, find the "Manual Smoke Test" section. After the last
existing item (item 30 from the external-change feature), add:

```markdown
31. **Export markdown to PDF**: open a `.md` file → File → Export to PDF…
    (or Cmd+Shift+E) → default filename = `<basename>.pdf` → save → PDF
    appears at chosen path within ~2 s.
32. **Export markdown with KaTeX**: doc with `$E=mc^2$` and `$$\int_0^1 x dx$$`
    → math renders correctly in the PDF (not raw `$...$`).
33. **Export markdown with Mermaid** (DEFERRED — see implementer notes):
    doc with a ` ```mermaid ` block → in v1 the diagram source renders as a
    plain code block; v1.1 follow-up integrates rendered SVG.
34. **Export markdown with code blocks**: monospace font, light-grey
    background, long lines wrap (no horizontal overflow off the page).
35. **Export HTML tab**: content preserved; no script side-effects.
36. **Export dirty tab**: edit but don't save → export → PDF reflects
    buffer, not on-disk content.
37. **Export long markdown** (>200 lines): page breaks fall on safe
    boundaries — headings not orphaned at page bottom; code blocks not
    split across pages.
38. **Export markdown with relative-path images** (`![alt](./assets/foo.png)`):
    image appears in the PDF (the offscreen WKWebView resolves relative
    paths via the source file's directory).
39. **Try Export to PDF on a code tab** (e.g., `.py`): info dialog says
    "PDF export only supports Markdown and HTML files."
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): smoke checklist items 31-39 for PDF export"
```

---

## Final verification

- [ ] **Run the full test suite:**

```bash
pnpm -s test
pnpm -s check
cd src-tauri && cargo check --release
```

Expected: all tests pass; 0 type errors; release compiles.

- [ ] **Manual smoke (run all of items 31-39 from README).**

- [ ] **Push and tag (deferred):**

After verifying behaviour, the user decides whether to bump version + run
`scripts/release.sh 0.2.0`. The release script will pick up the new feature,
sign + notarize, and publish.

---

## Notes for the implementer

- **Rust Task 6 is the riskiest task.** If the `objc2-web-kit` API surface
  has shifted (the crate auto-generates from headers, version-to-version
  drift can rename methods), `cargo check` will fail with a misleading
  "method not found". Fall back to raw `msg_send!` macros instead of typed
  bindings — they're less ergonomic but always work as long as the Obj-C
  selector exists on the target framework. The Apple docs for
  WKWebView.createPDF (https://developer.apple.com/documentation/webkit/wkwebview/3650490-createpdf)
  are the source of truth for the selector.
- **KaTeX + hljs are integrated in Task 4** via the `marked-katex-extension`
  and `marked-highlight` plugins (sync, no async settling beyond fonts).
  Smoke checklist items 32 (KaTeX) and 34 (code-block highlighting) work
  in v1.
- **Mermaid is intentionally deferred.** The renderer-registry's mermaid
  plugin is dynamic-imported, async per-block, and currently scoped to the
  RichEditor instance. Integrating it into the print pipeline needs a small
  refactor: lift the plugin's `load()` call into a top-level helper, then
  inside `renderForPrint`'s staging div: query for
  `<code class="language-mermaid">`, dynamic-import the plugin, call its
  `render()` for each block (it returns SVG into a container), await all,
  then serialize. This is one focused follow-up task — schedule after
  the v1 plan ships and the basic flow is verified.
- **In v1, ` ```mermaid ` blocks render as plain syntax-highlighted code
  blocks** (because `marked-highlight` doesn't know "mermaid" is a language
  it should pass through; hljs falls back to plaintext). Smoke item 33 is
  marked DEFERRED.
- **happy-dom (Task 4 tests):** already installed (file-watcher feature).
  No additional deps needed.
- **Async on the main thread (Task 6):** `app.run_on_main_thread` schedules a
  closure on the AppKit main run loop. The closure cannot itself `.await`,
  so we spawn a tokio task inside it that awaits the navigation channel.
  The PDF completion handler runs on the main thread again (WebKit promise
  callbacks dispatch to the originating queue), so the inner block is
  fine.
- **Rust release build time:** WKWebView FFI doesn't add measurable build
  time; objc2-web-kit re-exports stub bindings only. `cargo check` should
  remain in single-digit seconds.
