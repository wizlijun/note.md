// src/lib/outline/derive.ts
export interface AutoItem {
  source: 'toc' | 'highlight'
  content: string
  /** 树深度：toc 按标题级别相对嵌套；highlight = 所属 toc 深度 + 1（无标题时 0） */
  depth: number
  anchorLine: number
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const HIGHLIGHT_RE = /\^\^([^^\n]+?)\^\^|==([^=\n]+?)==/g

export function deriveAutoItems(md: string): AutoItem[] {
  const lines = md.split('\n')
  const items: AutoItem[] = []
  // levelStack: 祖先链的标题级别（如 [1,3] = h1 下的 h3），深度 = 栈长-1
  const levelStack: number[] = []
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
      while (levelStack.length && levelStack[levelStack.length - 1] >= level) levelStack.pop()
      levelStack.push(level)
      items.push({ source: 'toc', content: h[2].trim(), depth: levelStack.length - 1, anchorLine: li + 1 })
      continue
    }
    HIGHLIGHT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HIGHLIGHT_RE.exec(line)) !== null) {
      const text = (m[1] ?? m[2]).trim()
      if (!text) continue
      items.push({ source: 'highlight', content: text, depth: levelStack.length, anchorLine: li + 1 })
    }
  }
  return items
}
