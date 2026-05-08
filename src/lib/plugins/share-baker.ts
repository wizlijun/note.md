import { basename } from '../fs'
import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'
import type { Tab } from '../tabs.svelte'
import { htmlEscape } from '../pdf-export'

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
