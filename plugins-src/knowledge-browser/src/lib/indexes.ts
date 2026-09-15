import type { DatasetIndexes, KnowledgeDataset, KnowledgeKind, KnowledgeRecord, NodeRef, Relation } from './types'

const COLLECTIONS: KnowledgeKind[] = ['entities', 'concepts', 'claims', 'events', 'narratives', 'relations']
const refs = (map: Record<string, NodeRef | NodeRef[]>): NodeRef[] => Object.values(map).flatMap(value => Array.isArray(value) ? value : [value])

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key)
  if (bucket) bucket.push(value)
  else map.set(key, [value])
}

export function buildIndexes(dataset: KnowledgeDataset, excludedIds: ReadonlySet<string> = new Set()): DatasetIndexes {
  const indexes: DatasetIndexes = {
    nodesById: new Map(), sourcesById: new Map(), evidenceById: new Map(), relationsByParticipant: new Map(),
    recordsByEvidence: new Map(), incomingReferences: new Map(), kindById: new Map(), originalOrder: new Map(), isolatedIds: new Set(excludedIds),
  }
  dataset.sources.forEach(source => indexes.sourcesById.set(source.id, source))
  dataset.evidence.forEach(evidence => indexes.evidenceById.set(evidence.id, evidence))
  let order = 0
  for (const kind of COLLECTIONS) for (const record of dataset[kind] as KnowledgeRecord[]) {
    if (excludedIds.has(record.id)) continue
    indexes.nodesById.set(record.id, record); indexes.kindById.set(record.id, kind); indexes.originalOrder.set(record.id, order++)
    for (const evidenceId of record.ev) append(indexes.recordsByEvidence, evidenceId, record)
  }
  const incoming = (target: string, from: string, field: string) => append(indexes.incomingReferences, target, { from, field })
  for (const claim of dataset.claims) if (!excludedIds.has(claim.id)) { claim.about.forEach(ref => incoming(ref, claim.id, 'about')); claim.by.filter(ref => indexes.nodesById.has(ref) || indexes.sourcesById.has(ref)).forEach(ref => incoming(ref, claim.id, 'by')) }
  for (const event of dataset.events) if (!excludedIds.has(event.id)) { refs(event.args).forEach(ref => incoming(ref, event.id, 'args')); event.place?.forEach(ref => incoming(ref, event.id, 'place')) }
  for (const narrative of dataset.narratives) if (!excludedIds.has(narrative.id)) narrative.members.forEach(member => incoming(member.ref, narrative.id, 'members'))
  for (const relation of dataset.relations) if (!excludedIds.has(relation.id)) {
    for (const participant of refs(relation.args)) { append(indexes.relationsByParticipant, participant, relation); incoming(participant, relation.id, 'args') }
    relation.claim?.forEach(claim => incoming(claim, relation.id, 'claim'))
  }
  return indexes
}

export function relationParticipants(relation: Relation): Array<{ role: string; ref: NodeRef }> {
  return Object.entries(relation.args).flatMap(([role, value]) => (Array.isArray(value) ? value : [value]).map(ref => ({ role, ref })))
}
