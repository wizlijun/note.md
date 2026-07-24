import { loadBoard, saveBoard, appendArchive, appendScore, loadScore, loadCandidates, loadArchives, consumeDiaryItem, removeArchived, appendRejected } from './host-io'
import { sign, verdict, skip, manualCreate, type SignInput, type VerdictInput } from './lifecycle'
import { applyNote, applyAdjustCheckDate, applyDrop } from './edits'
import { computeScoreboard, type Scoreboard } from './scoreboard'
import type { OpenDecision, ArchivedDecision, SkipReason } from './model'
import type { CandidateFile, EditDecision, NewCandidate } from './candidate'

export const state = $state<{ open: OpenDecision[]; candidates: CandidateFile[]; archived: ArchivedDecision[]; score: Scoreboard | null; loading: boolean }>({
  open: [], candidates: [], archived: [], score: null, loading: true,
})

// Signature of the last committed board snapshot. refreshIfChanged() compares
// against it so background polling only reassigns state (→ re-render) when the
// underlying vault data actually changed — avoids flicker on unchanged polls.
let lastSig = ''

type Snapshot = { open: OpenDecision[]; candidates: CandidateFile[]; archived: ArchivedDecision[]; score: Scoreboard | null }

// Read every board source once. Pure I/O — no state mutation, so callers decide
// whether/when to commit the snapshot.
async function loadAll(): Promise<Snapshot> {
  const [open, candidates, archived, rawScore] = await Promise.all([
    loadBoard(), loadCandidates(), loadArchives(), loadScore(),
  ])
  return { open, candidates, archived, score: computeScoreboard(rawScore) }
}

function commit(s: Snapshot): void {
  state.open = s.open
  state.candidates = s.candidates
  state.archived = s.archived
  state.score = s.score
  lastSig = JSON.stringify(s)
}

/** Force refresh: always reload and reassign state (manual button / first mount).
 *  Toggles state.loading. */
export async function refresh(): Promise<void> {
  state.loading = true
  const s = await loadAll()
  commit(s)
  state.loading = false
}

/** Background refresh: reload and only reassign state when the snapshot differs
 *  from the last committed one. Never touches state.loading (silent). */
export async function refreshIfChanged(): Promise<void> {
  const s = await loadAll()
  const sig = JSON.stringify(s)
  if (sig !== lastSig) commit(s)
}
/** consume?: 成功后把来源候选文件里对应 pending 项标 accepted(向后兼容:不传则不消费)。 */
export async function doSign(input: SignInput, consume?: { date: string; candidateId: string }): Promise<void> {
  const r = sign(state.open, input)
  state.open = r.open
  await saveBoard(state.open)
  await appendScore(r.event)
  state.score = computeScoreboard(await loadScore())
  if (consume) { await consumeDiaryItem(consume.date, 'new_candidates', consume.candidateId, 'accepted'); await refresh() }
}
export async function doManualCreate(input: Omit<SignInput, 'origin'>): Promise<void> {
  const r = manualCreate(state.open, input)
  state.open = r.open
  await saveBoard(state.open)
  await appendScore(r.event)
  state.score = computeScoreboard(await loadScore())
}
export async function doVerdict(id: string, v: VerdictInput, consume?: { date: string }): Promise<void> {
  const r = verdict(state.open, id, v)
  state.open = r.open
  await saveBoard(state.open)
  await appendArchive(v.resolved, r.archived)
  await appendScore(r.event)
  state.archived = await loadArchives()
  state.score = computeScoreboard(await loadScore())
  if (consume) { await consumeDiaryItem(consume.date, 'closures', id, 'accepted'); await refresh() }
}
/** 重开:把一条归档决策捞回未决列。从归档文件移除该条,重建 OpenDecision(id/prediction/
 *  confidence/created/origin 沿用;check-date=今天+14 天;strikes=0;title 取 prediction 前 20 字
 *  或 id 兜底),加回 open 并写盘,记一条 reopen 记分事件。找不到该归档 → no-op。 */
export async function doReopen(archivedId: string): Promise<void> {
  const arch = await removeArchived(archivedId)
  if (!arch) return
  const checkDate = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10)
  const title = (arch.prediction ?? '').trim().slice(0, 20) || arch.id
  const dec: OpenDecision = {
    id: arch.id, title, prediction: arch.prediction, confidence: arch.confidence,
    'check-date': checkDate, created: arch.created, origin: arch.origin, strikes: 0,
    ...(arch.state ? { state: arch.state } : {}),
  }
  state.open = [...state.open, dec]
  await saveBoard(state.open)
  await appendScore({ ts: new Date().toISOString(), event: 'reopen', id: arch.id, confidence: arch.confidence })
  state.archived = await loadArchives()
  state.score = computeScoreboard(await loadScore())
}
/** 到期检查里的"跳过":带原因(v1.1)。not-yet 改期、irrelevant 直接 drop、
 *  avoid 计 strike(第 3 次降级)。返回是否触发了降级(供 UI 显示教练文案)。 */
