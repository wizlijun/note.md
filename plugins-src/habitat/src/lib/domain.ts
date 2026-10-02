import type { Edge, Locator, Node, Snapshot } from './types'

export const typeLabels: Record<string, string> = { keyword: '关键词', concept: '概念', project: '项目', topic: '主题', entity: '实体', claim: '主张', event: '事件', narrative: '叙事', person: '人物', system: '系统', organization: '组织', document: '文档', wiki: '命名锚点' }
export const statusLabels: Record<string, string> = { statistical: '统计关联', candidate: '候选', anchor: '命名锚点', observed: '明确记录', imported: 'AI 提取候选', 'user-confirmed': '用户已确认', confirmed: '已确认', disputed: '有分歧', contested: '有分歧', superseded: '已替代', 'source-unavailable': '来源不可用', unavailable: '来源不可用', unresolved: '待辨认', matched: '版本已核对', verified: '已核对', unknown: '未知', agent: 'AI 生成', human: '用户记录', quoted: '引用', derived: '派生材料', provisional: '暂定', summary: '摘要', source: '来源', primary: '主要归属', secondary: '关联归属' }
const edgeLabels: Record<string, string> = { co_occurs: '统计共现', explicit_reference: '明确引用', wikilink: '知识链接', tagged_with: '标签关联', co_mentioned_in: '同处讨论', lexically_similar: '词汇邻近' }
export function edgeLabel(value: string) { return edgeLabels[value] ?? value }
export const causeLabels: Record<string, string> = { baseline: '首次建立', structure: '结构变化', coverage: '覆盖变化', content: '内容变化', evidence: '证据更新', algorithm: '算法变化', algorithm_change: '算法变化', scope: '分析范围变化', mixed: '多种变化', initial: '首次建立', restore: '恢复旧版', layout: '布局变化' }
export function typeLabel(value: string) { return typeLabels[value] ?? value }
export function statusLabel(value: string) { return statusLabels[value] ?? value }
export function causeLabel(value: string) { return causeLabels[value] ?? value }
export function dateLabel(value: string) { const date = new Date(value); return Number.isNaN(+date) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
export function errorText(value: unknown) { return value instanceof Error ? value.message : String(value) }
export function locatorLabel(locator: Locator) { return locator.jsonPointer ?? (locator.start > 0 ? `第 ${locator.start}${locator.end > locator.start ? `–${locator.end}` : ''} 行${locator.outlineId ? ` · 节点 ${locator.outlineId}` : ''}` : locator.outlineId ? `节点 ${locator.outlineId}` : '文件级定位') }
export const UNASSIGNED_TOPIC = '__unassigned__'
export function isKeywordGraph(snapshot: Snapshot | null) { return snapshot?.meta.algorithm.version === 'habitat-keyword/2' }
export function graphNodes(snapshot: Snapshot | null) { return snapshot?.nodes.filter(n => !isKeywordGraph(snapshot) || n.nodeType === 'keyword') ?? [] }
export function filterNodes(snapshot: Snapshot | null, query: string, topic: string): Node[] {
  if (!snapshot) return []
  const assigned = isKeywordGraph(snapshot) && topic === UNASSIGNED_TOPIC ? new Set(snapshot.memberships.filter(m => m.role === 'primary').map(m => m.node)) : null
  const members = topic && !assigned ? new Set(snapshot.memberships.filter(m => m.topic === topic && (!isKeywordGraph(snapshot) || m.role === 'primary')).map(m => m.node).concat(topic)) : null
  const search = query.trim().toLocaleLowerCase()
  return graphNodes(snapshot).filter(n => (!assigned || !assigned.has(n.id)) && (!members || members.has(n.id)) && (!search || [n.label, ...(n.aliases ?? [])].some(v => v.toLocaleLowerCase().includes(search))))
}
export function isExplicit(edge: Edge) {
  if (['imported', 'candidate', 'unresolved'].includes(edge.status)) return false
  return ['explicit_reference', 'wikilink', 'links_to', 'cites'].includes(edge.edgeType) || ['user-confirmed', 'confirmed'].includes(edge.status)
}
export interface FamilyCounts { verified: number; provisional: number; unresolved: number }
export function nodeFamilyCounts(snapshot: Snapshot | null): Map<string, FamilyCounts> {
  if (!snapshot) return new Map()
  const evidence = new Map(snapshot.evidence.map(e => [e.id, e])), sources = new Map(snapshot.sources.map(s => [s.id, s]))
  return new Map(snapshot.nodes.map(node => {
    const verified = new Set<string>(), provisional = new Set<string>(), unresolved = new Set<string>()
    for (const id of node.evidence ?? []) {
      const ref = evidence.get(id), source = ref && sources.get(ref.source)
      if (!source) continue
      if (source.familyStatus === 'verified') verified.add(source.family)
      else if (source.familyStatus === 'provisional') provisional.add(source.family)
      else unresolved.add(source.id)
    }
    return [node.id, { verified: verified.size, provisional: provisional.size, unresolved: unresolved.size }]
  }))
}

/** Show bounded landmarks, not every knowledge record as a tiny building. */
export function cityNodes(nodes: Node[], selected: string, limit = 72): Node[] {
  const group = (n: Node) => n.nodeType === 'project' ? 0 : n.nodeType === 'topic' ? 1 : n.nodeType === 'concept' ? 2 : n.nodeType === 'document' ? 4 : 3
  const ranked = [...nodes].sort((a, b) => group(a) - group(b) || (b.evidence?.length ?? 0) - (a.evidence?.length ?? 0) || a.id.localeCompare(b.id))
  const result: Node[] = [], shown = new Set<string>()
  const add = (node: Node) => { if (!shown.has(node.id) && result.length < limit) { result.push(node); shown.add(node.id) } }
  const selectedNode = nodes.find(n => n.id === selected); if (selectedNode) add(selectedNode)
  // Reserve space across types; hundreds of project candidates must not hide all concepts.
  for (const [kind, count] of [16, 16, 28, 8, 4].entries()) for (const node of ranked.filter(n => group(n) === kind).slice(0, Math.ceil(count * limit / 72))) add(node)
  for (const node of ranked) add(node)
  return result
}
