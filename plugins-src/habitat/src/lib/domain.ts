import type { Attention, Edge, Locator, Node, Snapshot } from './types'

export const typeLabels: Record<string, string> = { keyword: '关键词', concept: '概念', project: '项目', topic: '主题', entity: '实体', claim: '主张', event: '事件', narrative: '叙事', person: '人物', tool: '工具', resource: '资料作品', term_candidate: '待辨认词项', system: '系统', organization: '组织', document: '文档', wiki: '命名锚点' }
export const statusLabels: Record<string, string> = { asserted: '原文陈述', declared_project: '明确项目声明', task_project_reference: '任务中提及项目', imported_project_mention: '导入项目提及', submitted: '用户提交材料', statistical: '统计关联', candidate: '候选', anchor: '命名锚点', observed: '明确记录', imported: 'AI 提取候选', 'user-confirmed': '用户已确认', confirmed: '已确认', disputed: '有分歧', contested: '有分歧', superseded: '已替代', 'source-unavailable': '来源不可用', unavailable: '来源不可用', unresolved: '待辨认', matched: '版本已核对', verified: '已核对', unknown: '未知', agent: 'AI 生成', human: '用户记录', quoted: '引用', derived: '派生材料', provisional: '暂定', summary: '摘要', source: '来源', primary: '主要归属', secondary: '关联归属' }
const edgeLabels: Record<string, string> = { influences: '影响', precedes: '先于', derived_from: '来源于', participates_in: '参与', distinct_from: '区别于', has_role_in: '在其中担任角色', inhibits: '抑制', is_a: '是一种', part_of: '是其组成部分', depends_on: '依赖', alias_of: '又称', links_to: '知识链接', cites: '引用', co_discussed: '重复共同讨论', co_occurs: '统计共现', explicit_reference: '明确引用', wikilink: '知识链接', tagged_with: '标签关联', co_mentioned_in: '同处讨论', lexically_similar: '词汇邻近' }
export function relationExplanation(edge: Edge) {
  if (isAssertedRelation(edge)) return '原文明确陈述了这个有方向的关系；保留原文依据，不等于已核实的客观事实。'
  if (edge.edgeType === 'co_discussed') return '至少两次去重的主动记录事件中，在同一短句共同讨论；记录事件不等于独立来源。'
  if (edge.edgeType === 'co_occurs') return '至少两个去重来源组中，在同一短段落或大纲节点共同出现；未知谱系不等于独立来源。'
  return ''
}
export function edgeLabel(value: string) { return edgeLabels[value] ?? value }
export const causeLabels: Record<string, string> = { attention_window: '关注窗口变化', attention: '关注线索变化', baseline: '首次建立', structure: '结构变化', coverage: '覆盖变化', content: '内容变化', evidence: '证据更新', algorithm: '算法变化', algorithm_change: '算法变化', scope: '分析范围变化', mixed: '多种变化', initial: '首次建立', restore: '恢复旧版', layout: '布局变化' }
export function typeLabel(value: string, conceptGraph = false) { return conceptGraph && value === 'keyword' ? '概念' : typeLabels[value] ?? value }
export function statusLabel(value: string) { return statusLabels[value] ?? value }
export function causeLabel(value: string) { return causeLabels[value] ?? value }
export function dateLabel(value: string) { const date = new Date(value); return Number.isNaN(+date) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
export function errorText(value: unknown) { return value instanceof Error ? value.message : String(value) }
export function locatorLabel(locator: Locator) { return locator.jsonPointer ?? (locator.start > 0 ? `第 ${locator.start}${locator.end > locator.start ? `–${locator.end}` : ''} 行${locator.outlineId ? ` · 节点 ${locator.outlineId}` : ''}` : locator.outlineId ? `节点 ${locator.outlineId}` : '文件级定位') }
export const UNASSIGNED_TOPIC = '__unassigned__'
export function isKeywordGraph(snapshot: Snapshot | null) { return /^habitat-(keyword|focus)\//.test(snapshot?.meta.algorithm.version ?? '') }
export type GraphLayer = 'main' | 'background' | 'all'
export function isConceptGraph(snapshot: Snapshot | null) {
  const version = /^habitat-focus\/(\d+)$/.exec(snapshot?.meta.algorithm.version ?? '')
  return !!version && Number(version[1]) >= 4
}
export function isMainConcept(node: Node) { return ['keyword', 'project'].includes(node.nodeType) }
export function inGraphLayer(node: Node, layer: GraphLayer) {
  return node.nodeType !== 'topic' && (layer === 'all' || isMainConcept(node) === (layer === 'main'))
}
export function graphNodes(snapshot: Snapshot | null, layer: GraphLayer = 'main') {
  return snapshot?.nodes.filter(n => isConceptGraph(snapshot) ? inGraphLayer(n, layer) : !isKeywordGraph(snapshot) || n.nodeType === 'keyword') ?? []
}
export function hasRecentFocus(snapshot: Snapshot | null) { return !!snapshot?.meta.focus }
export function attentionLabel(attention: Attention) { return attention.category === 'context' ? '背景线索' : '概念线索' }
export function focusDistrictLabel(nodes: Node[], attention: Map<string, Attention>) {
  const ranked = nodes.filter(node => attention.has(node.id)).sort((a, b) =>
    Number(attention.get(b.id)!.category === 'concept') - Number(attention.get(a.id)!.category === 'concept') ||
    attention.get(b.id)!.score - attention.get(a.id)!.score || a.id.localeCompare(b.id))
  if (!ranked.length) return undefined
  return { name: ranked.slice(0, 3).map(node => node.label).join(' · '), category: attention.get(ranked[0].id)!.category }
}
export function attentionNodes(snapshot: Snapshot | null): Node[] {
  if (!snapshot) return []
  const nodes = new Map(snapshot.nodes.map(n => [n.id, n]))
  return [...(snapshot.attention ?? [])].sort((a, b) => b.score - a.score || a.node.localeCompare(b.node))
    .flatMap(item => { const node = nodes.get(item.node); return node ? [node] : [] })
}
export const signalLabels: Record<string, string> = { submitted_material: '提交的材料', trace_request: '留存过程的请求', active_note: '主动笔记', agent_user: '本人会话表达', personal_note: '本人记录', explicit_term: '明确提及', repeated_mention: '反复提及', user_message: '本人表达', phrase: '原文短语', native_human: '本人笔记', question: '主动提问' }
export const dateBasisLabels: Record<string, string> = { daily_date: '日记所属日期', explicit_human_request_time: '明确请求时间', same_day_session: '同日会话日期', session_first_turn: '会话首轮日期', explicit_unit_created: '条目明确记录日期', daily_note: '日记所属日', path_date: '路径日期', frontmatter: '记录日期', message_timestamp: '消息时间', session_date: '会话日期', event_date: '事件日期', explicit_date: '明确日期' }
export function signalLabel(signal: string) { return signalLabels[signal] ?? signal }
export function dateBasisLabel(basis: string) { return dateBasisLabels[basis] ?? basis }
export function filterNodes(snapshot: Snapshot | null, query: string, topic: string, recent = false, layer: GraphLayer = 'main'): Node[] {
  if (!snapshot) return []
  const assigned = isKeywordGraph(snapshot) && topic === UNASSIGNED_TOPIC ? new Set(snapshot.memberships.filter(m => m.role === 'primary').map(m => m.node)) : null
  const members = topic && !assigned ? new Set(snapshot.memberships.filter(m => m.topic === topic && (!isKeywordGraph(snapshot) || m.role === 'primary')).map(m => m.node).concat(topic)) : null
  const search = query.trim().toLocaleLowerCase()
  return (recent && hasRecentFocus(snapshot) ? attentionNodes(snapshot) : graphNodes(snapshot, layer)).filter(n => (!isConceptGraph(snapshot) || inGraphLayer(n, layer)) && (!assigned || !assigned.has(n.id)) && (!members || members.has(n.id)) && (!search || [n.label, ...(n.aliases ?? [])].some(v => v.toLocaleLowerCase().includes(search))))
}
export function isStatisticalRelation(edge: Edge) { return edge.status === 'statistical' && ['co_occurs', 'co_discussed'].includes(edge.edgeType) }
export function isAssertedRelation(edge: Edge) {
  return edge.status === 'asserted' && ['is_a', 'part_of', 'depends_on', 'alias_of', 'influences'].includes(edge.edgeType)
    && edge.participants.length === 2 && edge.participants.some(p => p.role === 'subject') && edge.participants.some(p => p.role === 'object')
}
/** Display certainty is independent of support counts: imported/candidate claims never upgrade a road. */
export function cityRelations(snapshot: Snapshot | null, includeStatistical = false): Edge[] {
  if (!snapshot) return []
  if (!isConceptGraph(snapshot)) return snapshot.edges
  return snapshot.edges.filter(edge => isAssertedRelation(edge)
    || (['observed', 'confirmed', 'user-confirmed'].includes(edge.status) && ['explicit_reference', 'wikilink', 'links_to', 'cites', 'tagged_with'].includes(edge.edgeType))
    || (includeStatistical && isStatisticalRelation(edge)))
}
const roleLabels: Record<string, string> = { subject: '主语', object: '宾语', source: '起点', target: '目标', member: '成员', context: '背景', cause: '原因', effect: '结果' }
export function participantRoleLabel(role: string) { return roleLabels[role] ?? '关联对象' }
export function relationStatement(edge: Edge, nodes: Map<string, Node>) {
  const subject = edge.participants.find(p => p.role === 'subject'), object = edge.participants.find(p => p.role === 'object')
  if (!subject || !object) return ''
  return `${nodes.get(subject.node)?.label ?? '未定位对象'} → ${edgeLabel(edge.edgeType)} → ${nodes.get(object.node)?.label ?? '未定位对象'}`
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
