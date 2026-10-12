import { frontmatterTokens, makeToken, type SourceLine } from './frontmatter'
import type { Token } from './types'

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

function protectedEnd(text: string, start: number): number {
  if (text[start] === '\\') return Math.min(start + 2, text.length)
  if (text[start] === '`') {
    let end = start + 1
    while (text[end] === '`') end++
    const size = end - start
    for (let i = end; i < text.length;) {
      if (text[i] !== '`') { i++; continue }
      let next = i + 1
      while (text[next] === '`') next++
      if (next - i === size) return next
      i = next
    }
    return end
  }
  for (const [open, close] of [['{==', '==}'], ['{>>', '<<}'], ['[[', ']]'], ['$', '$']]) {
    if (!text.startsWith(open, start)) continue
    let end = text.indexOf(close, start + open.length)
    while (end >= 0 && text[end - 1] === '\\') end = text.indexOf(close, end + close.length)
    if (end >= 0) return end + close.length
  }
  const bracket = text[start] === '!' && text[start + 1] === '[' ? start + 1 : start
  if (text[bracket] === '[') {
    const end = balancedEnd(text, bracket, '[', ']')
    if (end > bracket && text[end] === '(') {
      const linkEnd = balancedEnd(text, end, '(', ')')
      if (linkEnd > end) return linkEnd
    }
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

function proseTokens(text: string, line: SourceLine): Token[] {
  const content = text.slice(line.start, line.contentEnd)
  const tokens: Token[] = []
  // Ordered-list punctuation belongs to the first sentence, just like headings and quotes.
  let cursor = /^[ \t]*(?:(?:>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+|#{1,6}[ \t]+)[ \t]*)*/.exec(content)![0].length
  let start = 0
  while (cursor < content.length) {
    const protectedTo = protectedEnd(content, cursor)
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
