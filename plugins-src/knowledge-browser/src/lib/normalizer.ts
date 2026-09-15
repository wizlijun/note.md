import type { DatasetIndexes, Evidence, KnowledgeDataset, KnowledgeKind, KnowledgeRecord, Relation, RoleMap, Source, ViewRecord as CoreViewRecord } from './types'
import { effectiveStatus, recordLabel } from './types'

export const KNOWLEDGE_KINDS: KnowledgeKind[] = ['claims', 'entities', 'concepts', 'events', 'narratives', 'relations']

export interface ViewRecord extends CoreViewRecord {
  key: string
  id: string
  kind: KnowledgeKind
  label: string
  secondary: string
  why: string
  status: string
  importance: 0 | 1
  pointer: string
  order: number
  originalOrder: number
  effectiveStatus: CoreViewRecord['effectiveStatus']
  searchText: string
  raw: KnowledgeRecord
}

export function relationStatement(relation: Relation, indexes: DatasetIndexes): string[] {
  if (relation.text) return [relation.text]
  return (relation.claim ?? []).map(id => indexes.nodesById.get(id)).filter((record): record is KnowledgeRecord => !!record).map(recordLabel)
}

export function roleEntries(args: RoleMap): Array<{ role: string; ref: string }> {
  return Object.entries(args).flatMap(([role, value]) => (Array.isArray(value) ? value : [value]).map(ref => ({ role, ref })))
}

function secondary(record: KnowledgeRecord, kind: KnowledgeKind, indexes: DatasetIndexes): string {
  if (kind === 'relations') {
    const relation = record as Relation
    return `P${relation.p} · ${relation.type}`
  }
  if ('type' in record) return record.type
  if ('kind' in record) return record.kind
  if ('definition' in record) return record.definition
  return ''
}

function oneLevelNames(record: KnowledgeRecord, indexes: DatasetIndexes): string[] {
  const refs: string[] = []
  if ('about' in record) refs.push(...record.about)
  if ('by' in record) refs.push(...record.by)
  if ('args' in record) refs.push(...roleEntries(record.args).map(item => item.ref))
  if ('members' in record) refs.push(...record.members.map(member => member.ref))
  if ('claim' in record) refs.push(...(record.claim ?? []))
  return refs.map(id => indexes.nodesById.get(id)).filter((item): item is KnowledgeRecord => !!item).map(recordLabel)
}

export function buildViewRecords(dataset: KnowledgeDataset, indexes: DatasetIndexes): ViewRecord[] {
  const records: ViewRecord[] = []
  for (const kind of KNOWLEDGE_KINDS) dataset[kind].forEach((record, index) => {
    if ((indexes as DatasetIndexes & { isolatedIds?: Set<string> }).isolatedIds?.has(record.id)) return
    const statements = kind === 'relations' ? relationStatement(record as Relation, indexes) : []
    const label = kind === 'relations' ? statements[0] ?? `${(record as Relation).type} · ${record.id}` : recordLabel(record)
    const text = [record.id, label, secondary(record, kind, indexes), record.why, ...(record.limits ?? []), ...oneLevelNames(record, indexes)]
    if ('definition' in record) text.push(record.definition, ...(record.criteria ?? []), ...(record.excludes ?? []))
    if ('aliases' in record) text.push(...(record.aliases ?? []))
    if ('if' in record) text.push(...(record.if ?? []), ...(record.unless ?? []))
    if ('reason' in record && record.reason) text.push(record.reason)
    if ('thesis' in record) text.push(record.thesis, ...(record.alternatives ?? []))
    const order = indexes.originalOrder.get(record.id) ?? records.length
    const status = effectiveStatus(record)
    records.push({ key: `${dataset.id}#${record.id}`, id: record.id, kind, label, secondary: secondary(record, kind, indexes), why: record.why,
      status, effectiveStatus: status, importance: record.i, pointer: `/${kind}/${index}`, order, originalOrder: order,
      searchText: text.join('\n'), raw: record })
  })
  return records
}

export function sourceLabel(source: Source): string {
  if (source.title) return source.title
  const withoutQuery = source.uri.split(/[?#]/, 1)[0]
  return withoutQuery.split('/').filter(Boolean).at(-1) ?? source.uri
}

export function evidenceLabel(evidence: Evidence, source?: Source): string {
  return `${source ? sourceLabel(source) : evidence.s} · ${evidence.loc}`
}

export function referencedRecordIds(record: KnowledgeRecord): string[] {
  const ids: string[] = []
  if ('about' in record) ids.push(...record.about)
  if ('by' in record) ids.push(...record.by.filter(id => /^[secqvnr]\d+$/.test(id)))
  if ('args' in record) ids.push(...roleEntries(record.args).map(item => item.ref))
  if ('members' in record) ids.push(...record.members.map(item => item.ref))
  if ('claim' in record) ids.push(...(record.claim ?? []))
  return [...new Set(ids)]
}

export function timeMeaning(record: KnowledgeRecord, field: 'event' | 'valid'): { kind: 'not-applicable' | 'unknown' | 'value'; value?: unknown } {
  if (!Object.hasOwn(record, field)) return { kind: 'not-applicable' }
  const value = record[field]
  return value === null ? { kind: 'unknown' } : { kind: 'value', value }
}
