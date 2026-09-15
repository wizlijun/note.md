import type { DatasetIndexes, KnowledgeKind, ViewRecord } from './types'

export interface QueryOptions {
  query?: string; datasetId?: string; kinds?: ReadonlySet<KnowledgeKind>; importance?: ReadonlySet<0 | 1>
  priorities?: ReadonlySet<0 | 1 | 2 | 3>; statuses?: ReadonlySet<string>; sourceIds?: ReadonlySet<string>
  includeSavedQuotes?: boolean; sort?: 'relevance' | 'importance' | 'original'; indexes?: DatasetIndexes
}
export interface QueryMatch { record: ViewRecord; score: number; matchedIn: string[] }

export function normalizeSearchText(value: string): string { return value.normalize('NFKC').toLocaleLowerCase() }

export function tokenizeQuery(query: string): string[] {
  const tokens: string[] = []; const pattern = /"([^"]+)"|(\S+)/g; let match: RegExpExecArray | null
  while ((match = pattern.exec(query)) !== null) { const token = normalizeSearchText(match[1] ?? match[2]); if (token) tokens.push(token) }
  return tokens
}

function ownFields(view: ViewRecord): Array<{ name: string; value: string }> {
  const record = view.raw; const fields: Array<{ name: string; value: string }> = [{ name: 'id', value: view.id }, { name: 'label', value: view.label }, { name: 'why', value: record.why }]
  const add = (name: string, value: unknown) => {
    if (typeof value === 'string') fields.push({ name, value })
    else if (Array.isArray(value)) value.forEach(item => { if (typeof item === 'string') fields.push({ name, value: item }) })
  }
  for (const key of ['name','term','text','title','definition','thesis','desc','aliases','criteria','excludes','if','unless','reason','limits','alternatives'] as const) add(key, (record as unknown as Record<string, unknown>)[key])
  if ('args' in record) Object.keys(record.args).forEach(role => fields.push({ name: 'role', value: role }))
  if ('members' in record) record.members.forEach(member => fields.push({ name: 'role', value: member.role }))
  return fields
}

function expandedFields(view: ViewRecord, options: QueryOptions): Array<{ name: string; value: string }> {
  const fields = ownFields(view); const indexes = options.indexes; if (!indexes) return fields
  const record = view.raw; const direct = new Set<string>()
  if ('args' in record) Object.values(record.args).flatMap(value => Array.isArray(value) ? value : [value]).forEach(ref => direct.add(ref))
  if ('about' in record) record.about.forEach(ref => direct.add(ref))
  if ('by' in record) record.by.filter(ref => indexes.nodesById.has(ref) || indexes.sourcesById.has(ref)).forEach(ref => direct.add(ref))
  for (const ref of direct) { const target = indexes.nodesById.get(ref); const source = indexes.sourcesById.get(ref); if (target) fields.push({ name: 'participant', value: target && ('name' in target ? target.name : 'term' in target ? target.term : 'title' in target ? target.title : 'text' in target ? target.text ?? target.id : target.id) }); else if (source) fields.push({ name: 'participant', value: source.title ?? source.uri }) }
  if ('claim' in record && !record.text) record.claim?.forEach(ref => { const claim = indexes.nodesById.get(ref); if (claim && 'text' in claim && claim.text) fields.push({ name: 'claim', value: claim.text }) })
  if (options.includeSavedQuotes) for (const ev of record.ev) { const quote = indexes.evidenceById.get(ev)?.quote; if (quote) fields.push({ name: 'evidence', value: quote }) }
  return fields
}

export function queryRecords(records: readonly ViewRecord[], options: QueryOptions = {}): QueryMatch[] {
  const rawQuery = normalizeSearchText((options.query ?? '').trim())
  const knowledgeRef = /^(ks_[0-9a-f-]+)#([ecqvnr][1-9]\d*)$/.exec(rawQuery)
  if (knowledgeRef && options.datasetId && normalizeSearchText(options.datasetId) !== knowledgeRef[1]) return []
  const tokens = knowledgeRef ? [knowledgeRef[2]] : tokenizeQuery(options.query ?? '')
  const matches: QueryMatch[] = []
  for (const view of records) {
    const record = view.raw
    if (options.kinds?.size && !options.kinds.has(view.kind)) continue
    if (options.importance?.size && !options.importance.has(record.i)) continue
    if (options.priorities?.size && (!('p' in record) || !options.priorities.has(record.p))) continue
    if (options.statuses?.size && !options.statuses.has(view.effectiveStatus)) continue
    if (options.sourceIds?.size) {
      const sources = new Set<string>(record.ev.map(id => options.indexes?.evidenceById.get(id)?.s).filter((source): source is NonNullable<typeof source> => !!source))
      if (![...options.sourceIds].some(source => sources.has(source))) continue
    }
    const fields = expandedFields(view, options).map(field => ({ ...field, normalized: normalizeSearchText(field.value) }))
    if (tokens.some(token => !fields.some(field => field.normalized.includes(token)))) continue
    const matchedIn = [...new Set(fields.filter(field => tokens.some(token => field.normalized.includes(token))).map(field => field.name))]
    const idQuery = rawQuery.includes('#') ? rawQuery.slice(rawQuery.lastIndexOf('#') + 1) : rawQuery
    let score = tokens.length ? 10 : 0
    const label = normalizeSearchText(view.label)
    if (idQuery === normalizeSearchText(view.id) && (!rawQuery.includes('#') || !options.datasetId || rawQuery === normalizeSearchText(`${options.datasetId}#${view.id}`))) score += 1000
    else if (rawQuery && label === rawQuery) score += 500
    else if (rawQuery && label.includes(rawQuery)) score += 200
    score += record.i === 0 ? 10 : 0
    matches.push({ record: view, score, matchedIn })
  }
  const sort = options.sort ?? (tokens.length ? 'relevance' : 'importance')
  return matches.sort((a, b) => sort === 'original' ? a.record.originalOrder - b.record.originalOrder : sort === 'importance' ? a.record.raw.i - b.record.raw.i || a.record.originalOrder - b.record.originalOrder : b.score - a.score || a.record.raw.i - b.record.raw.i || a.record.originalOrder - b.record.originalOrder)
}
