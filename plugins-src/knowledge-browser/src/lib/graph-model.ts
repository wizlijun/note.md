import { relationParticipants } from './indexes'
import { roleEntries } from './normalizer'
import { recordLabel } from './types'
import type { DatasetIndexes, KnowledgeDataset, KnowledgeKind, KnowledgeRecord } from './types'

export type GraphScope = 'all' | 'focus'
export type GraphEdgeLayer = 'relation' | 'reference'

export interface KnowledgeGraphNode {
  id: string
  kind: KnowledgeKind
  label: string
  subtitle: string
  importance: 0 | 1
  record: KnowledgeRecord
}

export interface KnowledgeGraphEdge {
  id: string
  source: string
  target: string
  label: string
  relationType: string
  layer: GraphEdgeLayer
  priority?: 0 | 1 | 2 | 3
  relationId?: string
}

export interface KnowledgeGraphModel {
  nodes: KnowledgeGraphNode[]
  edges: KnowledgeGraphEdge[]
  relationTypes: string[]
  truncated: { nodes: number; edges: number }
}

export interface KnowledgeGraphOptions {
  scope: GraphScope
  centerId?: string | null
  maxNodes?: number
  maxEdges?: number
}

const COLLECTIONS: KnowledgeKind[] = ['entities', 'concepts', 'claims', 'events', 'narratives', 'relations']

function subtitle(record: KnowledgeRecord, kind: KnowledgeKind): string {
  if (kind === 'relations' && 'p' in record) return `P${record.p} · ${record.type}`
  if ('type' in record) return record.type
  if ('kind' in record) return record.kind
  return kind
}

