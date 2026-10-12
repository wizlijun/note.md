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

  const bracketEnds = new Map<number, number>()
  const brackets: number[] = []
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\') { i += 2; continue }
    if (text[i] === '`') { i = codeEnds.get(i)!; continue }
    if (text[i] === '[') brackets.push(i)
    else if (text[i] === ']' && brackets.length > 0) {
      bracketEnds.set(brackets.pop()!, i + 1)
      // Backticks inside a link destination are URL characters, not prose code.
      if (brackets.length === 0 && text[i + 1] === '(') {
        const end = balancedEnd(text, i + 1, '(', ')')
        if (end > i + 1) { i = end; continue }
      }
    }
    i++
  }

  const nextClose = new Map<string, number>()
  // Calls advance through this line, so cache even failed searches rather than
  // scanning the same suffix again for each unmatched opening delimiter.
  const closeAfter = (close: string, from: number): number => {
    let end = nextClose.get(close)
    if (end === -1 || (end !== undefined && end >= from)) return end
    end = text.indexOf(close, from)
    while (end >= 0) {
      let slashes = 0
      for (let i = end - 1; i >= 0 && text[i] === '\\'; i--) slashes++
      if (slashes % 2 === 0) break
      end = text.indexOf(close, end + close.length)
    }
    nextClose.set(close, end)
    return end
  }
  return { codeEnds, bracketEnds, closeAfter }
}

function protectedEnd(text: string, start: number, index: ReturnType<typeof inlineIndex>): number {
  if (text[start] === '\\') return Math.min(start + 2, text.length)
  if (text[start] === '`') return index.codeEnds.get(start)!
  for (const [open, close] of [['{==', '==}'], ['{>>', '<<}'], ['[[', ']]'], ['$', '$']]) {
    if (!text.startsWith(open, start)) continue
    const end = index.closeAfter(close, start + open.length)
    if (end >= 0) return end + close.length
  }
  const bracket = text[start] === '!' && text[start + 1] === '[' ? start + 1 : start
  if (text[bracket] === '[') {
    const end = index.bracketEnds.get(bracket)
    if (end !== undefined && text[end] === '(') {
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
