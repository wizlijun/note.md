import { basename } from '../fs'
import type { Tab } from '../tabs.svelte'
import {
  htmlEscape,
  renderTabAsInlineBody,
  renderTabBody as sharedRenderTabBody,
  inlineImages as sharedInlineImages,
  __setImageReaderForTests as sharedSetImageReader,
} from './host-render-html'
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

// Re-export shared pipeline pieces so existing share-baker tests keep their
// imports stable. Real implementations live in host-render-html.ts.
export const renderTabBody = sharedRenderTabBody
export const inlineImages = sharedInlineImages
export const __setImageReaderForTests = sharedSetImageReader

/**
 * Render a tab into a fully self-contained HTML document suitable for posting
 * to the share Worker. Inlines images as base64 (via the shared host-render
 * pipeline), bakes light + dark themes, adds mobile-responsive viewport,
 * wraps in a minimal header/footer shell.
 *
 * Throws `share_too_large:<bytes>` if the result exceeds 25 MB.
 */
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