function graphNodes(dataset: KnowledgeDataset, indexes: DatasetIndexes): KnowledgeGraphNode[] {
  const nodes: KnowledgeGraphNode[] = []
  for (const kind of COLLECTIONS) for (const record of dataset[kind] as KnowledgeRecord[]) {
    if (!indexes.nodesById.has(record.id)) continue
    const label = kind === 'relations' && 'p' in record ? record.type : recordLabel(record)
    nodes.push({ id: record.id, kind, label, subtitle: subtitle(record, kind), importance: record.i, record })
  }
  return nodes.sort((a, b) => (indexes.originalOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (indexes.originalOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
}

function graphEdges(dataset: KnowledgeDataset, indexes: DatasetIndexes): KnowledgeGraphEdge[] {
  const edges: KnowledgeGraphEdge[] = []
  const seen = new Set<string>()
  const add = (edge: Omit<KnowledgeGraphEdge, 'id'>, preserveMissingTarget = false): void => {
    if (!indexes.nodesById.has(edge.source) || (!preserveMissingTarget && !indexes.nodesById.has(edge.target))) return
    const key = `${edge.layer}\u0000${edge.source}\u0000${edge.target}\u0000${edge.relationType}\u0000${edge.label}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ ...edge, id: `g${edges.length + 1}` })
  }

  // Explicit relations remain junction nodes so N-ary roles are never flattened
  // into an invented source/target direction.
  for (const relation of dataset.relations) {
    if (!indexes.nodesById.has(relation.id)) continue
    for (const participant of relationParticipants(relation)) add({
      source: relation.id, target: participant.ref, label: participant.role,
      relationType: relation.type, layer: 'relation', priority: relation.p, relationId: relation.id,
    }, true)
  }

  // Structural references form a second, deliberately dashed layer. They make
  // claims, events and narratives navigable without presenting them as extracted
  // Relation records.
  for (const claim of dataset.claims) {
    claim.about.forEach(target => add({ source: claim.id, target, label: 'about', relationType: 'about', layer: 'reference' }))
    claim.by.forEach(target => add({ source: claim.id, target, label: 'by', relationType: 'claimed_by', layer: 'reference' }))
  }
  for (const event of dataset.events) {
    roleEntries(event.args).forEach(({ role, ref }) => add({ source: event.id, target: ref, label: role, relationType: 'event_participant', layer: 'reference' }))
    event.place?.forEach(target => add({ source: event.id, target, label: 'place', relationType: 'event_place', layer: 'reference' }))
  }
  for (const narrative of dataset.narratives) narrative.members.forEach(member => add({
    source: narrative.id, target: member.ref, label: member.role, relationType: 'narrative_member', layer: 'reference',
  }))
  for (const relation of dataset.relations) relation.claim?.forEach(target => add({
    source: relation.id, target, label: 'claim', relationType: 'relation_claim', layer: 'reference', relationId: relation.id,
  }))

  return edges
}

function focusDepths(centerId: string, edges: readonly KnowledgeGraphEdge[], maxDepth = 2): Map<string, number> {
  const adjacency = new Map<string, Set<string>>()
  for (const edge of edges) {
    const source = adjacency.get(edge.source) ?? new Set<string>(); source.add(edge.target); adjacency.set(edge.source, source)
    const target = adjacency.get(edge.target) ?? new Set<string>(); target.add(edge.source); adjacency.set(edge.target, target)
  }
  const depths = new Map<string, number>([[centerId, 0]])
  let frontier = [centerId]
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = []
    for (const id of frontier) for (const neighbor of adjacency.get(id) ?? []) if (!depths.has(neighbor)) {
      depths.set(neighbor, depth); next.push(neighbor)
    }
    frontier = next
  }
  return depths
}

function limitedNodes(
  candidates: readonly KnowledgeGraphNode[], edges: readonly KnowledgeGraphEdge[], maxNodes: number, maxEdges: number,
  centerId: string | null | undefined,
): { nodes: KnowledgeGraphNode[]; expandedRelationIds: Set<string> } {
  const byId = new Map(candidates.map(node => [node.id, node]))
  const candidateIds = new Set(byId.keys())
  const selected: KnowledgeGraphNode[] = []
  const selectedIds = new Set<string>()
  const expandedRelationIds = new Set<string>()
  let selectedRelationEdges = 0
  const add = (node: KnowledgeGraphNode | undefined): boolean => {
    if (!node || selectedIds.has(node.id) || selected.length >= maxNodes) return false
    selected.push(node); selectedIds.add(node.id); return true
  }

  const relationEdges = edges.filter(edge => edge.layer === 'relation')
  const edgesByRelation = new Map<string, KnowledgeGraphEdge[]>()
  for (const edge of relationEdges) {
    const relationId = edge.relationId ?? edge.source
    const group = edgesByRelation.get(relationId) ?? []
    group.push(edge); edgesByRelation.set(relationId, group)
  }
  const addRelationGroup = (relation: KnowledgeGraphNode): boolean => {
    if (expandedRelationIds.has(relation.id)) return true
    const group = edgesByRelation.get(relation.id) ?? []
    if (group.some(edge => !candidateIds.has(edge.source) || !candidateIds.has(edge.target))) return false
    const groupNodes = [relation, ...group.map(edge => byId.get(edge.target))]
      .filter((node): node is KnowledgeGraphNode => !!node)
      .filter((node, index, nodes) => nodes.findIndex(item => item.id === node.id) === index)
    const newNodeCount = groupNodes.filter(node => !selectedIds.has(node.id)).length
    if (selected.length + newNodeCount > maxNodes || selectedRelationEdges + group.length > maxEdges) return false
    groupNodes.forEach(add)
    expandedRelationIds.add(relation.id)
    selectedRelationEdges += group.length
    return true
  }

  const center = centerId ? byId.get(centerId) : undefined
  if (center?.kind === 'relations') addRelationGroup(center)
  else add(center)
  for (const kind of COLLECTIONS) {
    if (kind !== 'relations') add(candidates.find(node => node.kind === kind))
  }

  const representedTypes = new Set<string>()
  const candidateOrder = new Map(candidates.map((node, index) => [node.id, index]))
  const relations = candidates.filter(node => node.kind === 'relations').sort((a, b) => {
    const priorityA = 'p' in a.record ? a.record.p : 3
    const priorityB = 'p' in b.record ? b.record.p : 3
    return priorityA - priorityB || candidateOrder.get(a.id)! - candidateOrder.get(b.id)!
  })
  for (const relation of relations) {
    if (!('p' in relation.record) || representedTypes.has(relation.record.type)) continue
    if (addRelationGroup(relation)) representedTypes.add(relation.record.type)
  }

  for (const relation of relations) addRelationGroup(relation)
  for (const node of candidates) if (node.kind !== 'relations') add(node)
  return { nodes: selected, expandedRelationIds }
}

function limitedEdges(edges: readonly KnowledgeGraphEdge[], maxEdges: number): KnowledgeGraphEdge[] {
  if (edges.length <= maxEdges) return [...edges]
  const selectedIds = new Set<string>()
  const relationGroups = new Map<string, KnowledgeGraphEdge[]>()
  for (const edge of edges) if (edge.layer === 'relation') {
    const relationId = edge.relationId ?? edge.source
    const group = relationGroups.get(relationId) ?? []
    group.push(edge); relationGroups.set(relationId, group)
  }
  const add = (edge: KnowledgeGraphEdge): void => {
    if (selectedIds.size < maxEdges) selectedIds.add(edge.id)
  }
  const addGroup = (group: readonly KnowledgeGraphEdge[]): boolean => {
    const missing = group.filter(edge => !selectedIds.has(edge.id))
    if (selectedIds.size + missing.length > maxEdges) return false
    missing.forEach(add)
    return true
  }

  const representedTypes = new Set<string>()
  for (const group of relationGroups.values()) {
    const type = group[0]?.relationType
    if (type && !representedTypes.has(type) && addGroup(group)) representedTypes.add(type)
  }
  for (const group of relationGroups.values()) addGroup(group)
  for (const edge of edges) if (edge.layer === 'reference') add(edge)
  return edges.filter(edge => selectedIds.has(edge.id))
}

export function buildKnowledgeGraph(dataset: KnowledgeDataset, indexes: DatasetIndexes, options: KnowledgeGraphOptions): KnowledgeGraphModel {
  const maxNodes = Math.max(1, options.maxNodes ?? 80)
  const maxEdges = Math.max(0, options.maxEdges ?? 120)
  const allNodes = graphNodes(dataset, indexes)
  const allEdges = graphEdges(dataset, indexes)
  const centerExists = !!options.centerId && indexes.nodesById.has(options.centerId)
  const depths = centerExists && (options.scope === 'focus' || allNodes.length > maxNodes)
    ? focusDepths(options.centerId!, allEdges, options.scope === 'focus' ? 2 : Number.MAX_SAFE_INTEGER)
    : null
  const candidates = options.scope === 'focus' && depths
    ? allNodes.filter(node => depths.has(node.id)).sort((a, b) => (depths.get(a.id)! - depths.get(b.id)!) || (indexes.originalOrder.get(a.id)! - indexes.originalOrder.get(b.id)!))
    : depths
      ? [...allNodes].sort((a, b) => (depths.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (depths.get(b.id) ?? Number.MAX_SAFE_INTEGER) || (indexes.originalOrder.get(a.id)! - indexes.originalOrder.get(b.id)!))
      : allNodes
  const limited = limitedNodes(candidates, allEdges, maxNodes, maxEdges, options.centerId)
  const nodes = limited.nodes
  const scopedIds = new Set(candidates.map(node => node.id))
  const visibleIds = new Set(nodes.map(node => node.id))
  const scopedEdges = allEdges.filter(edge => scopedIds.has(edge.source) && scopedIds.has(edge.target))
  const candidateEdges = scopedEdges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)
    && (edge.layer === 'reference' || limited.expandedRelationIds.has(edge.relationId ?? edge.source)))
  const edges = limitedEdges(candidateEdges, maxEdges)
  const relationTypes = [...new Set(edges.filter(edge => edge.layer === 'relation').map(edge => edge.relationType))]

  return {
    nodes,
    edges,
    relationTypes,
    truncated: {
      nodes: Math.max(0, candidates.length - nodes.length),
      edges: Math.max(0, scopedEdges.length - edges.length),
    },
  }
}
