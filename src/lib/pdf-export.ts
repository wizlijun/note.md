import { basename } from './fs'
import type { Tab } from './tabs.svelte'
import pdfCss from '../styles/pdf.css?raw'
import katexCss from 'katex/dist/katex.min.css?raw'
import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'

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
  <style>${katexCss}</style>
  <style>${pdfCss}</style>
</head>
<body data-pdf-title="${escTitle}">
${bodyHtml}
</body>
</html>`
}

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
