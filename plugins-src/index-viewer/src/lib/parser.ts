import { Lexer, type Token, type Tokens } from 'marked'
import { parseDocument } from 'yaml'
import type { IndexCell, IndexDocument, IndexView } from './model'

const views = new Set<IndexView>(['table', 'list', 'board', 'gallery'])

function cell(tokens: Token[]): IndexCell {
  const result: IndexCell = { text: '', links: [], images: [] }
  const plain = (parts: Token[]): void => {
    for (const token of parts) {
      if (token.type === 'image') {
        result.images.push({ alt: token.text, href: token.href })
        result.text += token.text
        continue
      }
      if (token.type === 'link') {
        const start = result.text.length
        plain(token.tokens ?? Lexer.lexInline(token.text))
        result.links.push({ text: result.text.slice(start), href: token.href, start, end: result.text.length })
        continue
      }
      if (token.type === 'html') throw new Error('Unsupported HTML')
      if (token.type === 'br') { result.text += '\n'; continue }
      if ('tokens' in token && Array.isArray(token.tokens)) { plain(token.tokens); continue }
      result.text += 'text' in token && typeof token.text === 'string' ? token.text : token.raw
    }
  }
  plain(tokens)
  const leadingSpace = result.text.length - result.text.trimStart().length
  result.text = result.text.trim()
  result.links = result.links.map(link => {
    const start = Math.max(0, Math.min(result.text.length, link.start - leadingSpace))
    const end = Math.max(start, Math.min(result.text.length, link.end - leadingSpace))
    return { ...link, start, end, text: result.text.slice(start, end) }
  })
  return result
}

/** GFM escapes pipes even inside code spans; count before Marked truncates/pads cells. */
function columnCount(line: string): number {
  const text = line.trim()
  const pipes: number[] = []
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '|') continue
    let slashes = 0
    for (let before = index - 1; before >= 0 && text[before] === '\\'; before--) slashes++
    if (slashes % 2 === 0) pipes.push(index)
  }
  return pipes.length + 1 - Number(pipes[0] === 0) - Number(pipes.at(-1) === text.length - 1)
}

function isFileLink(href: string): boolean {
  // Traversal and URI decoding are validated against the Vault by the host bridge.
  return !!href.trim() && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#|\?)/i.test(href.trim())
}

/** Reject an unsupported document as a whole so the Markdown fallback loses no rows. */
export function parseIndex(content: string, uri: string): IndexDocument | null {
  try {
    let source = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    let meta: Record<string, unknown> = {}
    if (/^---[ \t]*\n/.test(source)) {
      const lines = source.split('\n')
      const close = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line))
      if (close < 0) return null
      const yaml = parseDocument(lines.slice(1, close).join('\n'), { uniqueKeys: true })
      if (yaml.errors.length) return null
      const value: unknown = yaml.toJS({ maxAliasCount: 50 })
      if (value !== null && (typeof value !== 'object' || Array.isArray(value))) return null
      meta = (value ?? {}) as Record<string, unknown>
      source = lines.slice(close + 1).join('\n')
    }
    const view = meta.view === undefined ? 'table' : meta.view
    if (typeof view !== 'string' || !views.has(view as IndexView)) return null
    const groupBy = meta.group_by === undefined ? '' : meta.group_by
    const laneBy = meta.lane_by === undefined ? '' : meta.lane_by
    if (typeof groupBy !== 'string' || typeof laneBy !== 'string') return null
    const doc: IndexDocument = {
      uri, title: uri.split('/').at(-1)?.replace(/\.index\.md$/i, '') || 'Index',
      description: [], columns: [], rows: [], view: view as IndexView, groupBy, laneBy,
    }
    let section = '', sawTitle = false, sawTable = false
    const description = (tokens: Token[]): void => {
      for (const token of tokens) {
        if (token.type === 'space') continue
        if (token.type === 'blockquote') { description(token.tokens ?? []); continue }
        if (token.type !== 'paragraph' && token.type !== 'text') throw new Error('Unsupported description')
        // A table fragment must not be quietly turned into an explanatory paragraph.
        if (token.raw.split('\n').some(line => /^\s*\|/.test(line) || /^\s*:?-{3,}:?\s*\|/.test(line))) {
          throw new Error('Malformed table')
        }
        const text = cell('tokens' in token && token.tokens ? token.tokens : Lexer.lexInline(token.text)).text
        if (text) doc.description.push(text)
      }
    }
    for (const token of Lexer.lex(source, { gfm: true })) {
      if (token.type === 'space' || token.type === 'def') continue
      if (token.type === 'heading') {
        const text = cell(token.tokens ?? Lexer.lexInline(token.text)).text
        if (!text || token.depth > 2) return null
        if (token.depth === 1) {
          if (sawTitle || sawTable) return null
          doc.title = text
          sawTitle = true
        } else section = text
        continue
      }
      if (token.type !== 'table') { description([token]); continue }
      const table = token as Tokens.Table
      const columns = table.header.map(header => cell(header.tokens).text)
      if (columns.some(column => !column) || new Set(columns).size !== columns.length) return null
      if (sawTable && (columns.length !== doc.columns.length || columns.some((column, i) => column !== doc.columns[i]))) return null
      if (token.raw.trimEnd().split('\n').some(line => columnCount(line) !== columns.length)) return null
      doc.columns = columns
      sawTable = true
      for (const row of table.rows) {
        const firstTokens = row[0].tokens.filter(part => !(part.type === 'text' && !part.text.trim()))
        const first = firstTokens[0]
        if (firstTokens.length !== 1 || first?.type !== 'link' || !first.raw.startsWith('[') || !isFileLink(first.href)) return null
        const cells = row.map(value => cell(value.tokens))
        if (!cells[0].text || cells[0].images.length || cells[0].links.length !== 1) return null
        doc.rows.push({
          id: `row-${doc.rows.length + 1}`, title: cells[0].text, href: first.href, cells, section,
          cover: cells.flatMap(value => value.images)[0],
        })
      }
    }
    if (!sawTable || (groupBy && !doc.columns.includes(groupBy)) || (laneBy && !doc.columns.includes(laneBy))) return null
    return doc
  } catch { return null }
}
