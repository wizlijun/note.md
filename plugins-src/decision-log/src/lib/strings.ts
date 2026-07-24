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
  | 'review.title' | 'review.downgraded' | 'review.continue'
  | 'sugg.dueVerdict' | 'sugg.due.hit' | 'sugg.due.partial' | 'sugg.due.miss'
  | 'sugg.progress' | 'sugg.adjustDate' | 'sugg.closeHit' | 'sugg.closePartial'
  | 'sugg.closeMiss' | 'sugg.drop'
  | 'sugg.accept' | 'sugg.note' | 'sugg.detail' | 'sugg.dismiss'
  | 'sugg.evidence' | 'drag.reopenConfirm'
  | 'reject' | 'reject.hint'
  | 'refresh' | 'refresh.hint'
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
  'review.title': 'Due check', 'review.downgraded': "You didn't come back to this a few times — I've set it aside for you. Reopen anytime.", 'review.continue': 'Continue',
  'sugg.dueVerdict': 'Due for a verdict', 'sugg.due.hit': 'Looks like a hit', 'sugg.due.partial': 'Looks partial', 'sugg.due.miss': 'Looks like a miss',
  'sugg.progress': 'Progress', 'sugg.adjustDate': 'Suggest new check date →', 'sugg.closeHit': 'Suggest closing — hit', 'sugg.closePartial': 'Suggest closing — partial',
  'sugg.closeMiss': 'Suggest closing — miss', 'sugg.drop': 'Suggest dropping this',
  'sugg.accept': 'Accept', 'sugg.note': 'Note it', 'sugg.detail': 'Details', 'sugg.dismiss': 'Dismiss',
  'sugg.evidence': 'Evidence', 'drag.reopenConfirm': 'Reopen this decision and move it back to Open?',
  'reject': 'Mark inaccurate', 'reject.hint': 'Not accurate — remove and let the AI avoid this next time.',
  'refresh': 'Refresh', 'refresh.hint': 'Force refresh',
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
  'review.title': '到期检查', 'review.downgraded': '这条你几次没回来看,先帮你放一边了 —— 随时可捞回。', 'review.continue': '继续',
  'sugg.dueVerdict': '到期待裁决', 'sugg.due.hit': '看起来命中', 'sugg.due.partial': '看起来部分', 'sugg.due.miss': '看起来未命中',
  'sugg.progress': '进展', 'sugg.adjustDate': '建议改检查日期 →', 'sugg.closeHit': '建议关闭:命中', 'sugg.closePartial': '建议关闭:部分',
  'sugg.closeMiss': '建议关闭:未命中', 'sugg.drop': '建议放弃',
  'sugg.accept': '接受', 'sugg.note': '记一笔', 'sugg.detail': '详情', 'sugg.dismiss': '忽略',
  'sugg.evidence': '证据', 'drag.reopenConfirm': '重开这条决策,移回未决列?',
  'reject': '不准', 'reject.hint': '标为不准 —— 删除并让 AI 以后避免。',
  'refresh': '刷新', 'refresh.hint': '强制刷新',
}
const ja: Partial<Catalog> = {
  'panel.title': '意思決定ログ', 'col.candidates': '候補', 'col.open': '未決', 'col.archive': 'アーカイブ',
  'sign.title': 'この賭けにサインする', 'sign.prediction': '予測',
  'sign.confidence.low': 'まあ確か', 'sign.confidence.medium': 'かなり確か', 'sign.confidence.high': '非常に確か',
  'sign.checkDate': '確認日', 'sign.submit': '賭けにサインする',
  'verdict.q1': '起きましたか?', 'verdict.hit': '的中', 'verdict.partial': '一部', 'verdict.miss': '外れ',
  'verdict.q2': '結果は抜きにして —— また同じ決定をしますか?', 'verdict.endorseYes': 'する', 'verdict.endorseNo': 'しない',
  'verdict.submit': '確定してアーカイブ',
  'score.samples': '件のサンプルを収集', 'score.calibration': 'キャリブレーション', 'card.new': '新しい決定',
  'downgrade.toast': '脇に片付けておきました —— いつでも戻せます。',
  'sign.confidenceLabel': 'どのくらい確かですか?', 'sign.triggers': '次の場合は再検討…', 'sign.triggersHint': '例:競合が先にリリースしたら',
  'sign.predictionRequired': 'サインするには反証可能な予測を書いてください。',
  'sign.quotedLead': 'あなたの言葉', 'sign.nominatedLead': '固定する予測 —— あなた自身の言葉で',
  'sign.title.new': '新しい決定', 'sign.titleLabel': '決定',
  'verdict.locked': 'サイン時に固定', 'verdict.evidence': '根拠', 'verdict.noEvidence': 'まだ根拠が添付されていません。',
  'score.empty': 'これまで 0 件のサンプルを収集', 'score.avoidance': 'あなたは避け続けています', 'score.noVerdicts': '判定するとここにキャリブレーションが表示されます。',
  'col.candidatesEmpty': 'AI が提案した候補がここに届きます。', 'col.openEmpty': 'サイン済みで確認日を待つ賭け。',
  'col.archiveEmpty': '判定後、解決済みの決定がここに表示されます。',
  'card.daysLeft': '日後に確認', 'card.dueToday': '今日が期日', 'card.overdue': '期限超過',
  'card.stillEndorse': 'なお支持',
  'badge.quoted': 'あなたの言葉', 'badge.nominated': 'AI 提案',
  'common.cancel': 'キャンセル', 'common.loading': '読み込み中…', 'drag.invalid': '決定は前にしか進めません。',
  'review.start': '期日の確認', 'review.of': '/', 'review.decide': '判定する', 'review.skip': '今回はスキップ',
  'review.title': '期日の確認', 'review.downgraded': '何度か見に来なかったので、脇に片付けておきました —— いつでも戻せます。', 'review.continue': '続ける',
  'sugg.dueVerdict': '判定の期日', 'sugg.due.hit': '的中のようです', 'sugg.due.partial': '一部のようです', 'sugg.due.miss': '外れのようです',
  'sugg.progress': '進捗', 'sugg.adjustDate': '新しい確認日を提案 →', 'sugg.closeHit': '確定を提案 —— 的中', 'sugg.closePartial': '確定を提案 —— 一部',
  'sugg.closeMiss': '確定を提案 —— 外れ', 'sugg.drop': '取り下げを提案',
  'sugg.accept': '受け入れる', 'sugg.note': 'メモする', 'sugg.detail': '詳細', 'sugg.dismiss': '却下',
  'sugg.evidence': '根拠', 'drag.reopenConfirm': 'この決定を再開して未決に戻しますか?',
  'reject': '不正確とマーク', 'reject.hint': '不正確 —— 削除し、次回 AI が避けるようにします。',
  'refresh': '更新', 'refresh.hint': '強制更新',
}
const de: Partial<Catalog> = {
  'panel.title': 'Entscheidungsprotokoll', 'col.candidates': 'Kandidaten', 'col.open': 'Offen', 'col.archive': 'Archiv',
  'sign.title': 'Diese Wette unterschreiben', 'sign.prediction': 'Vorhersage',
  'sign.confidence.low': 'Etwas sicher', 'sign.confidence.medium': 'Ziemlich sicher', 'sign.confidence.high': 'Sehr sicher',
  'sign.checkDate': 'Prüfen am', 'sign.submit': 'Wette unterschreiben',
  'verdict.q1': 'Ist es eingetreten?', 'verdict.hit': 'Treffer', 'verdict.partial': 'Teilweise', 'verdict.miss': 'Verfehlt',
  'verdict.q2': 'Unabhängig vom Ergebnis — würdest du wieder so entscheiden?', 'verdict.endorseYes': 'Ja', 'verdict.endorseNo': 'Nein',
  'verdict.submit': 'Schließen & archivieren',
  'score.samples': 'Stichproben gesammelt', 'score.calibration': 'Kalibrierung', 'card.new': 'Neue Entscheidung',
  'downgrade.toast': 'Für dich beiseitegelegt — jederzeit wieder öffnen.',
  'sign.confidenceLabel': 'Wie sicher bist du?', 'sign.triggers': 'Überdenken, wenn…', 'sign.triggersHint': 'z. B. ein Wettbewerber liefert zuerst',
  'sign.predictionRequired': 'Schreibe eine widerlegbare Vorhersage, um zu unterschreiben.',
  'sign.quotedLead': 'Du sagtest', 'sign.nominatedLead': 'Eine Vorhersage zum Festhalten — in deinen Worten',
  'sign.title.new': 'Neue Entscheidung', 'sign.titleLabel': 'Entscheidung',
  'verdict.locked': 'Beim Unterschreiben festgelegt', 'verdict.evidence': 'Belege', 'verdict.noEvidence': 'Noch keine Belege angehängt.',
  'score.empty': 'Bisher 0 Stichproben gesammelt', 'score.avoidance': 'Du weichst immer wieder aus', 'score.noVerdicts': 'Urteile zeigen hier deine Kalibrierung.',
  'col.candidatesEmpty': 'KI-vorgeschlagene Kandidaten landen hier.', 'col.openEmpty': 'Unterschriebene Wetten, die auf ihr Prüfdatum warten.',
  'col.archiveEmpty': 'Nach einem Urteil erscheinen erledigte Entscheidungen hier.',
  'card.daysLeft': 'Tage übrig', 'card.dueToday': 'heute fällig', 'card.overdue': 'überfällig',
  'card.stillEndorse': 'immer noch dafür',
  'badge.quoted': 'deine Worte', 'badge.nominated': 'KI-vorgeschlagen',
  'common.cancel': 'Abbrechen', 'common.loading': 'Wird geladen…', 'drag.invalid': 'Entscheidungen gehen nur vorwärts.',
  'review.start': 'Fällige Prüfung', 'review.of': 'von', 'review.decide': 'Ein Urteil fällen', 'review.skip': 'Vorerst überspringen',
  'review.title': 'Fällige Prüfung', 'review.downgraded': 'Du bist ein paar Mal nicht darauf zurückgekommen — ich habe es für dich beiseitegelegt. Jederzeit wieder öffnen.', 'review.continue': 'Weiter',
  'sugg.dueVerdict': 'Urteil fällig', 'sugg.due.hit': 'Sieht nach Treffer aus', 'sugg.due.partial': 'Sieht teilweise aus', 'sugg.due.miss': 'Sieht nach Verfehlung aus',
  'sugg.progress': 'Fortschritt', 'sugg.adjustDate': 'Neues Prüfdatum vorschlagen →', 'sugg.closeHit': 'Schließen vorschlagen — Treffer', 'sugg.closePartial': 'Schließen vorschlagen — teilweise',
  'sugg.closeMiss': 'Schließen vorschlagen — verfehlt', 'sugg.drop': 'Verwerfen vorschlagen',
  'sugg.accept': 'Annehmen', 'sugg.note': 'Notieren', 'sugg.detail': 'Details', 'sugg.dismiss': 'Verwerfen',
  'sugg.evidence': 'Belege', 'drag.reopenConfirm': 'Diese Entscheidung wieder öffnen und zurück zu Offen verschieben?',
  'reject': 'Als ungenau markieren', 'reject.hint': 'Nicht genau — entfernen und die KI dies künftig meiden lassen.',
  'refresh': 'Aktualisieren', 'refresh.hint': 'Aktualisierung erzwingen',
}
const registry: Record<string, Partial<Catalog>> = { en, zh, ja, de }
export function t(key: MessageKey): string {
  let locale = 'en'
  try { locale = bridge().locale } catch { /* dev */ }
  return registry[locale]?.[key] ?? en[key] ?? key
}
