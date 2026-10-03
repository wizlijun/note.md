import type { Diff, Node, Snapshot } from './types'

export type GrowthStage = 'hut' | 'cottage' | 'house' | 'workshop' | 'midrise' | 'tower'
export type GrowthState = 'growth' | 'rebuilding' | 'dormant' | 'unassessed'
export interface ConceptGrowthProfile {
  nodeId: string
  stage: GrowthStage
  level: number
  label: string
  state: GrowthState
  support: {
    sourceGroups: number
    activeSourceGroups: number
    verifiedGroups: number
    importedSourceGroups: number
    activeDays: number
    events: number
    spanDays: number
    firstObservedAt?: string
    lastObservedAt?: string
    projectBasis: 'declared' | 'referenced' | 'imported' | 'none'
  }
  reasons: string[]
  limits: string[]
}
export interface GrowthOptions { previous?: Snapshot; diff?: Diff }

const stages: GrowthStage[] = ['hut', 'cottage', 'house', 'workshop', 'midrise', 'tower']
const labels = ['茅草屋', '木屋', '住宅', '工作室', '楼宇', '摩天楼']
export const growthStateLabels = { growth: '正在生长', rebuilding: '结构重建', dormant: '近期静置', unassessed: '状态待观察' } as const
const DAY = 86400000
function day(value: string | undefined): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed / DAY : undefined
}
function projectBasis(node: Node): ConceptGrowthProfile['support']['projectBasis'] {
  if (node.intentStatus === 'declared_project' && node.status !== 'imported') return 'declared'
  if (node.intentStatus === 'task_project_reference') return 'referenced'
  if (node.intentStatus === 'imported_project_mention') return 'imported'
  return 'none'
}
function comparable(snapshot: Snapshot, options: GrowthOptions): boolean {
  const previous = options.previous
  return !!previous && previous.meta.vaultId === snapshot.meta.vaultId
    && previous.meta.scopeHash === snapshot.meta.scopeHash
    && previous.meta.algorithm.version === snapshot.meta.algorithm.version
    && !!options.diff?.comparable && options.diff.from === previous.meta.snapshotId
    && options.diff.to === snapshot.meta.snapshotId
    && !options.diff.causes.some(c => ['algorithm', 'scope'].includes(c))
}
function rebuiltNodes(snapshot: Snapshot, options: GrowthOptions): Set<string> {
  const rebuilt = new Set<string>()
  if (!comparable(snapshot, options)) return rebuilt
  const previous = options.previous!
  const oldTopics = new Map(previous.memberships.filter(m => m.role === 'primary').map(m => [m.node, m.topic]))
  const oldIds = new Set(previous.nodes.map(n => n.id))
  const changedTopics = new Set<string>()
  for (const membership of snapshot.memberships) {
    if (membership.role === 'primary' && oldIds.has(membership.node)
      && oldTopics.has(membership.node) && oldTopics.get(membership.node) !== membership.topic) rebuilt.add(membership.node)
  }
  const oldLineage = new Set(previous.lineage.map(l => l.id))
  for (const lineage of snapshot.lineage) {
    if (!oldLineage.has(lineage.id) && ['confirmed', 'user-confirmed'].includes(lineage.status)
      && ['merged', 'split', 'regrouped', 'reorganized'].includes(lineage.change)) {
      lineage.to.forEach(id => { rebuilt.add(id); changedTopics.add(id) })
    }
  }
  for (const membership of snapshot.memberships) {
    if (membership.role === 'primary' && changedTopics.has(membership.topic)) rebuilt.add(membership.node)
  }
  return rebuilt
}

/** Derive once from the complete frozen snapshot, then select visible profiles.
 * This measures recorded investment, never truth, skill or mental maturity.
 * Undated historic evidence supplies a base; only validated observations supply days.
 */
