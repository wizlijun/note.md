// src/lib/outline/derive.ts
export interface AutoItem {
  source: 'toc' | 'highlight'
  content: string
  /** 树深度：顶层 H1 = 0；其下高亮 = 1；任何 H1 之前的高亮 = 0 */
  depth: number
  anchorLine: number
}

const H1_RE = /^#\s+(.*)$/
const HIGHLIGHT_RE = /\^\^([^^\n]+?)\^\^|(?<![\w=])==([^\s=][^=\n]*?)==(?![\w=])/g

/**
 * Derive outline auto-items: only highlights, each grouped under the most recent
 * top-level `#` heading (emitted once, read-only, as context). Sub-headings
 * (`##`+) are ignored. H1s with no highlights are omitted.
 */
export function deriveAutoItems(md: string): AutoItem[] {
  const lines = md.split('\n')
  const items: AutoItem[] = []
  let inFence = false
  let start = 0

  // Current top-level H1 context, and whether we've already emitted its toc item.
  let h1Content: string | null = null
  let h1Line = 0
  let h1Emitted = false

  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1)
    if (close > 0) start = close + 1
  }

  for (let li = start; li < lines.length; li++) {
    const line = lines[li]
    if (/^(```|~~~)/.test(line.trim())) { inFence = !inFence; continue }
    if (inFence) continue

    const h1 = line.match(H1_RE)
    if (h1) {
      h1Content = h1[1].trim()
      h1Line = li + 1
      h1Emitted = false
      continue
    }

    HIGHLIGHT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HIGHLIGHT_RE.exec(line)) !== null) {
      const text = (m[1] ?? m[2]).trim()
      if (!text) continue
      if (h1Content !== null && !h1Emitted) {
        items.push({ source: 'toc', content: h1Content, depth: 0, anchorLine: h1Line })
        h1Emitted = true
      }
      items.push({ source: 'highlight', content: text, depth: h1Content !== null ? 1 : 0, anchorLine: li + 1 })
    }
  }
  return items
}
