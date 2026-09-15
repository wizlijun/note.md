import type { KnowledgeDataset, TimeValue, ViewRecord } from './types'

export type TimeDimension = 'event' | 'valid' | 'source' | 'generated'
export type TimeKind = 'point' | 'range' | 'open-range' | 'unknown' | 'not-applicable' | 'unstandardized' | 'invalid-range'
export interface ParsedTime { raw?: TimeValue; kind: TimeKind; start?: number; end?: number; precision?: 'date' | 'timestamp' }
export interface TimelineItem { key: string; dimension: TimeDimension; label: string; ref: string; time: ParsedTime; originalOrder: number }

function validDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3])
}
function point(value: string): { ms: number; precision: 'date' | 'timestamp' } | undefined {
  if (validDateOnly(value)) return { ms: Date.parse(`${value}T00:00:00Z`), precision: 'date' }
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return undefined
  const ms = Date.parse(value); return Number.isNaN(ms) ? undefined : { ms, precision: 'timestamp' }
}

export function parseTimeValue(raw: TimeValue | undefined, present = true): ParsedTime {
  if (!present) return { kind: 'not-applicable' }
  if (raw === null || raw === undefined) return { raw: null, kind: 'unknown' }
  if (typeof raw === 'string') { const parsed = point(raw); return parsed ? { raw, kind: 'point', start: parsed.ms, end: parsed.ms, precision: parsed.precision } : { raw, kind: 'unstandardized' } }
  const left = raw[0] === null ? undefined : point(raw[0]); const right = raw[1] === null ? undefined : point(raw[1])
  if ((raw[0] !== null && !left) || (raw[1] !== null && !right)) return { raw, kind: 'unstandardized' }
  if (left && right && left.ms > right.ms) return { raw, kind: 'invalid-range', start: left.ms, end: right.ms }
  return { raw, kind: left && right ? 'range' : 'open-range', start: left?.ms, end: right?.ms, precision: left?.precision ?? right?.precision }
}

export function timeIntersects(time: ParsedTime, from: number, to: number): boolean {
  if (!['point', 'range', 'open-range'].includes(time.kind)) return false
  return (time.end ?? Number.POSITIVE_INFINITY) >= from && (time.start ?? Number.NEGATIVE_INFINITY) <= to
}

export function buildTimelineItems(dataset: KnowledgeDataset, records: readonly ViewRecord[], dimension: TimeDimension): TimelineItem[] {
  const items: TimelineItem[] = []
  if (dimension === 'generated') items.push({ key: `generated:${dataset.id}`, dimension, label: dataset.scope.purpose, ref: dataset.id, time: parseTimeValue(dataset.generated.at), originalOrder: 0 })
  else if (dimension === 'source') dataset.evidence.forEach((evidence, index) => items.push({ key: `source:${evidence.id}`, dimension, label: evidence.quote ?? `${evidence.s} · ${evidence.loc}`, ref: evidence.id, time: parseTimeValue(evidence.at, 'at' in evidence), originalOrder: index }))
  else records.forEach(view => { const raw = view.raw; const key = dimension as 'event' | 'valid'; items.push({ key: `${dimension}:${view.id}`, dimension, label: view.label, ref: view.id, time: parseTimeValue(raw[key], key in raw), originalOrder: view.originalOrder }) })
  return items.sort((a, b) => {
    const rank = (item: TimelineItem) => item.time.start ?? (item.time.kind === 'open-range' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY)
    return rank(a) - rank(b) || a.originalOrder - b.originalOrder
  })
}
