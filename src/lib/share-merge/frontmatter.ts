import type { Token } from './types'

export interface SourceLine {
  start: number
  contentEnd: number
  end: number
}

export function sourceLines(text: string): SourceLine[] {
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

export const makeToken = (text: string, start: number, end: number, fmKey?: string): Token =>
  ({ text: text.slice(start, end), start, end, ...(fmKey === undefined ? {} : { fmKey }) })

export function frontmatterTokens(text: string, lines: SourceLine[] = sourceLines(text)): { tokens: Token[]; nextLine: number } | undefined {
  const first = lines[0]
  if (!first || first.end === first.contentEnd || text.slice(first.start, first.contentEnd).replace(/^\uFEFF/, '') !== '---') return
  const closing = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)$/.test(text.slice(line.start, line.contentEnd)))
  if (closing < 0) return
  const tokens = [makeToken(text, 0, first.end)]
  let start = first.end
  let key: string | undefined
  for (let i = 1; i < closing; i++) {
    const line = lines[i]
    const content = text.slice(line.start, line.contentEnd)
    const match = /^[^\s#\-][^:\r\n]*:/.exec(content)
    if (match) {
      if (line.start > start) tokens.push(makeToken(text, start, line.start, key))
      start = line.start
      key = match[0].slice(0, -1).trim().replace(/^(['"])(.*)\1$/, '$2')
    } else if (key === undefined && !/^\s*(#.*)?$/.test(content)) {
      return { tokens: [{ ...makeToken(text, 0, lines[closing].end), fmAtomic: true }], nextLine: closing + 1 }
    }
  }
  if (lines[closing].start > start) tokens.push(makeToken(text, start, lines[closing].start, key))
  tokens.push(makeToken(text, lines[closing].start, lines[closing].end))
  return { tokens, nextLine: closing + 1 }
}
