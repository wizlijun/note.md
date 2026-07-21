import { bridge } from './bridge'
export type MessageKey =
  | 'panel.title' | 'col.candidates' | 'col.open' | 'col.archive'
  | 'sign.title' | 'sign.prediction' | 'sign.confidence.low' | 'sign.confidence.medium' | 'sign.confidence.high'
  | 'sign.checkDate' | 'sign.submit'
  | 'verdict.q1' | 'verdict.hit' | 'verdict.partial' | 'verdict.miss'
  | 'verdict.q2' | 'verdict.endorseYes' | 'verdict.endorseNo' | 'verdict.submit'
  | 'score.samples' | 'score.calibration' | 'card.new' | 'downgrade.toast'
  | 'sign.confidenceLabel' | 'sign.triggers' | 'sign.triggersHint' | 'sign.predictionRequired'
  | 'sign.quotedLead' | 'sign.nominatedLead' | 'sign.title.new' | 'sign.titleLabel'
  | 'verdict.locked' | 'verdict.evidence' | 'verdict.noEvidence'
  | 'score.empty' | 'score.avoidance' | 'score.noVerdicts'
  | 'col.candidatesEmpty' | 'col.openEmpty' | 'col.archiveEmpty'
  | 'card.daysLeft' | 'card.dueToday' | 'card.overdue' | 'card.stillEndorse'
  | 'badge.quoted' | 'badge.nominated'
  | 'common.cancel' | 'common.loading' | 'drag.invalid'
  | 'review.start' | 'review.of' | 'review.decide' | 'review.skip'
  | 'review.title' | 'review.downgraded'
type Catalog = Record<MessageKey, string>
const en: Catalog = {
  'panel.title': 'Decision Log', 'col.candidates': 'Candidates', 'col.open': 'Open', 'col.archive': 'Archive',
  'sign.title': 'Sign this bet', 'sign.prediction': 'Prediction',
  'sign.confidence.low': 'Somewhat sure', 'sign.confidence.medium': 'Fairly sure', 'sign.confidence.high': 'Very sure',
  'sign.checkDate': 'Check on', 'sign.submit': 'Sign the bet',
  'verdict.q1': 'Did it happen?', 'verdict.hit': 'Hit', 'verdict.partial': 'Partial', 'verdict.miss': 'Missed',
  'verdict.q2': 'Ignoring the result — would you decide this way again?', 'verdict.endorseYes': 'Yes', 'verdict.endorseNo': 'No',
  'verdict.submit': 'Close & archive',
  'score.samples': 'samples collected', 'score.calibration': 'Calibration', 'card.new': 'New Decision',
  'downgrade.toast': 'Set aside for you — reopen anytime.',
  'sign.confidenceLabel': 'How sure are you?', 'sign.triggers': 'Reconsider if…', 'sign.triggersHint': 'e.g. a competitor ships first',
  'sign.predictionRequired': 'Write a falsifiable prediction to sign.',
  'sign.quotedLead': 'You said', 'sign.nominatedLead': 'A prediction to lock in — your words',
  'sign.title.new': 'New decision', 'sign.titleLabel': 'Decision',
  'verdict.locked': 'Locked at signing', 'verdict.evidence': 'Evidence', 'verdict.noEvidence': 'No evidence attached yet.',
  'score.empty': '0 samples collected so far', 'score.avoidance': 'You keep avoiding', 'score.noVerdicts': 'Verdicts will show your calibration here.',
  'col.candidatesEmpty': 'AI-nominated candidates land here.', 'col.openEmpty': 'Signed bets waiting for their check date.',
  'col.archiveEmpty': 'Resolved decisions appear here after a verdict.',
  'card.daysLeft': 'days left', 'card.dueToday': 'due today', 'card.overdue': 'overdue',
  'card.stillEndorse': 'still endorse',
  'badge.quoted': 'your words', 'badge.nominated': 'AI-nominated',
  'common.cancel': 'Cancel', 'common.loading': 'Loading…', 'drag.invalid': 'Decisions only move forward.',
  'review.start': 'Due check', 'review.of': 'of', 'review.decide': 'Give a verdict', 'review.skip': 'Skip for now',
  'review.title': 'Due check', 'review.downgraded': "You didn't come back to this a few times — I've set it aside for you. Reopen anytime.",
}
const zh: Partial<Catalog> = {
  'panel.title': '决策日志', 'col.candidates': '候选', 'col.open': '未决', 'col.archive': '归档',
  'sign.title': '签字下注', 'sign.prediction': '预测',
  'sign.confidence.low': '有点把握', 'sign.confidence.medium': '挺有把握', 'sign.confidence.high': '非常有把握',
  'sign.checkDate': '检查日期', 'sign.submit': '签字下注',
  'verdict.q1': '发生了吗?', 'verdict.hit': '命中', 'verdict.partial': '部分', 'verdict.miss': '未命中',
  'verdict.q2': '抛开结果 —— 还会这么决定吗?', 'verdict.endorseYes': '会', 'verdict.endorseNo': '不会',
  'verdict.submit': '关闭并归档',
  'score.samples': '个决策样本', 'score.calibration': '校准', 'card.new': '新建决策',
  'downgrade.toast': '帮你清理了 —— 随时可捞回。',
  'sign.confidenceLabel': '你有多大把握?', 'sign.triggers': '若发生就复议…', 'sign.triggersHint': '例如:竞品先发布',
  'sign.predictionRequired': '写下一个可证伪的预测才能签字。',
  'sign.quotedLead': '你说过', 'sign.nominatedLead': '要锁定的预测 —— 用你自己的话',
  'sign.title.new': '新建决策', 'sign.titleLabel': '决策',
  'verdict.locked': '签字时锁定', 'verdict.evidence': '证据', 'verdict.noEvidence': '尚未附上证据。',
  'score.empty': '已积累 0 个样本', 'score.avoidance': '你一直在回避', 'score.noVerdicts': '裁决后这里会显示你的校准。',
  'col.candidatesEmpty': 'AI 提名的候选会出现在这里。', 'col.openEmpty': '已签字、等待检查日期的决策。',
  'col.archiveEmpty': '裁决后此处出现记录。',
  'card.daysLeft': '天后检查', 'card.dueToday': '今天到期', 'card.overdue': '已过期',
  'card.stillEndorse': '仍认同',
  'badge.quoted': '你的原话', 'badge.nominated': 'AI 提名',
  'common.cancel': '取消', 'common.loading': '加载中…', 'drag.invalid': '决策只能向前推进。',
  'review.start': '到期检查', 'review.of': '/', 'review.decide': '裁决', 'review.skip': '本次跳过',
  'review.title': '到期检查', 'review.downgraded': '这条你几次没回来看,先帮你放一边了 —— 随时可捞回。',
}
const registry: Record<string, Partial<Catalog>> = { en, zh }
export function t(key: MessageKey): string {
  let locale = 'en'
  try { locale = bridge().locale } catch { /* dev */ }
  return registry[locale]?.[key] ?? en[key] ?? key
}
