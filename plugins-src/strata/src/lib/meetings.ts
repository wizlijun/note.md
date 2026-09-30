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

/** Already extracted knowledge is imported, never relabelled as verified source text. */
export async function adaptMeetingSnapshot(input: MeetingSnapshotInput, range: DateRange): Promise<MeetingSnapshot> {
  if (input.schema !== 'notemd.strata/meetings/v1' || !Array.isArray(input.documents)) throw new Error('会议知识快照格式不受支持')
  if (!validDate(range.from) || !validDate(range.to) || range.from > range.to) throw new Error('会议日期范围无效')
  const nodes: MeetingKnowledgeNode[] = [], relations: MeetingRelation[] = [], files: Snapshot['files'] = []
  const meetings: MeetingSnapshotMetadata = { datasetKey: input.datasetKey, datasets: 0, missingKnowledge: input.missingKnowledge ?? 0,
    invalidFiles: 0, isolatedRecords: 0, relations: 0, rawRecords: 0, usableRecords: 0, dateExtent: null, diagnostics: [], diagnosticCount: 0 }
  const diagnose = (item: MeetingDiagnostic) => { meetings.diagnosticCount++; if (meetings.diagnostics.length < MAX_DIAGNOSTICS) meetings.diagnostics.push({ code: item.code, message: item.message.slice(0, 512), ...(item.path ? { path: item.path } : {}) }) }
  for (const diagnostic of input.diagnostics ?? []) diagnose(diagnostic)
  const paths = new Set<string>()
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
    for (const view of parsed.records) {
      const record = view.raw
      if (view.kind === 'relations') continue
      const related = referencedRecordIds(record).flatMap(ref => {
        const target = indexes.nodesById.get(ref), kind = indexes.kindById.get(ref)
        return target && (kind === 'concepts' || kind === 'entities') ? [recordLabel(target)] : []
      })
      const features = [...new Set([view.label, ...related].map(feature).filter(Boolean))].slice(0, 24)
      const speakers = 'by' in record ? record.by.map(ref => { const target = indexes.nodesById.get(ref); return target ? recordLabel(target) : ref }).filter(Boolean) : []
      const node: MeetingKnowledgeNode = { id: id(record.id), title: view.label, kind: PEAK_KIND[view.kind], state: 'imported', importance: record.i,
        features, links: referencedRecordIds(record).filter(ref => indexes.nodesById.has(ref) && indexes.kindById.get(ref) !== 'relations').map(id),
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
  meetings.relations = relations.length
  return { schema: 'notemd.strata/snapshot/v1', vaultKey: input.vaultKey, datasetKey: input.datasetKey, snapshotId: input.snapshotId,
    configHash: input.datasetKey, asOf: '', range, nodes, relations, files, meetings, job: null,
    coverage: { indexed: files.length, selected: files.filter(file => within(file.docDate, range)).length, processed: meetings.datasets,
      candidate: 0, excluded: meetings.invalidFiles, stale: 0, proofDeferred: 0, dateInferred: files.filter(file => file.dateInferred).length,
      confidential: 0, unknownConfidentiality: files.filter(file => within(file.docDate, range)).length } }
}
