import { basename } from './fs'
import type { Tab } from './tabs.svelte'
import pdfCss from '../styles/pdf.css?raw'

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
  <style>${pdfCss}</style>
</head>
<body data-pdf-title="${escTitle}">
${bodyHtml}
</body>
</html>`
}
