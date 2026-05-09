import { basename } from '../fs'
import type { Tab } from '../tabs.svelte'
import type { SkinId } from '../skin.svelte'
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
import defaultSkinCss from '../../styles/skins/default.css?raw'
import shuyuanSkinCss from '../../styles/skins/shuyuan.css?raw'
import effieSkinCss from '../../styles/skins/effie.css?raw'

const SKIN_CSS: Record<SkinId, string> = {
  default: defaultSkinCss,
  shuyuan: shuyuanSkinCss,
  effie: effieSkinCss,
}

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

/**
 * Phone-width adjustments for the shared page. Skin CSS is desktop-tuned
 * (designed for the editor pane, where the user controls the window width),
 * so on narrow viewports we trim padding, hide effie's gutter labels,
 * and let tables scroll horizontally instead of overflowing.
 */
export function mobileOverridesCssBlock(): string {
  return `
@media (max-width: 600px) {
  body { padding: 16px; }
  .share-header { margin-bottom: 24px; }
  .share-footer { margin-top: 40px; }
  .moraya-editor { font-size: 16px; }
  /* effie: drop the 2.5em left gutter and hide the H-labels — no room on
     phones, and the labels look orphaned without their indent buddy. */
  [data-skin="effie"] .moraya-editor { padding-left: 0; }
  [data-skin="effie"] .moraya-editor h1::before,
  [data-skin="effie"] .moraya-editor h2::before,
  [data-skin="effie"] .moraya-editor h3::before,
  [data-skin="effie"] .moraya-editor h4::before { display: none; }
  /* shuyuan: shrink blockquote outer margin so it doesn't pinch the text. */
  [data-skin="shuyuan"] .moraya-editor blockquote { margin: 1em 0; padding: 0.6em 0.8em; }
  /* Tables: scroll horizontally instead of bleeding off the viewport. */
  .moraya-editor table { display: block; overflow-x: auto; max-width: 100%; }
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
 * pipeline), bakes light + dark themes plus the user's chosen skin, adds
 * mobile-responsive viewport overrides, wraps in a minimal header/footer
 * shell.
 *
 * `skinId` defaults to 'default' so callers (and tests) can omit it. The
 * skin CSS is inlined as-is and scoped via `[data-skin="<id>"] .moraya-editor`,
 * matching the in-app preview's selector contract.
 *
 * Throws `share_too_large:<bytes>` if the result exceeds 25 MB.
 */
export async function bakeShareHtml(tab: Tab, skinId: SkinId = 'default'): Promise<string> {
  // Guard raw content size before running the rendering pipeline to avoid
  // stack overflows in the markdown parser on pathologically large inputs.
  const rawBytes = new TextEncoder().encode(tab.currentContent).byteLength
  if (rawBytes > MAX_HTML_BYTES) throw new Error(`share_too_large:${rawBytes}`)

  const inlineBody = await renderTabAsInlineBody(tab)
  const title = htmlEscape(shareHeaderLabel(tab.filePath))
  const date = isoDateStamp()
  const skinCss = SKIN_CSS[skinId] ?? SKIN_CSS.default
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
<style>${skinCss}</style>
<style>${mobileOverridesCssBlock()}</style>
</head>
<body data-skin="${htmlEscape(skinId)}">
<div class="share-shell">
<header class="share-header">${title} · ${date}</header>
<main class="moraya-editor">${inlineBody}</main>
<footer class="share-footer">Powered by <a href="https://github.com/wizlijun/MdEditor">M↓</a></footer>
</div>
</body>
</html>`
  guardSize(html)
  return html
}
