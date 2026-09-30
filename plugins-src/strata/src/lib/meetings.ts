import { parseKnowledgeDataset } from '../../../knowledge-browser/src/lib/parser'
import { relationParticipants } from '../../../knowledge-browser/src/lib/indexes'
import { referencedRecordIds } from '../../../knowledge-browser/src/lib/normalizer'
import { recordLabel } from '../../../knowledge-browser/src/lib/types'
import type { DatasetScope, Evidence as SavedEvidence, GeneratedInfo, KnowledgeKind, KnowledgeRecord, Selection, Source } from '../../../knowledge-browser/src/lib/types'
import type { DateRange, KnowledgeNode, Relation, Snapshot } from './types'

export interface MeetingDiagnostic { code: string; message: string; path?: string }
export interface MeetingDocument { path: string; contentHash: string; content: string; date: string | null; dateInferred: boolean }
export interface MeetingSnapshotInput {
  schema: 'notemd.strata/meetings/v1'; vaultKey: string; datasetKey: string; snapshotId: string
  documents: MeetingDocument[]; diagnostics: MeetingDiagnostic[]; missingKnowledge?: number
}
export interface MeetingEvidence {
  id: string; loc: string; quote?: string; at?: SavedEvidence['at']; role?: SavedEvidence['role']
  speaker?: { id: string; name: string }; source: Source
}
export interface MeetingNodeMetadata {
  datasetPath: string; contentHash: string; datasetId: string; localId: string; kind: KnowledgeKind
  record: KnowledgeRecord; generated: GeneratedInfo; selection?: Selection; scope: DatasetScope
  evidence: MeetingEvidence[]; references: { localId: string; nodeId?: string; label: string; kind?: KnowledgeKind }[]
}
export interface MeetingSnapshotMetadata {
  datasetKey: string; datasets: number; missingKnowledge: number; invalidFiles: number; isolatedRecords: number
  relations: number; rawRecords: number; usableRecords: number; dateExtent: DateRange | null
  diagnostics: MeetingDiagnostic[]; diagnosticCount: number
}
export interface MeetingKnowledgeNode extends Omit<KnowledgeNode, 'state'> {
  state: 'imported'; importance: 0 | 1; meeting: MeetingNodeMetadata
  topicTerms: string[]; topicSourceId: string
}
export interface MeetingRelation extends Relation {
  participants: { nodeId: string; role: string }[]; meeting: MeetingNodeMetadata
}
export interface MeetingSnapshot extends Omit<Snapshot, 'nodes' | 'relations'> {
  datasetKey: string; nodes: MeetingKnowledgeNode[]; relations: MeetingRelation[]; meetings: MeetingSnapshotMetadata
}

