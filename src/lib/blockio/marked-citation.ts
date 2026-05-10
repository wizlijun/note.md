import type { TokenizerAndRendererExtension } from 'marked'

const INLINE_RE = /^\(\(([^()#]*)#(b-[0-9a-f]{6})\)\)/

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const blockCitationExtension: TokenizerAndRendererExtension = {
  name: 'blockCitation',
  level: 'inline',
  start(src: string) {
    return src.indexOf('((')
  },
  tokenizer(src: string) {
    const m = INLINE_RE.exec(src)
    if (!m) return undefined
    return {
      type: 'blockCitation',
      raw: m[0],
      pageuri: m[1],
      blockid: m[2],
    } as { type: string; raw: string; pageuri: string; blockid: string }
  },
  renderer(token: any) {
    const pageuri = String(token.pageuri ?? '')
    const blockid = String(token.blockid ?? '')
    const label = pageuri || '此处'
    const tail = blockid.slice(0, 8)
    const title = `跳转 ${pageuri || '同文档'} #${blockid}`
    return `<span class="block-citation" data-pageuri="${escapeHtml(pageuri)}" data-blockid="${escapeHtml(blockid)}" title="${escapeHtml(title)}">→ ${escapeHtml(label)}#${escapeHtml(tail)}</span>`
  },
}
