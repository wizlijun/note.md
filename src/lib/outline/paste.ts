// src/lib/outline/paste.ts
// 把剪贴板纯文本解析成扁平的层级列表（缩进栈算法，depth 0-based）。
// 覆盖：Markdown 列表(-/*/+/数字.)、空格缩进、Tab 缩进、多行无缩进=平级。

export interface ParsedPasteNode {
  depth: number
  content: string
}

const TAB_WIDTH = 4
/** 行首空白 + 列表标记(-,*,+ 或 1./1)) + 至少一个空格 + 正文 */
const LIST_MARKER = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/
/** 行首空白 + 正文（无标记时兜底，永远匹配） */
const INDENT_ONLY = /^(\s*)(.*)$/

function indentWidth(ws: string): number {
  let w = 0
  for (const ch of ws) w += ch === '\t' ? TAB_WIDTH : 1
  return w
}

export function parseClipboardOutline(text: string): ParsedPasteNode[] {
  const rawLines = text.split(/\r\n|\r|\n/)
  const items: { width: number; content: string }[] = []
  for (const line of rawLines) {
    if (line.trim() === '') continue
    const m = LIST_MARKER.exec(line)
    if (m) {
      items.push({ width: indentWidth(m[1]), content: m[2] })
    } else {
      const mm = INDENT_ONLY.exec(line)!
      items.push({ width: indentWidth(mm[1]), content: mm[2] })
    }
  }
  if (items.length === 0) return []

  const out: ParsedPasteNode[] = []
  const stack: number[] = [] // 缩进宽度栈，升序
  for (const it of items) {
    while (stack.length > 0 && it.width < stack[stack.length - 1]) stack.pop()
    if (stack.length === 0 || it.width > stack[stack.length - 1]) stack.push(it.width)
    // 走到这里栈顶宽度 == it.width（相等或刚压入）
    out.push({ depth: stack.length - 1, content: it.content })
  }
  return out
}
