import { parseDocument } from 'yaml'
import { Lexer, type Token } from 'marked'

export interface TimelineLink { label: string; target: string }
export type TimelineImportance = 'high' | 'normal' | 'unknown'
export interface TimelineEvidence { source: string; locator: string }
export interface TimelineAnomaly {
  status: 'flagged' | 'none' | 'unknown'
  reason: string
  evidence: TimelineEvidence[]
}
export interface TimelineEventMetadata {
  importance: TimelineImportance
  importance_origin?: 'manual'
  reason: string
  evidence: TimelineEvidence[]
  signals: {
    source_chars: number | null
    duration_minutes: number | null
    owner_relation: 'direct' | 'related' | 'background' | 'unknown'
  }
  anomaly?: TimelineAnomaly
}
export interface TimelineItem {
  id: string
  metadata: TimelineEventMetadata
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

const eventId = /^[a-z][a-z0-9_-]*$/
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const enumeration = (value: unknown, choices: string[]): boolean => typeof value === 'string' && choices.includes(value)

function validEvidence(value: unknown, sources: Set<string>, required: boolean): boolean {
  return Array.isArray(value) && (!required || value.length > 0) && value.every(entry => {
    if (!record(entry) || typeof entry.source !== 'string' || !sources.has(entry.source) || typeof entry.locator !== 'string') return false
    const range = entry.locator.match(/^L([1-9]\d*)(?:-L([1-9]\d*))?$/)
    return !!range && (!range[2] || BigInt(range[2]) >= BigInt(range[1]))
  })
}

function validMetadata(value: unknown, sources: Set<string>): value is TimelineEventMetadata {
  if (!record(value) || !enumeration(value.importance, ['high', 'normal', 'unknown']) || !nonempty(value.reason)) return false
  if ('importance_origin' in value && value.importance_origin !== 'manual') return false
  if (!validEvidence(value.evidence, sources, value.importance !== 'unknown' && value.importance_origin !== 'manual') || !record(value.signals)) return false
  const { source_chars, duration_minutes, owner_relation } = value.signals
  if (source_chars !== null && (typeof source_chars !== 'number' || !Number.isInteger(source_chars) || source_chars < 0)) return false
  if (duration_minutes !== null && (typeof duration_minutes !== 'number' || !Number.isFinite(duration_minutes) || duration_minutes < 0)) return false
  if (!enumeration(owner_relation, ['direct', 'related', 'background', 'unknown'])) return false
  if ('anomaly' in value) {
    const anomaly = value.anomaly
    if (!record(anomaly) || !enumeration(anomaly.status, ['flagged', 'none', 'unknown']) || !nonempty(anomaly.reason)) return false
    if (!validEvidence(anomaly.evidence, sources, anomaly.status === 'flagged')) return false
  }
  return true
}

function legacyMetadata(): TimelineEventMetadata {
  return {
    // Only legacy synthetic assessments leave the reason for the UI to localize.
    importance: 'unknown', reason: '', evidence: [],
    signals: { source_chars: null, duration_minutes: null, owner_relation: 'unknown' },
  }
}

/** Use Markdown block structure so indented code cannot masquerade as a topic. */
function codeLines(body: string, firstLine: number): Set<number> {
  const result = new Set<number>()
  const newlines = (value: string) => (value.match(/\n/g) ?? []).length
  function visit(tokens: Token[], source: string, line: number) {
    let cursor = 0
    for (const token of tokens) {
      const offset = source.indexOf(token.raw, cursor)
      if (offset < 0) continue
      line += newlines(source.slice(cursor, offset))
      if (token.type === 'code') {
        const count = token.raw.replace(/\n+$/, '').split('\n').length
        for (let i = 0; i < count; i++) result.add(line + i)
      } else if (token.type === 'list') {
        visit(token.items, token.raw, line)
      } else if (token.type === 'list_item' || token.type === 'blockquote') {
        // Marked strips container prefixes but preserves their line positions.
        visit(token.tokens ?? [], token.text, line)
      }
      line += newlines(token.raw)
      cursor = offset + token.raw.length
    }
  }
  visit(Lexer.lex(body), body, firstLine)
  return result
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
export function parseTimeline(content: string, uri = '', sourceLines?: Map<string, number>): TimelineDocument | null {
  try {
    const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
    if (!/^---\s*$/.test(lines[0] ?? '')) return null
    const close = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line))
    if (close < 0) return null
    const yaml = parseDocument(lines.slice(1, close).join('\n'), { uniqueKeys: true })
    if (yaml.errors.length) return null
    const meta = yaml.toJS({ maxAliasCount: 50 })
    if (!meta || Array.isArray(meta) || typeof meta.type !== 'string' || meta.type.trim().toLowerCase() !== 'timeline') return null
    const upgraded = Object.prototype.hasOwnProperty.call(meta, 'event_metadata')
    const metadata = new Map<string, TimelineEventMetadata>()
    if (upgraded) {
      if (!record(meta.event_metadata)) return null
      const sources = new Set<string>()
      if (meta.sources !== undefined) {
        if (!Array.isArray(meta.sources)) return null
        for (const source of meta.sources) {
          if (!record(source) || !nonempty(source.id) || sources.has(source.id)) return null
          sources.add(source.id)
        }
      }
      for (const [id, value] of Object.entries(meta.event_metadata)) {
        if (!eventId.test(id) || !validMetadata(value, sources)) return null
        metadata.set(id, value)
      }
    }
    const seenIds = new Set<string>()
    const doc: TimelineDocument = {
      title: typeof meta.title === 'string' ? meta.title : '',
      date: (uri.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\.timeline)?\.md$/i) ?? String(meta.date ?? meta.title ?? '').match(/\b(\d{4}-\d{2}-\d{2})\b/))?.[1] ?? '',
      description: typeof meta.description === 'string' ? meta.description : '',
      items: [], notes: [],
    }
    const stack: { indent: number; item: TimelineItem }[] = []
    const examples = codeLines(lines.slice(close + 1).join('\n'), close + 1)
    for (let i = close + 1; i < lines.length; i++) {
      let line = lines[i]
      if (examples.has(i)) {
        doc.notes.push(line)
        continue
      }
      const binding = line.match(/<!--\s*event:([a-z][a-z0-9_-]*)\s*-->\s*$/)
      if (binding) line = line.slice(0, binding.index).trimEnd()
      // Also reject malformed, repeated and misplaced markers in legacy documents.
      if (/<!--\s*event\b/i.test(line) || (binding && !upgraded)) return null
      if (binding && !/^\s*[-*+]\s/.test(line)) return null
      if (/^#{1,6}\s+.*\d{1,2}:\d{2}/.test(line)) return null
      if (/^#\s+/.test(line)) { if (!doc.title) doc.title = line.replace(/^#\s+/, ''); continue }
      if (!line.trim()) continue
      const match = line.match(/^(\s*)[-*+]\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*[–—~-]\s*(\d{1,2}:\d{2}(?::\d{2})?)\s+[—–-]\s+(.+)$/)
      if (!match) {
        if (binding) return null
        // An unsupported list could contain lost events, so leave it to Markdown.
        if (/^\s*(?:[-*+]\s|\d+[.)]\s|\d{1,2}:\d{2}|\|)/.test(line)) return null
        doc.notes.push(line)
        continue
      }
      const start = minute(match[2]), end = minute(match[3])
      if (start === null || end === null || end < start) return null
      const id = binding?.[1] ?? `line-${i + 1}`
      if (upgraded && (!binding || !metadata.has(id) || seenIds.has(id))) return null
      seenIds.add(id)
      const parsed = inline(match[4])
      const activity = parsed.text.match(/^([^：:]+)[：:]\s*(.*)$/)
      const item: TimelineItem = {
        id, metadata: metadata.get(id) ?? legacyMetadata(), start, end,
        action: activity?.[1].trim() ?? '', text: activity?.[2].trim() ?? parsed.text,
        links: parsed.links, children: [],
      }
      if (!item.text && !item.action) return null
      sourceLines?.set(id, i)
      const indent = match[1].replace(/\t/g, '    ').length
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
      if (indent > 0) {
        const parent = stack[stack.length - 1]?.item
        if (!parent || item.start < parent.start || item.end > parent.end) return null
        parent.children.push(item)
      } else doc.items.push(item)
      stack.push({ indent, item })
    }
    if (metadata.size !== (upgraded ? seenIds.size : 0)) return null
    doc.items.sort((a, b) => a.start - b.start || a.end - b.end)
    doc.title ||= doc.date ? `${doc.date} Timeline` : 'Timeline'
    return doc
  } catch { return null }
}
