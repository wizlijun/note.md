import type { TimelineItem } from './parser'

export type Importance = TimelineItem['metadata']['importance']
export const IMPORTANCE_LEVELS: Importance[] = ['high', 'normal', 'unknown']
export function importanceLabel(value: Importance, zh: boolean): string {
  return ({ high: zh ? '重要' : 'Important', normal: zh ? '普通' : 'Normal', unknown: zh ? '待判断' : 'Pending review' })[value]
}
export function assessmentLabel(item: TimelineItem, zh: boolean): string {
  return importanceLabel(item.metadata.importance, zh) + (item.metadata.anomaly?.status === 'flagged' ? (zh ? '，反常' : ', Anomaly') : '')
}
