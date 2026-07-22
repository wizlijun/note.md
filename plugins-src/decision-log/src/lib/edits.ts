// Pure transforms for accepting agent `edit_decisions` suggestions + consume write-back.
// All functions are pure (no I/O); callers inject date/now for determinism.
import type { OpenDecision, ArchivedDecision } from './model'

/** 负向存储的一条「不准」记录:用户拒绝的候选/建议,供 agent 后续避免重复建议。 */
export interface RejectedEntry {
  type: 'candidate' | 'closure' | 'edit'
  decision_id?: string   // closure/edit
  title?: string         // candidate
  quote?: string         // candidate(便于 agent 匹配避免)
  kind?: string          // edit
  summary?: string       // edit
  reason?: string        // 用户备注,默认省略
  rejected_at: string    // date
}

/** 把一条 RejectedEntry 合并追加进 _rejected.json 字符串,返回新字符串(2 空格缩进)。
 *  解析失败 / 无 rejected 数组 → 从 { rejected: [] } 起始,再 push。 */
export function appendRejectedJson(json: string, entry: RejectedEntry): string {
  let obj: any
  try { obj = JSON.parse(json) } catch { obj = null }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.rejected)) obj = { rejected: [] }
  obj.rejected.push(entry)
  return JSON.stringify(obj, null, 2)
}

/** 给某未决决策追加一条进展笔记(不存在则原样返回,不改输入)。 */
export function applyNote(open: OpenDecision[], id: string, date: string, text: string): OpenDecision[] {
  return open.map((d) =>
    d.id === id ? { ...d, progress: [...(d.progress ?? []), { date, text }] } : d,
  )
}

/** 改某决策的 check-date(不存在则原样返回,不改输入)。 */
export function applyAdjustCheckDate(open: OpenDecision[], id: string, newDate: string): OpenDecision[] {
  return open.map((d) => (d.id === id ? { ...d, 'check-date': newDate } : d))
}

/** 放弃归档:从 open 移除,产出 status:'dropped' 的 ArchivedDecision(不进命中统计:无 outcome/still-endorse)。
 *  id 不存在时抛错(与 lifecycle.verdict 一致的严格策略)。 */
export function applyDrop(open: OpenDecision[], id: string, resolved: string): { open: OpenDecision[]; archived: ArchivedDecision } {
  const d = open.find((x) => x.id === id)
  if (!d) throw new Error(`applyDrop: id ${id} not open`)
  void resolved // resolved 决定归档文件落在哪一天(I/O 层用),纯变换只需产出记录
  const archived: ArchivedDecision = {
    id: d.id, created: d.created, status: 'dropped', prediction: d.prediction,
    confidence: d.confidence, origin: d.origin,
    ...(d.state ? { state: d.state } : {}),
  }
  return { open: open.filter((x) => x.id !== id), archived }
}

/** 在候选文件 JSON 里把匹配的第一条 pending 项 status 改为 accepted|dismissed,返回新字符串。
 *  new_candidates 用 id 匹配;closures/edit_decisions 用 decision_id 匹配。
 *  解析失败/找不到 → 原样返回(best-effort,不抛)。 */
export function markConsumed(
  json: string,
  array: 'new_candidates' | 'closures' | 'edit_decisions',
  key: string,
  status: 'accepted' | 'dismissed',
): string {
  let obj: any
  try { obj = JSON.parse(json) } catch { return json }
  const arr = obj?.[array]
  if (!Array.isArray(arr)) return json
  const keyField = array === 'new_candidates' ? 'id' : 'decision_id'
  const idx = arr.findIndex((it: any) => it?.[keyField] === key && (it?.status == null || it.status === 'pending'))
  if (idx === -1) return json
  arr[idx] = { ...arr[idx], status }
  return JSON.stringify(obj)
}
