import { Lexer, type Token } from 'marked'
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
      description: [], columns: ['文件'], rows: [], view: view as IndexView, groupBy, laneBy,
    }
    // List indentation is presentation only. A standalone file-link item starts a
    // record; named fields belong to the nearest record until another item/H2.
    const lexer = new Lexer({ gfm: true })
    const blocks = lexer.lex(source)
    const definitions = new Set(blocks.filter(token => token.type === 'def').flatMap(token => token.raw.trimEnd().split('\n')))
    const inline = (text: string) => lexer.inlineTokens(text)
    const records: Map<string, IndexCell>[] = []
    let current: Map<string, IndexCell> | undefined
    let section = '', sawTitle = false
    for (const raw of source.split('\n')) {
      const line = raw.trim()
      if (!line || definitions.has(raw)) continue
      const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line)
      if (heading) {
        const text = cell(inline(heading[2])).text
        if (!text || heading[1].length > 2) return null
        if (heading[1].length === 1) {
          if (sawTitle || doc.rows.length) return null
          doc.title = text
          sawTitle = true
        } else section = text
        current = undefined
        continue
      }
      const item = /^(?:[-+*]|\d+[.)])\s+(.+)$/.exec(line)
      const body = item ? item[1].trim() : line
      const tokens = inline(body)
      const first = tokens[0]
      if (item && tokens.length === 1 && first?.type === 'link' && first.raw.startsWith('[')) {
        const primary = cell(tokens)
        if (!isFileLink(first.href) || !primary.text || primary.images.length || primary.links.length !== 1) return null
        current = new Map([['文件', primary]])
        records.push(current)
        doc.rows.push({ id: `row-${doc.rows.length + 1}`, title: primary.text, href: first.href, cells: [], section })
        continue
      }
      const field = /^([^:：]+)[:：]\s*(.*)$/.exec(body)
      if (field && current) {
        const name = cell(inline(field[1]))
        // Names are explicit text, never a second file link or nested structure.
        if (!name.text || /^!?\[/.test(name.text) || name.links.length || name.images.length || current.has(name.text)) return null
        current.set(name.text, cell(inline(field[2])))
        if (!doc.columns.includes(name.text)) doc.columns.push(name.text)
        continue
      }
      if (item || current) return null
      // Only prose before records (or immediately after H2) is page description.
      // Never reinterpret tables, fences or other blocks as hidden index data.
      const description = Lexer.lex(line, { gfm: true })
      const token = description[0]
      if (description.length !== 1 || !['paragraph', 'blockquote'].includes(token?.type)
        || /^\|/.test(line) || /^[-:| ]+\|[-:| ]*$/.test(line)) return null
      const text = cell(inline(line.replace(/^>\s?/, ''))).text
      if (text) doc.description.push(text)
    }
    if (!doc.rows.length || (groupBy && !doc.columns.includes(groupBy)) || (laneBy && !doc.columns.includes(laneBy))) return null
    doc.rows.forEach((row, index) => {
      row.cells = doc.columns.map(name => records[index].get(name) ?? { text: '', links: [], images: [] })
      row.cover = [...records[index].values()].flatMap(value => value.images)[0]
    })
    return doc
  } catch { return null }
}
