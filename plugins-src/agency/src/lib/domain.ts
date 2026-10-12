import type { Batch, Episode, Finding, Job, Provider, QueueItem, SignalState } from './types'

export const dimensions = [
  { key: 'efficacy', label: '效能', description: '行动与可观察结果的联系' },
  { key: 'optimism', label: '乐观', description: '遇到困难后的解释与调整' },
  { key: 'imagination', label: '想象', description: '提出、比较或尝试其他路径' },
] as const
export const signalLabels: Record<SignalState, string> = {
  observed: '观察到线索', not_observed: '未观察到', unknown: '证据不足', not_applicable: '不适用',
}
export const outcomeLabels: Record<Episode['outcome'], string> = {
  ongoing: '仍在进行', assistant_reported: 'AI 自述完成', user_confirmed: '用户确认结果', stopped: '已停止', unknown: '结果未知',
}
export const goalLabels: Record<Episode['goal_origin'], string> = {
  user: '用户提出', adopted: '用户采纳', delegated: '已委托', unknown: '来源未知',
}
export function localYesterday(now = new Date()): string {
  const date = new Date(now)
  date.setDate(date.getDate() - 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function localRecentDates(now = new Date()): string[] {
  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(now)
    date.setDate(date.getDate() - offset)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  })
}
export function defaultObservationRange(now = new Date()): { start: string; end: string } {
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const dates = localRecentDates(yesterday)
  return { start: dates[6], end: dates[0] }
}
export function validateObservationRange(start: string, end: string): { days: number; error: string | null } {
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN
    const timestamp = Date.parse(`${value}T00:00:00Z`)
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : NaN
  }
  const first = parse(start), last = parse(end)
  if (!Number.isFinite(first) || !Number.isFinite(last)) return { days: 0, error: '请选择有效的开始和结束日期。' }
  if (last < first) return { days: 0, error: '结束日期不能早于开始日期。' }
  const days = (last - first) / 86_400_000 + 1
  return { days, error: days > 31 ? '一次最多生成 31 天（含开始和结束日期）。' : null }
}
export const jobLabels: Record<Job['state'], string> = {
  running: '正在生成', done: '生成完成', partial: '部分完成', failed: '生成失败', cancelled: '已停止',
}
export const queueItemLabels: Record<QueueItem['state'], string> = {
  pending: '等待中', running: '正在生成', done: '已生成', reused: '已复用', skipped: '已跳过', failed: '失败', cancelled: '已取消',
}
export function queueItemState(item: QueueItem, stopRequested = false): QueueItem['state'] {
  return stopRequested && item.state === 'pending' ? 'cancelled' : item.state
}
export function queueSettled(job: Job): number {
  return job.items?.filter(item => !['pending', 'running'].includes(queueItemState(item, job.stop_requested))).length ?? 0
}
export function jobResultsSignature(job: Job | null): string {
  if (!job) return ''
  return JSON.stringify([job.id, job.state, job.items?.filter(item => !['pending', 'running'].includes(item.state)).map(item => [item.date, item.state, item.episodes]) ?? []])
}
export const practicalColumns = [
  { key: 'progress', label: '具体目标进展', description: '目标发生了什么可验证的变化', unknown: '具体进展未知：没有足够证据判断目标发生了什么变化。' },
  { key: 'friction', label: '协作负担', description: '明确出现的返工、纠错与额外投入', unknown: '协作负担未知：没有记录不代表没有负担。' },
  { key: 'expansion', label: '能力扩展', description: '从以前做不到到现在能做，或留下可复用产物', unknown: '能力扩展未知：普通委托不等于能力扩展。' },
] as const
export function isLegacyBatch(batch: Batch): boolean { return (batch.rule_version ?? 1) < 2 }
export function hasEvidence(indices: number[], episode: Episode): boolean {
  return indices.length > 0 && indices.every(i => Number.isInteger(i) && i >= 0 && !!episode.evidence[i]?.quote.trim())
}
export function supportedFinding(finding: Finding | null | undefined, episode: Episode): Finding | null {
  return finding?.note.trim() && hasEvidence(finding.evidence_indices, episode) ? finding : null
}
export function collaborationReview(batch: Batch | null) {
  const active = batch?.episodes.filter(e => !batch.reviews[e.id]?.excluded) ?? []
  const legacy = !!batch && isLegacyBatch(batch)
  const columns = practicalColumns.map(column => ({ ...column, items: active.flatMap(episode => {
    if (legacy) {
      const note = column.key === 'progress' ? '旧版仅保留目标状态，具体变化尚未结构化核对。'
        : column.key === 'friction' ? episode.friction : null
      return note ? [{ episode, note, evidence_indices: [] as number[], legacy: true }] : []
    }
    const finding = supportedFinding(episode.practical?.[column.key], episode)
    return finding ? [{ episode, ...finding, legacy: false }] : []
  }) }))
  const experimentEpisode = !legacy ? active.find(episode => {
    const experiment = episode.practical?.experiment
    return experiment?.action.trim() && experiment.check.trim() && hasEvidence(experiment.evidence_indices, episode)
  }) : undefined
  return {
    legacy,
    included: active.length,
    excluded: (batch?.episodes.length ?? 0) - active.length,
    columns,
    experiment: experimentEpisode ? { episode: experimentEpisode, ...experimentEpisode.practical!.experiment! } : null,
  }
}
const allowed = new Set(['notemd.codex-agent', 'notemd.claude-agent', 'notemd.deepseek-agent'])
export function supportedProviders(providers: Provider[]): Provider[] { return providers.filter(p => allowed.has(p.id)) }
export function supportsAgency(provider: Provider | undefined): boolean {
  const capabilities = provider?.harness?.capabilities
  return provider?.harness?.ok === true && capabilities?.terminal_result === true
    && capabilities.input_only_isolation === true && capabilities.tasks?.includes('agency-observe-v1') === true
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
