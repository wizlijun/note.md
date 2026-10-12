import { frontmatterTokens, makeToken, type SourceLine } from './frontmatter'
import type { Token } from './types'

const inlineDelimiters = [['{==', '==}'], ['{>>', '<<}'], ['[[', ']]'], ['$', '$']] as const

interface InlineAtoms {
  codeEnds: Map<number, number>
  closeAfter: (close: string, from: number) => number
}

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  for (let start = 0; start < text.length;) {
    let contentEnd = start
    while (contentEnd < text.length && text[contentEnd] !== '\r' && text[contentEnd] !== '\n') contentEnd++
    const end = contentEnd + (text[contentEnd] === '\r' && text[contentEnd + 1] === '\n' ? 2 : contentEnd < text.length ? 1 : 0)
    lines.push({ start, contentEnd, end })
    start = end
  }
  return lines
}

function balancedEnd(text: string, start: number, open: string, close: string): number {
  let depth = 0
  let quote = ''
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue }
    if (open === '(' && (text[i] === '"' || text[i] === "'")) {
      if (!quote && /\s/.test(text[i - 1])) quote = text[i]
      else if (quote === text[i]) quote = ''
    }
    if (quote) continue
    if (text[i] === open) depth++
    if (text[i] === close && --depth === 0) return i + 1
  }
  return start
}

function inlineIndex(text: string) {
  const codeEnds = new Map<number, number>()
  const runs: { start: number; end: number }[] = []
  for (let i = 0; i < text.length;) {
    if (text[i] !== '`') { i++; continue }
    const start = i++
    while (text[i] === '`') i++
    runs.push({ start, end: i })
  }
  const nextCode = new Map<number, number>()
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]
    // A preceding escape can consume the first backtick of an opening run.
    for (let start = run.start; start < run.end; start++) codeEnds.set(start, nextCode.get(run.end - start) ?? run.end)
    nextCode.set(run.end - run.start, run.end)
  }

  const closes = new Map<string, number[]>()
  for (const [, close] of inlineDelimiters) {
    const positions: number[] = []
    for (let end = text.indexOf(close); end >= 0; end = text.indexOf(close, end + 1)) {
      let slashes = 0
      for (let i = end - 1; i >= 0 && text[i] === '\\'; i--) slashes++
      if (slashes % 2 === 0) positions.push(end)
    }
    closes.set(close, positions)
  }
  // Immutable positions can be queried by both scans, in any cursor order.
  const closeAfter = (close: string, from: number): number => {
    const positions = closes.get(close)!
    let low = 0
    let high = positions.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (positions[mid] < from) low = mid + 1
      else high = mid
    }
    return positions[low] ?? -1
  }
  const labelEnds = new Map<number, number>()
  // Match only when prose reaches a link candidate. Within a label, escapes,
  // code spans and nested brackets determine its boundary; prose atoms cannot
  // pair with delimiters outside the label and swallow its closing bracket.
  const labelEnd = (start: number): number => {
    const cached = labelEnds.get(start)
    if (cached !== undefined) return cached
    const brackets = [start]
    for (let i = start + 1; i < text.length;) {
      if (text[i] === '\\') { i += 2; continue }
      if (text[i] === '`') { i = codeEnds.get(i)!; continue }
      if (text[i] === '[') {
        const nested = labelEnds.get(i)
        if (nested === -1) break
        if (nested !== undefined) { i = nested; continue }
        brackets.push(i)
      } else if (text[i] === ']') {
        labelEnds.set(brackets.pop()!, i + 1)
        if (brackets.length === 0) return i + 1
      }
      i++
    }
    // Cache every unmatched opener from this scan, not just its first one.
    for (const bracket of brackets) labelEnds.set(bracket, -1)
    return -1
  }
  return { codeEnds, closeAfter, labelEnd }
}

