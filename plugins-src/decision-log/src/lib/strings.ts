import { bridge } from './bridge'
export type MessageKey =
  | 'panel.title' | 'col.candidates' | 'col.open' | 'col.archive'
  | 'sign.title' | 'sign.prediction' | 'sign.confidence.low' | 'sign.confidence.medium' | 'sign.confidence.high'
  | 'sign.checkDate' | 'sign.submit'
  | 'verdict.q1' | 'verdict.hit' | 'verdict.partial' | 'verdict.miss'
  | 'verdict.q2' | 'verdict.endorseYes' | 'verdict.endorseNo' | 'verdict.submit'
  | 'score.samples' | 'score.calibration' | 'card.new' | 'downgrade.toast'
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
}
const registry: Record<string, Partial<Catalog>> = { en, zh }
export function t(key: MessageKey): string {
  let locale = 'en'
  try { locale = bridge().locale } catch { /* dev */ }
  return registry[locale]?.[key] ?? en[key] ?? key
}
