import type { DateRange, Job, KnowledgeNode, Preferences, Provider, SourceFile } from './types'
import type { TerrainSelection } from './types-terrain'

export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function recentRange(days = 30, now = new Date()) {
  const start = new Date(now); start.setDate(start.getDate() - days + 1)
  return { from: localDate(start), to: localDate(now) }
}
export function validDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const d = new Date(`${text}T12:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === text
}
export function rangeError(from: string, to: string): string {
  if (!validDate(from) || !validDate(to)) return '请选择有效的开始和结束日期。'
  return from > to ? '开始日期不能晚于结束日期。' : ''
}
export function supportsExtraction(provider: Provider | undefined): boolean {
  const h = provider?.harness
  return !!(h?.ok && h.capabilities?.terminal_result && h.capabilities.input_only_isolation && h.capabilities.tasks.includes('strata-extract-v1'))
}
export function running(job: Job | null): boolean { return !!job && ['running', 'stopping', 'recovering'].includes(job.state) }
export const jobLabels: Record<string, string> = { running: '正在深读', stopping: '等待当前批次结束', recovering: '恢复任务状态', done: '深读完成', partial: '部分完成', failed: '深读失败', cancelled: '已停止', interrupted: '任务中断' }
export const originLabels: Record<string, string> = { human: '本人创作', derived: '派生材料', source: '来源材料', unlabeled: '未分类' }
export const ownerLabels = { owner_specific: '个人独有', general: '通用知识', unknown: '独有性未知' }
export const confidentialityLabels = { confidential: '明确私密', explicitly_public: '明确公开', unknown: '保密性未知' }
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
export function nodeVisible(node: KnowledgeNode, selection: TerrainSelection): boolean {
  return (selection.includePublic !== false || node.confidentiality !== 'explicitly_public') && node.sourceGroups.some(g => g.dates.some(d => d >= selection.from && d <= selection.to))
}
export function restorePreferences(saved?: Partial<Preferences>): Preferences {
  const base: Preferences = { ...recentRange(), view: '3d', personal: true, relations: false, includePublic: true, level: 'auto', verticalScale: 1, harness: '' }
  if (!saved) return base
  if (typeof saved.from === 'string' && typeof saved.to === 'string' && !rangeError(saved.from, saved.to)) { base.from = saved.from; base.to = saved.to }
  if (saved.view === '2d' || saved.view === '3d') base.view = saved.view
  if (['auto', 'domain', 'topic', 'knowledge'].includes(saved.level ?? '')) base.level = saved.level!
  for (const k of ['personal', 'relations', 'includePublic'] as const) if (typeof saved[k] === 'boolean') base[k] = saved[k]
  if (Number.isFinite(saved.verticalScale)) base.verticalScale = Math.max(.6, Math.min(1.8, saved.verticalScale!))
  if (typeof saved.harness === 'string') base.harness = saved.harness
  return base
}

export function sourceFilesForNode(files: SourceFile[], node: KnowledgeNode | undefined, range: DateRange): SourceFile[] {
  if (!node) return []
  const groups = new Set(node.sourceGroups.map(g => g.groupId))
  const evidence = new Set(node.evidence.map(e => e.sourceId))
  return files.filter(f => f.docDate !== null && f.docDate >= range.from && f.docDate <= range.to &&
    (groups.has(`source:${f.contentHash}`) || evidence.has(f.fileKey)))
}
