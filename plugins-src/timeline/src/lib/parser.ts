import { parseDocument } from 'yaml'
import { Lexer, type Token } from 'marked'

export interface TimelineLink { label: string; target: string }
export interface TimelineItem {
  id: string
  /** Minutes after midnight, with seconds preserved as fractional minutes. */
  start: number
  end: number
  action: string
  text: string
  links: TimelineLink[]
  children: TimelineItem[]
}
export interface TimelineDocument {
  title: string
  date: string
  description: string
  items: TimelineItem[]
  notes: string[]
}

function minute(value: string): number | null {
  const [h, m, s = 0] = value.split(':').map(Number)
  if (h > 24 || m > 59 || s > 59 || (h === 24 && (m || s))) return null
  return h * 60 + m + s / 60
}

function inline(text: string): { text: string; links: TimelineLink[] } {
  const links: TimelineLink[] = []
  const plain = (tokens: Token[]): string => tokens.map(token => {
    if (token.type === 'link') {
      // Bare URLs/email addresses belong to the description, not source buttons.
      if (!token.raw.startsWith('[')) return token.text
      links.push({ label: token.text, target: token.href })
      return ''
    }
    if ('tokens' in token && Array.isArray(token.tokens)) return plain(token.tokens)
    return 'text' in token && typeof token.text === 'string' ? token.text : token.raw
  }).join('')
  return { text: plain(Lexer.lexInline(text)).trim(), links }
}

/** A failed time entry rejects the whole view; no partially parsed day is shown. */
export function parseTimeline(content: string, uri = ''): TimelineDocument | null {
  try {
    const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
    if (!/^---\s*$/.test(lines[0] ?? '')) return null
    const close = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line))
    if (close < 0) return null
    const yaml = parseDocument(lines.slice(1, close).join('\n'), { uniqueKeys: true })
    if (yaml.errors.length) return null
    const meta = yaml.toJS({ maxAliasCount: 50 })
    if (!meta || Array.isArray(meta) || typeof meta.type !== 'string' || meta.type.trim().toLowerCase() !== 'timeline') return null
    const doc: TimelineDocument = {
      title: typeof meta.title === 'string' ? meta.title : '',
      date: (uri.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\.timeline)?\.md$/i) ?? String(meta.date ?? meta.title ?? '').match(/\b(\d{4}-\d{2}-\d{2})\b/))?.[1] ?? '',
      description: typeof meta.description === 'string' ? meta.description : '',
      items: [], notes: [],
    }
    const stack: { indent: number; item: TimelineItem }[] = []
    let fence: { character: string; length: number } | null = null
    for (let i = close + 1; i < lines.length; i++) {
      const line = lines[i]
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (fence) {
        doc.notes.push(line)
        if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null
        continue
      }
      if (marker) {
        fence = { character: marker[1][0], length: marker[1].length }
        doc.notes.push(line)
        continue
      }
      if (/^#{1,6}\s+.*\d{1,2}:\d{2}/.test(line)) return null
      if (/^#\s+/.test(line)) { if (!doc.title) doc.title = line.replace(/^#\s+/, ''); continue }
      if (!line.trim()) continue
      const match = line.match(/^(\s*)[-*+]\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*[–—~-]\s*(\d{1,2}:\d{2}(?::\d{2})?)\s+[—–-]\s+(.+)$/)
      if (!match) {
        // An unsupported list could contain lost events, so leave it to Markdown.
        if (/^\s*(?:[-*+]\s|\d+[.)]\s|\d{1,2}:\d{2}|\|)/.test(line)) return null
        doc.notes.push(line)
        continue
      }
      const start = minute(match[2]), end = minute(match[3])
      if (start === null || end === null || end < start) return null
      const parsed = inline(match[4])
      const activity = parsed.text.match(/^([^：:]+)[：:]\s*(.*)$/)
      const item: TimelineItem = {
        id: `line-${i + 1}`, start, end,
        action: activity?.[1].trim() ?? '', text: activity?.[2].trim() ?? parsed.text,
        links: parsed.links, children: [],
      }
      if (!item.text && !item.action) return null
      const indent = match[1].replace(/\t/g, '    ').length
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
      if (indent > 0) {
        const parent = stack[stack.length - 1]?.item
        if (!parent || item.start < parent.start || item.end > parent.end) return null
        parent.children.push(item)
      } else doc.items.push(item)
      stack.push({ indent, item })
    }
    doc.items.sort((a, b) => a.start - b.start || a.end - b.end)
    doc.title ||= doc.date ? `${doc.date} Timeline` : 'Timeline'
    return doc
  } catch { return null }
}
