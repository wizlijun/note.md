// src/lib/outline/derive.ts
import { isBlockedWikilink } from '../wikilink/blocklist'

/**
 * 插入点批注（无包裹文字）在大纲中的占位符号，与富文本编辑器里的批注徽标
 * （editor-base.css 的 note-badge::before）一致；样式如高亮（见 OutlineNode）。
 */
export const ANNOTATION_MARK = '※'

export interface AutoItem {
  source: 'toc' | 'highlight' | 'wikilink' | 'annotation'
  content: string
  /** annotation 条目：批注内容（{>>…<<} 内文本，可为空串） */
  note?: string
  /** 树深度：H2 = 0，H3 = 1…；对应条目 = 栈深；任何 H2 之前的条目 = 0 */
  depth: number
  anchorLine: number
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/
// 批注排最前（{==x==} 不能被 == 高亮抢先拆散）；高亮先于 wikilink：
// `==text [[x]]==` 整体按高亮收录，内部 wikilink 不再单独出条目
const INLINE_RE =
  /\{==([^=\n]+?)==\}\{>>(.*?)<<\}|\{>>(.*?)<<\}|\^\^([^^\n]+?)\^\^|(?<![\w=])==([^\s=][^=\n]*?)==(?![\w=])|\[\[([^\]\n]+?)\]\]/g

/** 句末标点（中英）。分号也算：长句里的独立子句单独成条更可读。 */
const SENTENCE_END_RE = /[。！？；.!?;]/

/** [start, end) 区间集合内？ */
function inRanges(pos: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => pos >= s && pos < e)
}

/**
 * 求 line 中包含 [from, to) 的句子范围（含句末标点）。protected 区间
 * （wikilink/批注/高亮的完整标记）内的标点不作为句子边界。
 */
function sentenceRangeAt(
  line: string, from: number, to: number, protectedRanges: Array<[number, number]>,
): [number, number] {
  let s = 0
  for (let i = from - 1; i >= 0; i--) {
    if (SENTENCE_END_RE.test(line[i]) && !inRanges(i, protectedRanges)) { s = i + 1; break }
  }
  let e = line.length
  for (let i = to; i < line.length; i++) {
    if (SENTENCE_END_RE.test(line[i]) && !inRanges(i, protectedRanges)) { e = i + 1; break }
  }
  return [s, e]
}

/** 句子用于大纲展示：去掉批注标记（点批注整体删除，包裹批注还原为原文）。 */
function cleanSentence(text: string): string {
  return text
    .replace(/\{==([^=\n]+?)==\}\{>>.*?<<\}/g, '$1')
    .replace(/\{>>.*?<<\}/g, '')
    .trim()
}

/**
 * 标题用于 toc 展示：还原为纯净文本 —— 批注同 cleanSentence，高亮/wikilink
 * 剥掉标记只留文字。标题上的这些标记另派生为 toc 的子节点（见 deriveAutoItems）。
 */
