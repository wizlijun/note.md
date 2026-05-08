import { basename } from '../fs'
import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'
import type { Tab } from '../tabs.svelte'
import { htmlEscape } from '../pdf-export'
import katexCss from 'katex/dist/katex.min.css?raw'
import hljsLightCss from 'highlight.js/styles/github.css?raw'
import hljsDarkCss from 'highlight.js/styles/github-dark.css?raw'

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
  // Guard raw content size before running the rendering pipeline to avoid
  // stack overflows in the markdown parser on pathologically large inputs.
  const rawBytes = new TextEncoder().encode(tab.currentContent).byteLength
  if (rawBytes > MAX_HTML_BYTES) throw new Error(`share_too_large:${rawBytes}`)
  const body = await renderTabBody(tab)
  const inlined = await inlineImages(body, tab.filePath, pickImageReader())
  // Render mermaid / dot / graphviz code blocks to inline SVG. Mounts a
  // hidden staging element so the renderer plugins can do their async DOM
  // work, then serializes the mutated subtree back to a string.
  const withDiagrams = await renderDiagramsToString(inlined)
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
<main>${withDiagrams}</main>
<footer class="share-footer">Powered by <a href="https://github.com/wizlijun/MdEditor">M↓</a></footer>
</div>
</body>
</html>`
  guardSize(html)
  return html
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