function atomEnd(text: string, start: number, index: InlineAtoms): number {
  if (text[start] === '\\') return Math.min(start + 2, text.length)
  if (text[start] === '`') return index.codeEnds.get(start)!
  for (const [open, close] of inlineDelimiters) {
    if (!text.startsWith(open, start)) continue
    const end = index.closeAfter(close, start + open.length)
    if (end >= 0) return end + close.length
  }
  if (text[start] === '<') {
    let quote = ''
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '"' || text[i] === "'") {
        if (!quote) quote = text[i]
        else if (quote === text[i]) quote = ''
      }
      if (text[i] === '>' && !quote) return i + 1
    }
  }
  return start
}

function protectedEnd(text: string, start: number, index: ReturnType<typeof inlineIndex>): number {
  const end = atomEnd(text, start, index)
  if (end > start) return end
  const bracket = text[start] === '!' && text[start + 1] === '[' ? start + 1 : start
  if (text[bracket] === '[') {
    const labelEnd = index.labelEnd(bracket)
    if (labelEnd >= 0 && text[labelEnd] === '(') {
      const linkEnd = balancedEnd(text, labelEnd, '(', ')')
      if (linkEnd > labelEnd) return linkEnd
    }
  }
  return start
}

function proseTokens(text: string, line: SourceLine): Token[] {
  const content = text.slice(line.start, line.contentEnd)
  const index = inlineIndex(content)
  const tokens: Token[] = []
  // Ordered-list punctuation belongs to the first sentence, just like headings and quotes.
  let cursor = /^[ \t]*(?:(?:>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+|#{1,6}[ \t]+)[ \t]*)*/.exec(content)![0].length
  let start = 0
  while (cursor < content.length) {
    const protectedTo = protectedEnd(content, cursor, index)
    if (protectedTo > cursor) { cursor = protectedTo; continue }
    const char = content[cursor]
    if ('。！？；!?;…'.includes(char) || (char === '.' && /\s/.test(content[cursor + 1] ?? (line.end > line.contentEnd ? '\n' : '')))) {
      cursor++
      while (cursor < content.length && '」』”’"\')]）】'.includes(content[cursor])) cursor++
      while (cursor < content.length && /[^\S\r\n]/.test(content[cursor])) cursor++
      tokens.push(makeToken(text, line.start + start, cursor === content.length ? line.end : line.start + cursor))
      start = cursor
    } else cursor++
  }
  if (start < content.length || tokens.length === 0) tokens.push(makeToken(text, line.start + start, line.end))
  return tokens
}

export function tokenize(text: string): Token[] {
  const lines = sourceLines(text)
  const fm = frontmatterTokens(text, lines)
  const tokens = fm?.tokens ?? []
  const content = (i: number) => text.slice(lines[i].start, lines[i].contentEnd)
  const blank = (i: number) => /^\s*$/.test(content(i))
  for (let i = fm?.nextLine ?? 0; i < lines.length;) {
    const current = content(i)
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(current)
    if (fence || current.trim() === '$$') {
      let end = i + 1
      while (end < lines.length) {
        const candidate = content(end)
        const closed = fence
          ? new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*$`).test(candidate)
          : candidate.trim() === '$$'
        end++
        if (closed) break
      }
      tokens.push(makeToken(text, lines[i].start, lines[end - 1].end))
      i = end
    } else if (/^<(?:[a-zA-Z/]|!--)/.test(current)) {
      let end = i + 1
      while (end < lines.length && !blank(end)) end++
      tokens.push(makeToken(text, lines[i].start, lines[end - 1].end))
      i = end
    } else if (current.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(content(i + 1))) {
      tokens.push(makeToken(text, lines[i].start, lines[i].end), makeToken(text, lines[i + 1].start, lines[i + 1].end))
      i += 2
      while (i < lines.length && !blank(i) && content(i).includes('|')) {
        tokens.push(makeToken(text, lines[i].start, lines[i].end))
        i++
      }
    } else if (blank(i)) {
      let end = i + 1
      while (end < lines.length && blank(end)) end++
      tokens.push(makeToken(text, lines[i].start, lines[end - 1].end))
      i = end
    } else {
      for (const token of proseTokens(text, lines[i])) tokens.push(token)
      i++
    }
  }
  return tokens
}