function cleanHeading(text: string): string {
  return cleanSentence(text)
    .replace(/\^\^([^^\n]+?)\^\^/g, '$1')
    .replace(/(?<![\w=])==([^\s=][^=\n]*?)==(?![\w=])/g, '$1')
    .replace(/\[\[([^\]\n]+?)\]\]/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

interface StackEntry { level: number; content: string; anchorLine: number; emitted: boolean }

/**
 * Derive outline auto-items from highlights, wikilinks and CriticMarkup
 * annotations. Each item is grouped under its nearest sub-heading path
 * (H2–H6, nested relatively); the document H1 is skipped (and resets the
 * stack). Headings are emitted lazily — only when an item beneath them
 * appears.
 *
 * - highlight（==x== / ^^x^^）：内容 = 高亮文本（原行为）。
 * - annotation `{==原文==}{>>批注<<}`：内容 = 原文，note = 批注。
 * - 插入点批注 `{>>批注<<}`：内容 = 批注符号 `※`（样式如高亮），note = 批注。
 * - wikilink：内容 = 所在整句（保留 [[…]]），同句多个 wikilink 合并为一条。
 * - 标题上的上述标记：toc 条目保持纯净文本，每个标记降为该 toc 的子条目
 *   （wikilink 子条目只含 `[[目标]]` 本身）。
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

  const emitHeadingPath = () => {
    for (let d = 0; d < stack.length; d++) {
      const entry = stack[d]
      if (entry.emitted) continue
      items.push({ source: 'toc', content: entry.content, depth: d, anchorLine: entry.anchorLine })
      entry.emitted = true
    }
  }

  // Extract highlight/annotation/wikilink markers carried on a heading line and
  // emit them as children of the current stack path (depth = stack.length). For
  // H1 the stack is empty, so its markers land at root depth 0 (H1 itself is
  // never a toc node) — that's how an annotation on an H1 still reaches the
  // outline instead of being dropped with the skipped H1.
  const emitHeadingMarkers = (rawTitle: string, li: number) => {
    for (const m of rawTitle.matchAll(INLINE_RE)) {
      const anchorLine = li + 1
      if (m[1] != null) {
        const text = m[1].trim()
        if (!text) continue
        emitHeadingPath()
        items.push({ source: 'annotation', content: text, note: m[2], depth: stack.length, anchorLine })
      } else if (m[3] != null) {
        emitHeadingPath()
        items.push({ source: 'annotation', content: ANNOTATION_MARK, note: m[3], depth: stack.length, anchorLine })
      } else if (m[6] != null) {
        if (isBlockedWikilink(m[6])) continue   // 黑名单命中：标题行也不派生
        emitHeadingPath()
        items.push({ source: 'wikilink', content: `[[${m[6]}]]`, depth: stack.length, anchorLine })
      } else {
        const text = (m[4] ?? m[5] ?? '').trim()
        if (!text) continue
        emitHeadingPath()
        items.push({ source: 'highlight', content: text, depth: stack.length, anchorLine })
      }
    }
  }

  for (let li = start; li < lines.length; li++) {
    const line = lines[li]
    if (/^(```|~~~)/.test(line.trim())) { inFence = !inFence; continue }
    if (inFence) continue

    const h = line.match(HEADING_RE)
    if (h) {
      const level = h[1].length
      const rawTitle = h[2].trim()
      if (level === 1) {
        // H1 resets sub-heading context and is not itself a toc node, but any
        // marks on its title still surface — at root depth (empty stack).
        stack.length = 0
        emitHeadingMarkers(rawTitle, li)
        continue
      }
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, content: cleanHeading(rawTitle), anchorLine: li + 1, emitted: false })
      // 标题上的高亮/批注/wikilink：toc 保持纯净，标记降为 toc 的子节点显示。
      emitHeadingMarkers(rawTitle, li)
      continue
    }

    const matches = [...line.matchAll(INLINE_RE)]
    if (matches.length === 0) continue
    const protectedRanges: Array<[number, number]> = matches.map(
      (m) => [m.index!, m.index! + m[0].length],
    )
    // 同句 wikilink 合并：按句子起点去重
    const emittedSentences = new Set<number>()

    for (const m of matches) {
      const anchorLine = li + 1
      if (m[1] != null) {
        // 包裹批注：原文为内容，批注随行
        const text = m[1].trim()
        if (!text) continue
        emitHeadingPath()
        items.push({ source: 'annotation', content: text, note: m[2], depth: stack.length, anchorLine })
        continue
      }
      if (m[3] != null) {
        // 插入点批注（无包裹文字）：用批注符号占位（样式如高亮），批注文本挂到
        // note 子节点。空批注也照常出条目——刚插入尚未填写的锚点亦可见可编辑。
        emitHeadingPath()
        items.push({ source: 'annotation', content: ANNOTATION_MARK, note: m[3], depth: stack.length, anchorLine })
        continue
      }
      if (m[6] != null) {
        if (isBlockedWikilink(m[6])) continue   // 黑名单命中：不派生成大纲条目
        // wikilink：整句为内容（保留 [[…]]），同句去重
        const [s, e] = sentenceRangeAt(line, m.index!, m.index! + m[0].length, protectedRanges)
        if (emittedSentences.has(s)) continue
        const text = cleanSentence(line.slice(s, e))
        if (!text) continue
        emittedSentences.add(s)
        emitHeadingPath()
        items.push({ source: 'wikilink', content: text, depth: stack.length, anchorLine })
        continue
      }
      // 高亮（^^…^^ / ==…==）
      const text = (m[4] ?? m[5] ?? '').trim()
      if (!text) continue
      emitHeadingPath()
      items.push({ source: 'highlight', content: text, depth: stack.length, anchorLine })
    }
  }
  return items
}
