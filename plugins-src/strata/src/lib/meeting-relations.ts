import type { AtlasNode } from './types-terrain'

export interface MapRelation { source: string; target: string; participants?: { nodeId: string; role: string }[] }
export interface RelationGroup { ids: string[]; count: number }

/** Project complete relationships onto the current level, never invent pairwise roles. */
export function meetingRelationGroups(relations: MapRelation[], nodes: Map<string, AtlasNode>, visible: Set<string>, shown: Set<string>, level: 'domain' | 'topic' | 'knowledge', selectedId = ''): RelationGroup[] {
  const groups = new Map<string, RelationGroup>()
  for (const relation of relations) {
    const participants = [...new Set(relation.participants?.length ? relation.participants.map(p => p.nodeId) : [relation.source, relation.target])]
    if (participants.length < 2 || participants.length > 32 || participants.some(id => !visible.has(id) || !nodes.has(id))) continue
    if (level === 'knowledge' && selectedId && !participants.includes(selectedId)) continue
    const ids = [...new Set(participants.map(id => level === 'domain' ? nodes.get(id)!.parentDomain : level === 'topic' ? nodes.get(id)!.parentTopic : id))].sort()
    // Internal cluster relationships stay in the cluster. All endpoints must have
    // a readable label; selected knowledge can additionally expose its own links.
    if (ids.length < 2 || (!(level === 'knowledge' && selectedId) && ids.some(id => !shown.has(id)))) continue
    const key = JSON.stringify(ids), group = groups.get(key)
    if (group) group.count++
    else groups.set(key, { ids, count: 1 })
  }
  const degree = new Map<string, number>(), result: RelationGroup[] = []
  for (const group of [...groups.values()].sort((a, b) => b.count - a.count || JSON.stringify(a.ids).localeCompare(JSON.stringify(b.ids)))) {
    if (result.length >= 12) break
    if ((level !== 'knowledge' || !selectedId) && group.ids.some(id => (degree.get(id) || 0) >= 3)) continue
    result.push(group)
    for (const id of group.ids) degree.set(id, (degree.get(id) || 0) + 1)
  }
  return result
}
