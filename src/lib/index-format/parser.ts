import { Lexer, type Token, type Tokens } from 'marked'
import { parseDocument } from 'yaml'
import type { IndexCell, IndexDocument, IndexSection, IndexView } from './model'

const views = new Set<IndexView>(['table', 'list', 'board', 'gallery'])

/** Knowledge names are not filesystem paths; the host resolves/creates pages. */
function knowledgeToken(source: string): Tokens.Generic | undefined {
  const delimited = /^(#?)\[\[([^\[\]\r\n]+)\]\]/.exec(source)
  if (delimited) {
    const [target, alias, extra] = delimited[2].split('|')
    if (!target.trim() || extra !== undefined || (alias !== undefined && !alias.trim())) return
    const name = target.trim()
    const label = alias?.trim() || name
    const isTag = !!delimited[1]
    return { type: 'knowledge', raw: delimited[0], href: name, text: isTag ? `#[[${label}]]` : label, isTag }
  }
  const tag = /^#([\p{L}\p{M}\p{N}_/\-\p{Extended_Pictographic}\u200d\ufe0f]+)/u.exec(source)
  if (tag && !/^\p{N}+$/u.test(tag[1]) && tag[1].split('/').every(Boolean)) {
    return { type: 'knowledge', raw: tag[0], text: tag[0], href: tag[1], isTag: true }
  }
}

function indexLexer(): Lexer {
  return new Lexer({ gfm: true, extensions: {
    renderers: {}, childTokens: {},
    startInline: [source => { const index = source.search(/\[\[|#/); return index < 0 ? undefined : index }],
    inline: [function (source, tokens) {
      if (this.lexer.state.inLink) return
      const previous = tokens.at(-1)?.raw
      if (source.startsWith('#') && previous && !/\s$/.test(previous)) return
      return knowledgeToken(source)
    }],
  } })
}

function cell(tokens: Token[]): IndexCell {
  const result: IndexCell = { text: '', links: [], images: [] }
  const plain = (parts: Token[], knowledge = true): void => {
    for (const token of parts) {
      if (token.type === 'knowledge') {
        const start = result.text.length
        result.text += knowledge ? token.text : token.raw
        if (knowledge) result.links.push({ text: token.text, href: token.href, kind: 'page', start, end: result.text.length })
        continue
      }
      if (token.type === 'image') {
        result.images.push({ alt: token.text, href: token.href })
        result.text += token.text
        continue
      }
      if (token.type === 'link') {
        const start = result.text.length
        plain(token.tokens ?? Lexer.lexInline(token.text), false)
        result.links.push({ text: result.text.slice(start), href: token.href, start, end: result.text.length })
        continue
      }
      if (token.type === 'html') throw new Error('Unsupported HTML')
      if (token.type === 'br') { result.text += '\n'; continue }
      if ('tokens' in token && Array.isArray(token.tokens)) { plain(token.tokens, knowledge); continue }
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

type InlineLexer = (text: string) => Token[]

/** Protect Markdown links, images, escapes and code before reading inline markers. */
function markdownAtom(text: string, inline: InlineLexer): string {
  if (!/^(?:[`[!#\\<]|https?:\/\/|www\.)/i.test(text)) return ''
  const first = inline(text)[0]
  return first && ['link', 'image', 'codespan', 'escape', 'autolink', 'knowledge'].includes(first.type) ? first.raw : ''
}

function annotations(source: string, inline: InlineLexer) {
  const fields = new Map<string, IndexCell>()
  const tags: Token[] = []
  const seenTags = new Set<string>()
  let note = '', cover: IndexCell['images'][number] | undefined
  for (let i = 0; i < source.length;) {
    const rest = source.slice(i)
    const tag = (i === 0 || /\s/.test(source[i - 1])) ? knowledgeToken(rest) : undefined
    if (tag?.isTag) {
      const key = tag.href.toLocaleLowerCase()
      if (!seenTags.has(key)) { tags.push(tag); seenTags.add(key) }
      i += tag.raw.length
      continue
    }
    const atom = markdownAtom(rest, inline)
    if (atom) {
      note += atom
      cover ??= cell(inline(atom)).images[0]
      i += atom.length
      continue
    }
    const field = /^\[([^\[\]:\r\n]+)::\s*/.exec(rest)
    if (field) {
      const name = field[1].trim()
      if (!name || /[!*`<>\\]/.test(name) || ['文件', '标签', '说明'].includes(name) || fields.has(name)) throw new Error('Ambiguous field')
      let end = i + field[0].length
      let depth = 1
      for (; end < source.length;) {
        const protectedAtom = markdownAtom(source.slice(end), inline)
        if (protectedAtom) { end += protectedAtom.length; continue }
        if (source[end] === '[') depth++
        if (source[end] === ']' && --depth === 0) break
        end++
      }
      if (depth !== 0) throw new Error('Unclosed inline field')
      const value = cell(inline(source.slice(i + field[0].length, end)))
      fields.set(name, value)
      cover ??= value.images[0]
      note += ' '
      i = end + 1
      continue
    }
    // Empty names and other malformed field openers are never ordinary prose.
    if (/^\[[^\[\]]*::/.test(rest)) throw new Error('Invalid inline field')
    note += source[i++]
  }
  const description = cell(inline(note))
  if (tags.length) fields.set('标签', cell(tags.flatMap((tag, index) => index ? [{ type: 'text', raw: ' ', text: ' ' }, tag] : [tag])))
  if (description.text || description.images.length) fields.set('说明', description)
  return { fields, cover }
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
    const view = meta.view === undefined ? 'list' : meta.view
    if (typeof view !== 'string' || !views.has(view as IndexView)) return null
    const groupBy = meta.group_by === undefined ? '' : meta.group_by
    const laneBy = meta.lane_by === undefined ? '' : meta.lane_by
    if (typeof groupBy !== 'string' || typeof laneBy !== 'string') return null
    const doc: IndexDocument = {
      uri, title: uri.split('/').at(-1)?.replace(/\.index\.md$/i, '') || 'Index',
      description: [], columns: ['文件'], rows: [], sections: [], view: view as IndexView, groupBy, laneBy,
    }
    // Headings own the hierarchy. Every physical list line owns all its metadata.
    const lexer = indexLexer()
    const blocks = lexer.lex(source)
    const definitions = new Set(blocks.filter(token => token.type === 'def').flatMap(token => token.raw.trimEnd().split('\n')))
    const inline = (text: string) => lexer.inlineTokens(text)
    const records: Map<string, IndexCell>[] = []
    const headings: IndexSection[] = []
    let sawTitle = false
    const bodyLineOffset = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').length - source.split('\n').length
    for (const [lineIndex, raw] of source.split('\n').entries()) {
      const line = raw.trim()
      if (!line || definitions.has(raw)) continue
      const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line)
      if (heading) {
        const text = cell(inline(heading[2])).text
        const level = heading[1].length
        if (!text) return null
        if (level === 1) {
          if (sawTitle || doc.rows.length || doc.sections.length) return null
          doc.title = text
          sawTitle = true
        } else {
          while (headings.length && headings.at(-1)!.level >= level) headings.pop()
          const parent = headings.at(-1)
          const section: IndexSection = { id: `section-${doc.sections.length + 1}`, parentId: parent?.id ?? '', title: text, level, path: [...(parent?.path ?? []), text], description: [] }
          headings.push(section)
          doc.sections.push(section)
        }
        continue
      }
      const item = /^(?:[-+*]|\d+[.)])\s+(.+)$/.exec(line)
      if (item) {
        const body = item[1].trim()
        const first = inline(body)[0]
        const page = first?.type === 'knowledge'
        if (!page && (first?.type !== 'link' || !first.raw.startsWith('[') || !isFileLink(first.href))) return null
        const primary = cell([first])
        if (!primary.text || primary.images.length || primary.links.length !== 1) return null
        const tail = body.slice(first.raw.length)
        if (tail && !/^\s/.test(tail)) return null
        const { fields, cover } = annotations(tail, inline)
        const record = new Map([['文件', primary], ...fields])
        for (const name of fields.keys()) if (!doc.columns.includes(name)) doc.columns.push(name)
        records.push(record)
        const section = headings.at(-1)
        doc.rows.push({ id: `row-${doc.rows.length + 1}`, line: bodyLineOffset + lineIndex + 1, ...(page ? { linkKind: 'page' as const } : {}), title: primary.text, href: first.href, cells: [], section: section?.path.join(' / ') ?? '', sectionId: section?.id ?? '', cover })
        continue
      }
      // Keep prose with its heading, while unsupported structures trigger fallback.
      if (/^\[[^\[\]]*::/.test(line)) return null
      const description = Lexer.lex(line, { gfm: true })
      const token = description[0]
      if (description.length !== 1 || !['paragraph', 'blockquote'].includes(token?.type)
        || /^\|/.test(line) || /^[-:| ]+\|[-:| ]*$/.test(line) || /^#{7,}\s/.test(line)) return null
      const text = cell(inline(line.replace(/^>\s?/, ''))).text
      if (text) (headings.at(-1)?.description ?? doc.description).push(text)
    }
    if ((!doc.rows.length && !doc.sections.length) || (groupBy && !doc.columns.includes(groupBy)) || (laneBy && !doc.columns.includes(laneBy))) return null
    doc.rows.forEach((row, index) => {
      row.cells = doc.columns.map(name => records[index].get(name) ?? { text: '', links: [], images: [] })
    })
    return doc
  } catch { return null }
}
