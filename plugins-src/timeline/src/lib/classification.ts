import type { TimelineItem } from './parser'

export type CategoryId = 'work' | 'interest' | 'life' | 'leisure' | 'other'
export interface ClassificationRule {
  id: string
  name: string
  keywords: string[]
  category: CategoryId
}
export const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'work', label: '工作' },
  { id: 'interest', label: '兴趣' },
  { id: 'life', label: '生活' },
  { id: 'leisure', label: '休闲' },
  { id: 'other', label: '其他' },
]

export const DEFAULT_RULES: ClassificationRule[] = [
  { id: 'review', name: '审阅', category: 'work', keywords: ['审阅', '审查', '评审', '核查', '评估', '复盘', 'review'] },
  { id: 'development', name: '开发', category: 'work', keywords: ['开发', '修复', '排障', '调试', '测试', '发布', '部署', '编程', 'development'] },
  { id: 'communication', name: '沟通', category: 'work', keywords: ['沟通', '会议', '讨论', '交流', '协调', '跟进', '商务', 'communication', 'meeting'] },
  { id: 'planning', name: '设计与组织', category: 'work', keywords: ['组织', '写作', '设计', '研究', '规划', '调研', '整理', '交付'] },
  { id: 'interest', name: '学习与爱好', category: 'interest', keywords: ['阅读', '学习', '实验', '实践', '创作', '制作', '评刀', '收藏', '露营', 'reading', 'learning'] },
  { id: 'life', name: '日常生活', category: 'life', keywords: ['家庭', '出行', '安排', '采购', '转账', '寄件', '维修', '接送', '就医', '运动', '关心', '预约', '家务', 'family'] },
  { id: 'leisure', name: '休闲娱乐', category: 'leisure', keywords: ['聚餐', '约饭', '聚会', '午餐', '散步', '休息', '娱乐', '游戏', '观影', '旅行', '休闲', 'leisure'] },
]

export function normalizeRules(value: unknown): ClassificationRule[] | null {
  if (!Array.isArray(value)) return null
  const ids = new Set<string>()
  const rules: ClassificationRule[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim() || ids.has(raw.id)
      || typeof raw.name !== 'string' || !raw.name.trim()
      || !CATEGORIES.some(category => category.id === raw.category)
      || !Array.isArray(raw.keywords) || !raw.keywords.length
      || raw.keywords.some((keyword: unknown) => typeof keyword !== 'string' || !keyword.trim())) return null
    ids.add(raw.id)
    rules.push({ id: raw.id, name: raw.name.trim(), category: raw.category,
      keywords: [...new Set<string>(raw.keywords.map((keyword: string) => keyword.trim()))] })
  }
  return rules
}

/** Only the activity label participates; rule order resolves multiple matches. */
export function classifyItem(item: Pick<TimelineItem, 'action'>, rules: ClassificationRule[]): { category: CategoryId; action: string } {
  const action = item.action.toLowerCase()
  const match = rules.find(rule => rule.keywords.some(keyword => keyword.trim() && action.includes(keyword.trim().toLowerCase())))
  return { category: match?.category ?? 'other', action: item.action }
}
