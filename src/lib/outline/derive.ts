// src/lib/outline/derive.ts
export interface AutoItem {
  source: 'toc' | 'highlight' | 'wikilink'
  content: string
  /** 树深度：H2 = 0，H3 = 1…；对应高亮 = 栈深；任何 H2 之前的高亮 = 0 */
  depth: number
  anchorLine: number
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/
// 高亮在前：`==text [[x]]==` 整体按高亮收录，内部 wikilink 不再单独出条目
const INLINE_RE = /\^\^([^^\n]+?)\^\^|(?<![\w=])==([^\s=][^=\n]*?)==(?![\w=])|\[\[([^\]\n]+?)\]\]/g

interface StackEntry { level: number; content: string; anchorLine: number; emitted: boolean }

/**
 * Derive outline auto-items from highlights only. Each highlight is grouped
 * under its nearest sub-heading path (H2–H6, nested relatively). The document
 * H1 is skipped entirely (and resets the sub-heading stack). A heading is
 * emitted lazily — only when a highlight beneath it appears — so only heading
 * paths that lead to a highlight show up.
 */
export function deriveAutoItems(md: string): AutoItem[] {
  const lines = md.split('\n')
  const items: AutoItem[] = []
  const stack: StackEntry[] = []
  let inFence = false
  let start = 0

  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1)
    if (close > 0) start = close + 1
  }

  for (let li = start; li < lines.length; li++) {
    const line = lines[li]
    if (/^(```|~~~)/.test(line.trim())) { inFence = !inFence; continue }
    if (inFence) continue

    const h = line.match(HEADING_RE)
    if (h) {
      const level = h[1].length
      if (level === 1) { stack.length = 0; continue }   // skip H1, reset context
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, content: h[2].trim(), anchorLine: li + 1, emitted: false })
      continue
    }

    INLINE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = INLINE_RE.exec(line)) !== null) {
      const isWikilink = m[3] != null
      const text = (m[1] ?? m[2] ?? m[3]).trim()
      if (!text) continue
      // Lazily emit the heading path leading to this item (shallow → deep).
      for (let d = 0; d < stack.length; d++) {
        const entry = stack[d]
        if (entry.emitted) continue
        items.push({ source: 'toc', content: entry.content, depth: d, anchorLine: entry.anchorLine })
        entry.emitted = true
      }
      items.push({
        source: isWikilink ? 'wikilink' : 'highlight',
        // wikilink 节点内容保留双方括号样式
        content: isWikilink ? `[[${text}]]` : text,
        depth: stack.length, anchorLine: li + 1,
      })
    }
  }
  return items
}
