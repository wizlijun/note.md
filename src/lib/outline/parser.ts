// src/lib/outline/parser.ts
export type Inline =
  | { t: 'text'; text: string }
  | { t: 'page-link'; target: string }
  | { t: 'hashtag'; tag: string }
  | { t: 'block-ref'; refId: string }
  | { t: 'bold'; children: Inline[] }
  | { t: 'italics'; children: Inline[] }
  | { t: 'strikethrough'; children: Inline[] }
  | { t: 'highlight'; children: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'link'; text: string; url: string }
  | { t: 'image'; alt: string; url: string }
  | { t: 'url'; url: string }

const BLOCK_REF_RE = /^\(\(([a-zA-Z0-9_-]+)\)\)/
// hulunote hashtag-bare：到空格或标点为止
const HASHTAG_RE = /^#([^\s+!@#$%^&*()?";:\][]+)/
const MD_LINK_RE = /^\[([^\]\n]*)\]\(([^)\s][^)]*)\)/
const URL_RE = /^https?:\/\/[^\s[\]()*^{}]+/

/** 找嵌套平衡的 ]]，返回 target 结束位置（hulunote any-page-link-content 可嵌套） */
function findPageLinkEnd(s: string, from: number): number {
  let depth = 1
  for (let i = from; i < s.length - 1; i++) {
    if (s[i] === '[' && s[i + 1] === '[') { depth++; i++ }
    else if (s[i] === ']' && s[i + 1] === ']') { depth--; i++; if (depth === 0) return i - 1 }
  }
  return -1
}

function pairSpan(s: string, i: number, marker: string): string | null {
  const start = i + marker.length
  const end = s.indexOf(marker, start)
  if (end < 0 || end === start) return null
  const inner = s.slice(start, end)
  if (inner.includes('\n')) return null
  return inner
}

export function parseInline(input: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = () => { if (text) { out.push({ t: 'text', text }); text = '' } }

  let i = 0
  while (i < input.length) {
    const rest = input.slice(i)
    const two = rest.slice(0, 2)

    if (two === '[[') {
      const end = findPageLinkEnd(input, i + 2)
      if (end >= 0) { flush(); out.push({ t: 'page-link', target: input.slice(i + 2, end) }); i = end + 2; continue }
    }
    if (two === '((') {
      const m = rest.match(BLOCK_REF_RE)
      if (m) { flush(); out.push({ t: 'block-ref', refId: m[1] }); i += m[0].length; continue }
    }
    if (input[i] === '#') {
      if (rest.startsWith('#[[')) {
        const end = findPageLinkEnd(input, i + 3)
        if (end >= 0) { flush(); out.push({ t: 'hashtag', tag: input.slice(i + 3, end) }); i = end + 2; continue }
      }
      const m = rest.match(HASHTAG_RE)
      if (m) { flush(); out.push({ t: 'hashtag', tag: m[1] }); i += m[0].length; continue }
    }
    if (input[i] === '!') {
      const m = rest.slice(1).match(MD_LINK_RE)
      if (m) { flush(); out.push({ t: 'image', alt: m[1], url: m[2] }); i += 1 + m[0].length; continue }
    }
    if (input[i] === '[' && two !== '[[') {
      const m = rest.match(MD_LINK_RE)
      if (m) { flush(); out.push({ t: 'link', text: m[1], url: m[2] }); i += m[0].length; continue }
    }
    let matched = false
    for (const [marker, kind] of [['**', 'bold'], ['__', 'italics'], ['~~', 'strikethrough'], ['^^', 'highlight']] as const) {
      if (two === marker) {
        const inner = pairSpan(input, i, marker)
        if (inner != null) {
          flush()
          // Recurse so [[wikilink]] / #tag / links inside emphasis are still
          // parsed (rendered clickable, indexed as relationships, navigable).
          out.push({ t: kind, children: parseInline(inner) })
          i += marker.length * 2 + inner.length
          matched = true
        }
        break
      }
    }
    if (matched) continue
    if (input[i] === '`') {
      const inner = pairSpan(input, i, '`')
      if (inner != null) { flush(); out.push({ t: 'code', text: inner }); i += inner.length + 2; continue }
    }
    if (input[i] === 'h') {
      const m = rest.match(URL_RE)
      if (m) { flush(); out.push({ t: 'url', url: m[0] }); i += m[0].length; continue }
    }
    text += input[i]
    i++
  }
  flush()
  return out
}

/**
 * Depth-first walk over inline tokens, descending into emphasis children.
 * Use this (not a flat loop over parseInline) when extracting structural
 * tokens like page-link / hashtag / block-ref, so ones nested inside
 * **bold** / ^^highlight^^ / etc. are not missed.
 */
export function* eachInline(tokens: Inline[]): Generator<Inline> {
  for (const t of tokens) {
    yield t
    if (t.t === 'bold' || t.t === 'italics' || t.t === 'strikethrough' || t.t === 'highlight') {
      yield* eachInline(t.children)
    }
  }
}