export function deriveConceptGrowth(snapshot: Snapshot, options: GrowthOptions = {}): Map<string, ConceptGrowthProfile> {
  const sources = new Map(snapshot.sources.map(s => [s.id, s]))
  const evidence = new Map(snapshot.evidence.map(e => [e.id, e]))
  const observations = new Map((snapshot.attentionObservations ?? []).map(o => [o.evidence, o]))
  const asOfText = snapshot.meta.focus?.asOf ?? snapshot.meta.generatedAt?.slice(0, 10)
  const asOf = day(asOfText)
  const rebuilt = rebuiltNodes(snapshot, options)
  const result = new Map<string, ConceptGrowthProfile>()
  for (const node of [...snapshot.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!['keyword', 'concept', 'entity', 'project'].includes(node.nodeType)) continue
    const matched = new Set<string>(), active = new Set<string>(), imported = new Set<string>()
    const familyStatus = new Map<string, Set<string>>()
    const eventDates = new Map<string, string>()
    for (const id of new Set(node.evidence ?? [])) {
      const item = evidence.get(id), source = item && sources.get(item.source)
      if (!item || !source || !['available', 'matched'].includes(source.status)) continue
      const group = source.family || `source:${source.id}`
      if (item.verification === 'imported' || source.role === 'knowledge') { imported.add(group); continue }
      if (item.verification !== 'matched' || item.role === 'metadata') continue
      matched.add(group)
      const statuses = familyStatus.get(group) ?? new Set<string>()
      statuses.add(source.familyStatus); familyStatus.set(group, statuses)
      // 'human' alone can be an old extractor default. Attention sentences
      // prove passage through the explicit user/native authorship parser.
      if (item.authorship !== 'human' || item.role !== 'attention' || item.granularity !== 'attention_sentence') continue
      active.add(group)
      const observation = observations.get(id), date = day(observation?.date)
      if (!observation || date === undefined || asOf === undefined || date > asOf
        || observation.confidence < .8 || !observation.eventId
        || !['agent_user', 'native_human'].includes(observation.signal)
        || !['same_day_session', 'session_first_turn', 'daily_date', 'explicit_unit_created'].includes(observation.dateBasis)) continue
      const knownDate = eventDates.get(observation.eventId)
      if (!knownDate || observation.date < knownDate) eventDates.set(observation.eventId, observation.date)
    }
    const dates = new Set(eventDates.values()), events = new Set(eventDates.keys())
    const orderedDates = [...dates].sort(), first = orderedDates[0], last = orderedDates.at(-1)
    const spanDays = first && last ? day(last)! - day(first)! : 0
    const basis = projectBasis(node)
    let level = 0
    if (matched.size >= 2 || active.size >= 1) level = 1
    if (active.size >= 3 || (basis === 'declared' && active.size >= 1)) level = 2
    if (active.size >= 3 && dates.size >= 3 && spanDays >= 7) level = 3
    if (active.size >= 6 && dates.size >= 6 && spanDays >= 14 && events.size >= 8) level = 4
    const sustained = active.size >= 10 && dates.size >= 12 && spanDays >= 21 && events.size >= 16
    const committed = basis === 'declared' && active.size >= 6 && dates.size >= 6 && spanDays >= 14 && events.size >= 12
    if (sustained || committed) level = 5
    if (node.status === 'imported') level = Math.min(level, 1)
    const age = last && asOf !== undefined ? asOf - day(last)! : undefined
    const state: GrowthState = rebuilt.has(node.id) ? 'rebuilding'
      : age !== undefined && age <= 7 ? 'growth'
        : age !== undefined && age > 14 ? 'dormant' : 'unassessed'
    const support: ConceptGrowthProfile['support'] = {
      sourceGroups: matched.size, activeSourceGroups: active.size,
      verifiedGroups: [...familyStatus.values()].filter(values => values.size === 1 && values.has('verified')).length,
      importedSourceGroups: imported.size, activeDays: dates.size, events: events.size, spanDays,
      firstObservedAt: first, lastObservedAt: last, projectBasis: basis,
    }
    const reasons = [`${matched.size} 组可定位的非导入来源，其中 ${active.size} 组含本人主动记录`]
    if (dates.size) reasons.push(`${dates.size} 个可定日的主动记录日，${events.size} 个去重事件，跨度 ${spanDays} 天`)
    if (basis === 'declared') reasons.push('原生记录有明确项目声明；声明本身不等于项目完成')
    if (basis === 'referenced') reasons.push('任务中提及项目；未当作明确项目承诺')
    if (basis === 'imported') reasons.push('项目身份来自导入提及；不据此升级建筑')
    if (state === 'rebuilding') reasons.push('可比较版本中存在实际社区迁移或新增已确认重组记录')
    if (state === 'growth') reasons.push('冻结观察日之前 7 天内有主动记录')
    if (state === 'dormant') reasons.push('可用日期中最近一次主动记录距冻结观察日超过 14 天')
    const limits = ['建筑等级表示已记录投入证据，不表示知识正确、思想成熟或人的能力', '来源组用于去重，不等于互相独立的证据']
    if (!dates.size) limits.push('缺少可信日期，不能推断持续时间或休眠；旧快照采用保守基底')
    else if (snapshot.meta.focus) limits.push(`日期支持仅覆盖快照提供的 ${snapshot.meta.focus.windowDays} 天观察窗；日期淡出不代表遗忘，不能从未定日历史推断跨度`)
    if (imported.size) limits.push(`${imported.size} 组导入材料保留为背景，不增加高层建筑资格`)
    result.set(node.id, { nodeId: node.id, stage: stages[level], level, label: labels[level], state, support, reasons, limits })
  }
  return result
}
