// src/lib/outline/completion.ts
import { sanitizeFileName } from './slug'

export interface SlashItem {
  id: string
  label: string
  icon: string
  /** 插入片段与光标在片段内的偏移 */
  insert: () => { snippet: string; cursorOffset: number }
}

/** hulunote render.cljs:60 slash-commands 表（面板适用子集） */
export const SLASH_ITEMS: SlashItem[] = [
  { id: 'link', label: '[[]]  Page Link', icon: '🔗', insert: () => ({ snippet: '[[]]', cursorOffset: 2 }) },
  { id: 'bold', label: '**Bold**', icon: 'B', insert: () => ({ snippet: '****', cursorOffset: 2 }) },
  { id: 'italic', label: '__Italic__', icon: 'I', insert: () => ({ snippet: '____', cursorOffset: 2 }) },
  { id: 'strikethrough', label: '~~Strikethrough~~', icon: 'S', insert: () => ({ snippet: '~~~~', cursorOffset: 2 }) },
  { id: 'highlight', label: '^^Highlight^^', icon: 'H', insert: () => ({ snippet: '^^^^', cursorOffset: 2 }) },
  { id: 'code', label: '`Code`', icon: '<>', insert: () => ({ snippet: '``', cursorOffset: 1 }) },
  { id: 'codeblock', label: '``` Code Block', icon: '{}', insert: () => ({ snippet: '```\n\n```', cursorOffset: 4 }) },
]

/** hulunote render.cljs:115 filtered-slash-commands */
export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return SLASH_ITEMS
  return SLASH_ITEMS.filter(i => i.id.includes(q) || i.label.toLowerCase().includes(q))
}

/** 用所选项替换 content 中 slashStart..cursor 的 `/query` 段 */
export function applySlashItem(content: string, slashStart: number, cursor: number, item: SlashItem):
  { text: string; cursor: number } {
  const { snippet, cursorOffset } = item.insert()
  const text = content.slice(0, slashStart) + snippet + content.slice(cursor)
  return { text, cursor: slashStart + cursorOffset }
}

/** hulunote render.cljs:166 — 光标前最近的未闭合 [[ */
export function pageLinkQueryAt(content: string, cursor: number): { start: number; query: string } | null {
  const before = content.slice(0, cursor)
  const open = before.lastIndexOf('[[')
  if (open < 0) return null
  const between = before.slice(open + 2)
  if (between.includes(']]')) return null
  return { start: open, query: between }
}

/**
 * hulunote render.cljs:211/232 — 确认 [[query]]：
 * selection 非空替换 query，否则保留手输文字；光标移到 ]] 之后。
 * `start` = `[[` 的位置；假设 query 后紧跟自动补出的 `]]`。
 */
export function confirmPageLink(content: string, start: number, query: string, selection: string | null):
  { text: string; cursor: number } {
  const target = sanitizeFileName(selection ?? query)
  const closeAt = start + 2 + query.length
  const text = content.slice(0, start) + '[[' + target + ']]' + content.slice(closeAt + 2)
  return { text, cursor: start + 2 + target.length + 2 }
}

/** 前缀命中排前，其余子串命中排后 */
export function filterPages(pages: string[], query: string): string[] {
  const q = query.toLowerCase()
  const prefix: string[] = []
  const substr: string[] = []
  for (const p of pages) {
    const lower = p.toLowerCase()
    if (lower.startsWith(q)) prefix.push(p)
    else if (lower.includes(q)) substr.push(p)
  }
  return [...prefix, ...substr]
}
