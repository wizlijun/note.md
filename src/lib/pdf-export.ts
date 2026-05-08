import { invoke } from '@tauri-apps/api/core'
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
 * Replace fenced ` ```mermaid ` / ` ```dot ` / ` ```graphviz ` blocks in the
 * staging DOM with rendered SVG. Awaits all renders before returning.
 *
 * Code-fence parsing already happened (marked → hljs); we look for the
 * `language-<lang>` class that marked-highlight emits and swap the
 * containing `<pre>` for a div the plugin can render into.
 *
 * Errors per-block are inlined as red placeholder text — one bad diagram
 * doesn't sink the whole export.
 */
async function renderDiagrams(staging: HTMLElement): Promise<void> {
  type Lang = 'mermaid' | 'dot' | 'graphviz'
  const blocks: Array<{ lang: Lang; pre: HTMLElement; source: string }> = []
  const candidates = staging.querySelectorAll<HTMLElement>(
    'pre code.language-mermaid, pre code.language-dot, pre code.language-graphviz',
  )
  for (const code of Array.from(candidates)) {
    const pre = code.parentElement as HTMLElement | null
    if (!pre || pre.tagName !== 'PRE') continue
    const langClass = Array.from(code.classList).find((c) =>
      c === 'language-mermaid' || c === 'language-dot' || c === 'language-graphviz',
    )
    if (!langClass) continue
    const lang = langClass.slice('language-'.length) as Lang
    blocks.push({ lang, pre, source: code.textContent ?? '' })
  }
  if (blocks.length === 0) return

  // Lazy-load each plugin once; reuse for all blocks of that language.
  const { loadDotRenderer, loadMermaidRenderer } = await import(
    '../lib/adapters/renderer-registry'
  )
  const langCache = new Map<
    Lang,
    { render: (source: string, container: HTMLElement) => void | Promise<void> }
  >()
  const loaderFor = async (lang: Lang) => {
    if (langCache.has(lang)) return langCache.get(lang)!
    const plugin =
      lang === 'mermaid' ? await loadMermaidRenderer() : await loadDotRenderer()
    langCache.set(lang, plugin)
    return plugin
  }

  await Promise.all(
    blocks.map(async ({ lang, pre, source }) => {
      const container = document.createElement('div')
      container.className = lang === 'mermaid' ? 'mermaid' : 'dot'
      pre.parentNode?.replaceChild(container, pre)
      try {
        const plugin = await loaderFor(lang)
        await plugin.render(source, container)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        container.innerHTML = `<div class="renderer-error">${htmlEscape(`${lang} render failed: ${msg}`)}</div>`
      }
    }),
  )
}

/**
 * Render the tab's content to a fully-settled, self-contained HTML document
 * ready to hand off to the Rust PDF generator.
 *
 * For markdown tabs: marked + marked-katex-extension + marked-highlight (hljs)
 *   + post-pass that replaces ```mermaid / ```dot / ```graphviz code blocks
 *   with rendered SVG via the renderer-registry plugins.
 *
 * For HTML tabs: the content is wrapped verbatim in the print template.
 *
 * Awaits font loading, image loading, AND all diagram rendering before
 * returning, so the static HTML is layout-stable in the offscreen WKWebView.
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
  // DOM (fonts, images, diagram renders).
  const staging = document.createElement('div')
  staging.id = 'pdf-staging'
  staging.setAttribute(
    'style',
    'position:absolute;left:-10000px;top:0;width:170mm;visibility:hidden;',
  )
  staging.innerHTML = bodyHtml
  document.body.appendChild(staging)

  try {
    // Diagrams (mermaid / dot / graphviz) — async per-block; settle all
    // before reading back the serialized HTML.
    await renderDiagrams(staging)
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
    // Re-extract serialized HTML after diagram + image mutations
    bodyHtml = staging.innerHTML
  } finally {
    staging.remove()
  }

  const title = buildPdfTitle(tab)
  return wrapInPrintTemplate(bodyHtml, title)
}

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
