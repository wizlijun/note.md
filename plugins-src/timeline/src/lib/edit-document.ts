import { Lexer, type Token } from 'marked'
import { isAlias, isMap, parseDocument, stringify, visit } from 'yaml'
import { parseTimeline, type TimelineAnomaly, type TimelineImportance, type TimelineItem } from './parser'

export interface EventEdit {
  start: string
  end: string
  title: string
  text: string
  importance: TimelineImportance
  anomaly?: TimelineAnomaly['status']
}

const eventLine = /^(\s*[-*+]\s+)(\d{1,2}:\d{2}(?::\d{2})?)(\s*[–—~-]\s*)(\d{1,2}:\d{2}(?::\d{2})?)(\s+[—–-]\s+)(.+)$/
const flatten = (items: TimelineItem[]): TimelineItem[] => items.flatMap(item => [item, ...flatten(item.children)])
const escapeText = (text: string) => text.replace(/([\\`*_[\]{}<>!#|~])/g, '\\$1')

function time(value: string): number {
  if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error('请输入 HH:mm 或 HH:mm:ss 格式的时间。')
  const [h, m, s = 0] = value.split(':').map(Number)
  if (h > 24 || m > 59 || s > 59 || (h === 24 && (m || s))) throw new Error('时间必须在 00:00 至 24:00 之间。')
  return h * 60 + m + s / 60
}

interface LinkSpan { start: number; end: number; raw: string }
function sourceLinks(source: string): LinkSpan[] {
  const result: LinkSpan[] = []
  function visit(tokens: Token[], parent: string, base: number) {
    let cursor = 0
    for (const token of tokens) {
      const start = parent.indexOf(token.raw, cursor)
      if (start < 0) continue
      if (token.type === 'link' && token.raw.startsWith('[')) {
        result.push({ start: base + start, end: base + start + token.raw.length, raw: token.raw })
      } else if ('tokens' in token && Array.isArray(token.tokens)) {
        visit(token.tokens, token.raw, base + start)
      }
      cursor = start + token.raw.length
    }
  }
  visit(Lexer.lexInline(source), source, 0)
  return result
}

function plain(source: string): string {
  function text(tokens: Token[]): string {
    return tokens.map(token => {
      if (token.type === 'link' && token.raw.startsWith('[')) return ''
      if ('tokens' in token && Array.isArray(token.tokens)) return text(token.tokens)
      return 'text' in token && typeof token.text === 'string' ? token.text : token.raw
    }).join('')
  }
  return text(Lexer.lexInline(source)).trim()
}

function editBody(source: string, item: TimelineItem, title: string, text: string): string {
  if (title === item.action && text === item.text) return source
  const links = sourceLinks(source)
  const withLinks = (value: string, spans: LinkSpan[]) => [value, ...spans.map(link => link.raw)].filter(Boolean).join(' ')
  const canonical = () => withLinks(`${title ? `${escapeText(title)}：` : ''}${escapeText(text)}`, links)
  // Preserve the unedited half, including its formatting and exact source links.
  let separator = -1
  for (let index = 0; index < source.length; index++) {
    if (/[：:]/.test(source[index]) && !links.some(link => index >= link.start && index < link.end)) { separator = index; break }
  }
  let result: string
  if (item.action && separator >= 0 && title) {
    const leftLinks = links.filter(link => link.end <= separator)
    const rightLinks = links.filter(link => link.start > separator)
    const left = title === item.action ? source.slice(0, separator) : withLinks(escapeText(title), leftLinks)
    const right = text === item.text ? source.slice(separator + 1) : withLinks(escapeText(text), rightLinks)
    result = left + source[separator] + right
  } else result = canonical()
  const rendered = plain(result)
  const activity = rendered.match(/^([^：:]+)[：:]\s*(.*)$/)
  // A Markdown wrapper may span both fields; normalize that wrapper together.
  if ((activity?.[1].trim() ?? '') !== title || (activity?.[2].trim() ?? rendered) !== text) result = canonical()
  return result
}

/** Apply a single event edit without reserializing unrelated Markdown/frontmatter. */
export function editTimelineEvent(content: string, id: string, edit: EventEdit): string {
  const sourceLines = new Map<string, number>()
  const document = parseTimeline(content, '', sourceLines)
  if (!document) throw new Error('当前文件不再是有效的时间轴，请重新打开后再编辑。')
  const items = flatten(document.items)
  const item = items.find(candidate => candidate.id === id)
  const lineIndex = sourceLines.get(id)
  if (!item || lineIndex === undefined) throw new Error('此活动已变更或删除，请重新选择。')
  if (typeof edit.title !== 'string' || typeof edit.text !== 'string' || /[\u0000-\u001f\u007f]/.test(edit.title + edit.text)) throw new Error('活动名称和描述必须是单行文字。')
  const title = edit.title.trim(), text = edit.text.trim()
  if (!title && !text) throw new Error('活动名称和描述至少填写一项。')
  if (/[：:]/.test(title)) throw new Error('活动名称不能包含冒号，请将详细内容填写在描述中。')
  if (!title && /[：:]/.test(text)) throw new Error('描述含有冒号时，请同时填写活动名称。')
  if (!['high', 'normal', 'unknown'].includes(edit.importance)) throw new Error('请选择有效的重要程度。')
  if (edit.anomaly !== undefined && !['flagged', 'none', 'unknown'].includes(edit.anomaly)) throw new Error('请选择有效的反常状态。')
  const importanceChanged = edit.importance !== item.metadata.importance
  const anomalyChanged = edit.anomaly !== undefined && edit.anomaly !== (item.metadata.anomaly?.status ?? 'unknown')
  const start = time(edit.start), end = time(edit.end)
  if (end < start) throw new Error('结束时间不能早于开始时间。')

  const parts = content.split(/(\r\n|\r|\n)/)
  const originalLine = parts[lineIndex * 2]
  const marker = originalLine.match(/\s*<!--\s*event:[a-z][a-z0-9_-]*\s*-->\s*$/)?.[0] ?? ''
  const raw = marker ? originalLine.slice(0, -marker.length) : originalLine
  const match = raw.match(eventLine)
  if (!match) throw new Error('活动源码发生变化，请重新选择。')
  const body = editBody(match[6], item, title, text)
  parts[lineIndex * 2] = match[1] + (start === item.start ? match[2] : edit.start) + match[3] + (end === item.end ? match[4] : edit.end) + match[5] + body + marker

  if (importanceChanged || anomalyChanged) {
    const close = parts.findIndex((value, index) => index > 0 && index % 2 === 0 && /^---\s*$/.test(value))
    const yamlSource = parts.slice(2, close).join('')
    const yaml = parseDocument(yamlSource, { uniqueKeys: true })
    const originalNode = yaml.get('event_metadata', true)
    const newline = parts[1] || '\n'
    let nextYaml: string
    if (isMap(originalNode) && originalNode.range) {
      if (importanceChanged) {
        yaml.setIn(['event_metadata', id, 'importance'], edit.importance)
        yaml.setIn(['event_metadata', id, 'importance_origin'], 'manual')
        yaml.setIn(['event_metadata', id, 'reason'], '用户手动设置重要程度。')
      }
      if (anomalyChanged) {
        const path = ['event_metadata', id, 'anomaly']
        const node = yaml.getIn(path, true)
        if (isAlias(node)) {
          const resolved = node.resolve(yaml)
          if (!isMap(resolved)) throw new Error('无法更新反常元数据。')
          const copy = resolved.clone()
          copy.anchor = undefined
          yaml.setIn(path, copy)
        } else if (isMap(node) && node.anchor) {
          // Retain independent judgments that previously shared this YAML anchor.
          visit(yaml, { Alias(_key, alias) {
            if (alias.resolve(yaml) !== node) return
            const copy = yaml.createNode(item.metadata.anomaly)
            copy.comment = alias.comment
            return copy
          } })
        } else if (!node) yaml.setIn(path, yaml.createNode({ evidence: [] }))
        yaml.setIn([...path, 'status'], edit.anomaly)
        yaml.setIn([...path, 'origin'], 'manual')
        yaml.setIn([...path, 'reason'], '用户手动设置反常标签。')
      }
      const serialized = String(yaml)
      const nextNode = parseDocument(serialized).get('event_metadata', true)
      if (!isMap(nextNode) || !nextNode.range) throw new Error('无法更新事件判断元数据。')
      const replacement = serialized.slice(nextNode.range[0], nextNode.range[1]).replace(/\n/g, newline)
      nextYaml = yamlSource.slice(0, originalNode.range[0]) + replacement + yamlSource.slice(originalNode.range[1])
    } else {
      const metadata = Object.fromEntries(items.map(value => [value.id, {
        ...value.metadata,
        reason: '此活动尚未评定重要程度。',
        ...(value.id === id && importanceChanged ? { importance: edit.importance, importance_origin: 'manual', reason: '用户手动设置重要程度。' } : {}),
        ...(value.id === id && anomalyChanged ? { anomaly: { status: edit.anomaly, origin: 'manual', reason: '用户手动设置反常标签。', evidence: [] } } : {}),
      }]))
      nextYaml = yamlSource + stringify({ event_metadata: metadata }).replace(/\n/g, newline)
      for (const [eventId, index] of sourceLines) {
        parts[index * 2] = parts[index * 2].replace(/\s*$/, trailing => ` <!-- event:${eventId} -->${trailing}`)
      }
    }
    parts.splice(2, close - 2, nextYaml)
  }

  const result = parts.join('')
  const updated = parseTimeline(result)
  const edited = updated && flatten(updated.items).find(candidate => candidate.id === id)
  if (!updated || !edited || edited.start !== start || edited.end !== end || edited.action !== title || edited.text !== text || edited.metadata.importance !== edit.importance || (edit.anomaly !== undefined && (edited.metadata.anomaly?.status ?? 'unknown') !== edit.anomaly)) {
    throw new Error('修改后的时间轴无效；子活动必须位于父活动的时间范围内，请检查时间和文字。')
  }
  return result
}