const MAX_DIAGNOSTICS = 80, MAX_RECORDS = 100_000
const KINDS: KnowledgeKind[] = ['entities', 'concepts', 'claims', 'events', 'narratives', 'relations']
const PEAK_KIND: Record<KnowledgeKind, string> = { entities: 'entity', concepts: 'concept', claims: 'claim', events: 'event', narratives: 'narrative', relations: 'relation' }
const hash = async (text: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
const validDate = (date: string | null): date is string => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T12:00:00Z')) && new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) === date
const within = (date: string | null, range: DateRange) => date !== null && date >= range.from && date <= range.to
const feature = (value: string) => Array.from(value.trim()).slice(0, 96).join('')
const termKey = (value: string) => value.normalize('NFKC').trim().toLowerCase()
/** Attribution is retained in metadata, but is not a semantic relationship. */
function semanticReferences(record: KnowledgeRecord): string[] {
  const refs: string[] = []
  if ('about' in record) refs.push(...record.about)
  if ('args' in record) refs.push(...Object.values(record.args).flat())
  if ('members' in record) refs.push(...record.members.map(member => member.ref))
  if ('claim' in record) refs.push(...(record.claim ?? []))
  return [...new Set(refs)]
}

/** Already extracted knowledge is imported, never relabelled as verified source text. */
export async function adaptMeetingSnapshot(input: MeetingSnapshotInput, range: DateRange): Promise<MeetingSnapshot> {
  if (input.schema !== 'notemd.strata/meetings/v1' || !Array.isArray(input.documents)) throw new Error('会议知识快照格式不受支持')
  if (!validDate(range.from) || !validDate(range.to) || range.from > range.to) throw new Error('会议日期范围无效')
  const nodes: MeetingKnowledgeNode[] = [], relations: MeetingRelation[] = [], files: Snapshot['files'] = []
  const meetings: MeetingSnapshotMetadata = { datasetKey: input.datasetKey, datasets: 0, missingKnowledge: input.missingKnowledge ?? 0,
    invalidFiles: 0, isolatedRecords: 0, relations: 0, rawRecords: 0, usableRecords: 0, dateExtent: null, diagnostics: [], diagnosticCount: 0 }
  const diagnose = (item: MeetingDiagnostic) => { meetings.diagnosticCount++; if (meetings.diagnostics.length < MAX_DIAGNOSTICS) meetings.diagnostics.push({ code: item.code, message: item.message.slice(0, 512), ...(item.path ? { path: item.path } : {}) }) }
  for (const diagnostic of input.diagnostics ?? []) diagnose(diagnostic)
  const paths = new Set<string>(), batchPersonNames = new Set<string>()
  for (const document of input.documents) {
    if (paths.has(document.path)) throw new Error('会议知识快照包含重复文件')
    paths.add(document.path)
    const parsed = await parseKnowledgeDataset(document.content, document.path)
    if (parsed.snapshotHash !== document.contentHash) { meetings.invalidFiles++; diagnose({ code: 'snapshot.hash', path: document.path, message: '知识文件与本次快照的内容摘要不一致，已跳过。' }); continue }
    for (const diagnostic of parsed.diagnostics) diagnose({ code: diagnostic.code, message: diagnostic.message, path: document.path })
    if (parsed.fatal || !parsed.dataset || !parsed.indexes) { meetings.invalidFiles++; continue }
    const dataset = parsed.dataset, indexes = parsed.indexes, prefix = 'meeting:' + await hash(document.path) + ':'
    const id = (localId: string) => prefix + localId
    const date = validDate(document.date) ? document.date : null
    if (!date) diagnose({ code: 'meeting.date', path: document.path, message: '会议日期未知，不会用抽取时间代替会议发生日期。' })
    else meetings.dateExtent = meetings.dateExtent ? { from: date < meetings.dateExtent.from ? date : meetings.dateExtent.from, to: date > meetings.dateExtent.to ? date : meetings.dateExtent.to } : { from: date, to: date }
    meetings.datasets++; meetings.isolatedRecords += indexes.isolatedIds?.size ?? 0
    meetings.rawRecords += KINDS.reduce((sum, kind) => sum + dataset[kind].length, 0)
    meetings.usableRecords += parsed.records.length
    if (meetings.rawRecords > MAX_RECORDS) throw new Error('会议知识超过 100,000 条记录预算，请缩小会议目录范围')
    // Many records cite the same utterance and entity. Structured clone preserves
    // these shared objects; rebuilding them per peak needlessly multiplies memory.
    const evidencePool = new Map<string, MeetingEvidence>()
    const referencePool = new Map<string, MeetingNodeMetadata['references'][number]>()
    const savedEvidence = (evidenceId: string): MeetingEvidence[] => {
      const cached = evidencePool.get(evidenceId); if (cached) return [cached]
      const evidence = indexes.evidenceById.get(evidenceId), source = evidence && indexes.sourcesById.get(evidence.s)
      if (!evidence || !source) return []
      const speaker = evidence.speaker && indexes.nodesById.get(evidence.speaker)
      const result: MeetingEvidence = { id: evidence.id, loc: evidence.loc, ...(evidence.quote === undefined ? {} : { quote: evidence.quote }),
        ...(evidence.at === undefined ? {} : { at: evidence.at }), ...(evidence.role ? { role: evidence.role } : {}),
        ...(evidence.speaker ? { speaker: { id: evidence.speaker, name: speaker ? recordLabel(speaker) : evidence.speaker + '（不可用）' } } : {}), source }
      evidencePool.set(evidenceId, result); return [result]
    }
    const reference = (localId: string): MeetingNodeMetadata['references'][number] => {
      const cached = referencePool.get(localId); if (cached) return cached
      const target = indexes.nodesById.get(localId), source = indexes.sourcesById.get(localId as `s${number}`)
      const result = { localId, ...(target ? { nodeId: id(localId), kind: indexes.kindById.get(localId) } : {}), label: target ? recordLabel(target) : source?.title || localId }
      referencePool.set(localId, result); return result
    }
    const metadata = (record: KnowledgeRecord, kind: KnowledgeKind): MeetingNodeMetadata => ({
      datasetPath: document.path, contentHash: document.contentHash, datasetId: dataset.id, localId: record.id,
      kind, record, generated: dataset.generated, selection: dataset.selection, scope: dataset.scope,
      evidence: record.ev.flatMap(savedEvidence), references: referencedRecordIds(record).map(reference),
    })
    const fileKey = prefix.slice(0, -1)
    files.push({ fileKey, path: document.path, contentHash: document.contentHash, title: dataset.scope.purpose, tags: [], docDate: date,
      dateInferred: document.dateInferred, indexOrigin: 'derived', humanVerified: false, attentionMinutes: 0,
      filePriority: 1, confidentiality: 'unknown', links: [] })
    const localNodes = new Map<string, MeetingKnowledgeNode>()
    const personTerms = new Set<string>(), personNames = new Set<string>()
    for (const record of indexes.nodesById.values()) if ('name' in record && record.type === 'person') {
      personTerms.add(termKey(record.id))
      for (const name of [record.name, ...(record.aliases ?? [])]) {
        const key = termKey(name)
        if (key) { personTerms.add(key); personNames.add(key); batchPersonNames.add(key) }
      }
    }
    for (const evidence of indexes.evidenceById.values()) if (evidence.speaker) personTerms.add(termKey(evidence.speaker))
    const boundedTerms = (values: string[]): string[] => {
      const seen = new Set<string>(), terms: string[] = []
      for (const value of values) {
        const term = value.trim(), key = termKey(term)
        // Keep complete original terms. A concept mentioning a person remains
        // a concept; only an exact known person name/alias/ID is ineligible.
        if (!key || personTerms.has(key) || seen.has(key) || Array.from(term).length > 96) continue
        seen.add(key); terms.push(term)
        if (terms.length === 24) break
      }
      return terms
    }
    const namedTerms = new Map<string, string[]>()
    for (const record of indexes.nodesById.values()) {
      if ('term' in record) namedTerms.set(record.id, boundedTerms([record.term, ...(record.aliases ?? [])]))
      else if ('name' in record && record.type !== 'person') namedTerms.set(record.id, boundedTerms([record.name, ...(record.aliases ?? [])]))
    }
    const namesByLength = [...personNames].sort((a, b) => b.length - a.length || a.localeCompare(b)).map(name => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // CJK names occur without spaces; Latin names must not erase a substring
      // of an unrelated word (for example Al in algorithm).
      return /\p{Script=Han}/u.test(name) ? new RegExp(escaped, 'gu') : new RegExp('(?<![\\p{L}\\p{N}_])' + escaped + '(?![\\p{L}\\p{N}_])', 'gu')
    })
    const impersonalText = (value: string): string => {
      let text = termKey(value)
      for (const name of namesByLength) text = text.replace(name, ' ')
      return feature(text)
    }
    for (const view of parsed.records) {
      const record = view.raw
      if (view.kind === 'relations') continue
      const semanticRefs = semanticReferences(record)
      const person = 'name' in record && record.type === 'person'
      const topicTerms = person ? [] : boundedTerms([...(namedTerms.get(record.id) ?? []), ...semanticRefs.flatMap(ref => namedTerms.get(ref) ?? [])])
      // Complete source terms support readable labels. Longer statements remain
      // lexical features only, with explicit local person names removed.
      const lexicalTitle = view.kind === 'concepts' || view.kind === 'entities' ? '' : impersonalText(view.label)
      const features = person ? [] : [...new Set([...topicTerms, lexicalTitle].filter(Boolean))].slice(0, 24)
      const speakers = 'by' in record ? record.by.map(ref => { const target = indexes.nodesById.get(ref); return target ? recordLabel(target) : ref }).filter(Boolean) : []
      const node: MeetingKnowledgeNode = { id: id(record.id), title: view.label, kind: PEAK_KIND[view.kind], state: 'imported', importance: record.i,
        features, topicTerms, topicSourceId: fileKey, links: semanticRefs.filter(ref => indexes.nodesById.has(ref) && indexes.kindById.get(ref) !== 'relations').map(id),
        ownerSpecificity: 'unknown', confidentiality: 'unknown', classificationReason: '已导入会议知识；尚未核对当前原文，不推断个人独有性或保密性。',
        speaker: speakers.length ? speakers.join('、') : null, conditions: 'if' in record ? [...(record.if ?? [])] : [], limits: [...(record.limits ?? [])],
        epistemic: record.epistemic?.strength ?? 'unknown', evidence: [], meeting: metadata(record, view.kind),
        // A knowledge-object contribution, not an independent-source or meeting count.
        sourceGroups: [{ groupId: id(record.id), groupVersion: document.contentHash, priority: record.i === 0 ? 2 : 1, dates: date ? [date] : [], canonicalIds: [id(record.id)] }] }
      nodes.push(node); localNodes.set(record.id, node)
    }
    for (const record of dataset.relations) {
      if (!indexes.nodesById.has(record.id)) continue
      const participants = relationParticipants(record).filter(({ ref }) => indexes.nodesById.has(ref) || indexes.sourcesById.has(ref as `s${number}`)).map(({ ref, role }) => ({ nodeId: id(ref), role }))
      const peakIds = [...new Set(participants.filter(participant => localNodes.has(participant.nodeId.slice(prefix.length))).map(participant => participant.nodeId))]
      const statements = (record.claim ?? []).flatMap(ref => { const claim = indexes.nodesById.get(ref); return claim ? [recordLabel(claim)] : [] })
      relations.push({ id: id(record.id), source: peakIds[0] ?? '', target: peakIds[1] ?? '', type: record.type,
        title: record.text || statements[0] || record.type, participants, evidence: [], meeting: metadata(record, 'relations') })
      // Star adjacency is only a bounded clustering hint. The relation keeps every named role.
      for (const peakId of peakIds.slice(1)) {
        localNodes.get(peakIds[0].slice(prefix.length))?.links.push(peakId)
        localNodes.get(peakId.slice(prefix.length))?.links.push(peakIds[0])
      }
    }
    for (const node of localNodes.values()) node.links = [...new Set(node.links)].filter(link => link !== node.id).slice(0, 64)
    // parsed.sourceText/raw/dataset are not retained in the returned snapshot.
  }
  // Classification can differ across meetings. Conservatively withhold an
  // exact explicitly declared person name from naming/lexical candidates; this
  // does not resolve identities or change any record, type, relation or source.
  for (const node of nodes) {
    node.topicTerms = node.topicTerms.filter(term => !batchPersonNames.has(termKey(term)))
    node.features = node.features.filter(term => !batchPersonNames.has(termKey(term)))
  }
  meetings.relations = relations.length
  return { schema: 'notemd.strata/snapshot/v1', vaultKey: input.vaultKey, datasetKey: input.datasetKey, snapshotId: input.snapshotId,
    configHash: input.datasetKey, asOf: '', range, nodes, relations, files, meetings, job: null,
    coverage: { indexed: files.length, selected: files.filter(file => within(file.docDate, range)).length, processed: meetings.datasets,
      candidate: 0, excluded: meetings.invalidFiles, stale: 0, proofDeferred: 0, dateInferred: files.filter(file => file.dateInferred).length,
      confidential: 0, unknownConfidentiality: files.filter(file => within(file.docDate, range)).length } }
}