export async function doSkip(id: string, reason: SkipReason, today: string): Promise<boolean> {
  const r = skip(state.open, id, reason, today)
  state.open = r.open
  await saveBoard(state.open)
  let downgraded = false
  if (r.archived) {
    await appendArchive(today, r.archived)
    state.archived = await loadArchives()
    downgraded = r.archived.status === 'downgraded'
  }
  for (const ev of r.events) await appendScore(ev)
  state.score = computeScoreboard(await loadScore())
  return downgraded
}

// ── agent edit_decisions 建议:接受 / 忽略 ────────────────────────────────────

/** 接受一条 edit 建议。close-* 需要 still-endorse,不在此处理(交给 UI 打开裁决框预填)。
 *  只有真正改动了看板(或 drop 成功)才 consumeDiaryItem + refresh;无效操作直接返回不标 accepted。 */
export async function doAcceptEdit(edit: EditDecision, date: string): Promise<void> {
  switch (edit.suggested_action) {
    case 'note': {
      // 目标 decision 不在 open 列表 → 无效,不消费
      if (!state.open.some((d) => d.id === edit.decision_id)) {
        console.warn(`[decision-log] doAcceptEdit note: decision ${edit.decision_id} not open, skipping`)
        return
      }
      state.open = applyNote(state.open, edit.decision_id, date, edit.summary)
      await saveBoard(state.open)
      break
    }
    case 'adjust-check-date': {
      // new_check_date 为空 → 无效,不消费
      if (!edit.new_check_date) {
        console.warn(`[decision-log] doAcceptEdit adjust-check-date: new_check_date missing, skipping`)
        return
      }
      // 目标 decision 不在 open 列表 → 无效,不消费
      if (!state.open.some((d) => d.id === edit.decision_id)) {
        console.warn(`[decision-log] doAcceptEdit adjust-check-date: decision ${edit.decision_id} not open, skipping`)
        return
      }
      state.open = applyAdjustCheckDate(state.open, edit.decision_id, edit.new_check_date)
      await saveBoard(state.open)
      break
    }
    case 'drop': {
      // applyDrop 找不到 id 会抛错,catch 后不消费
      let r: ReturnType<typeof applyDrop>
      try {
        r = applyDrop(state.open, edit.decision_id, date)
      } catch (e) {
        console.warn(`[decision-log] doAcceptEdit drop failed:`, e)
        return
      }
      state.open = r.open
      await saveBoard(state.open)
      await appendArchive(date, r.archived)
      state.archived = await loadArchives()
      break
    }
    case 'close-hit':
    case 'close-partial':
    case 'close-miss':
      throw new Error(`doAcceptEdit: ${edit.suggested_action} needs a verdict; open the verdict dialog instead`)
  }
  await consumeDiaryItem(date, 'edit_decisions', edit.decision_id, 'accepted')
  await refresh()
}

export async function doDismissEdit(edit: EditDecision, date: string): Promise<void> {
  await consumeDiaryItem(date, 'edit_decisions', edit.decision_id, 'dismissed')
  await refresh()
}
export async function doDismissClosure(decision_id: string, date: string): Promise<void> {
  await consumeDiaryItem(date, 'closures', decision_id, 'dismissed')
  await refresh()
}
export async function doDismissCandidate(id: string, date: string): Promise<void> {
  await consumeDiaryItem(date, 'new_candidates', id, 'dismissed')
  await refresh()
}

// ── 删除(不准):记入负向存储 decision/_rejected.json + 从来源文件消费(dismissed)隐藏 ──────

/** 删候选:用户认为该新决策候选不准。记负向 + dismiss 来源 + refresh。 */
export async function doRejectCandidate(candidate: NewCandidate, date: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  await appendRejected({
    type: 'candidate', title: candidate.title,
    ...(candidate.quote ? { quote: candidate.quote } : {}),
    rejected_at: today,
  })
  await consumeDiaryItem(date, 'new_candidates', candidate.id, 'dismissed')
  await refresh()
}

/** 删裁决建议:用户认为该 closure 建议不准。记负向 + dismiss 来源 + refresh。 */
export async function doRejectClosure(decision_id: string, date: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  await appendRejected({ type: 'closure', decision_id, rejected_at: today })
  await consumeDiaryItem(date, 'closures', decision_id, 'dismissed')
  await refresh()
}

/** 删 edit 建议:用户认为该进展/编辑建议不准。记负向 + dismiss 来源 + refresh。 */
export async function doRejectEdit(edit: EditDecision, date: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  await appendRejected({
    type: 'edit', decision_id: edit.decision_id, kind: edit.kind, summary: edit.summary,
    rejected_at: today,
  })
  await consumeDiaryItem(date, 'edit_decisions', edit.decision_id, 'dismissed')
  await refresh()
}
