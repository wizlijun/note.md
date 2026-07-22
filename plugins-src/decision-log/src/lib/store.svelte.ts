import { loadBoard, saveBoard, appendArchive, appendScore, loadScore, loadCandidates, loadArchives, consumeDiaryItem } from './host-io'
import { sign, verdict, incStrike, manualCreate, type SignInput, type VerdictInput } from './lifecycle'
import { applyNote, applyAdjustCheckDate, applyDrop } from './edits'
import { computeScoreboard, type Scoreboard } from './scoreboard'
import type { OpenDecision, ArchivedDecision } from './model'
import type { CandidateFile, EditDecision } from './candidate'

export const state = $state<{ open: OpenDecision[]; candidates: CandidateFile[]; archived: ArchivedDecision[]; score: Scoreboard | null; loading: boolean }>({
  open: [], candidates: [], archived: [], score: null, loading: true,
})

export async function refresh(): Promise<void> {
  state.loading = true
  state.open = await loadBoard()
  state.candidates = await loadCandidates()
  state.archived = await loadArchives()
  state.score = computeScoreboard(await loadScore())
  state.loading = false
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
export async function doStrike(id: string, resolved: string): Promise<void> {
  const r = incStrike(state.open, id, resolved)
  state.open = r.open
  await saveBoard(state.open)
  if (r.archived) { await appendArchive(resolved, r.archived); state.archived = await loadArchives() }
  if (r.event) { await appendScore(r.event); state.score = computeScoreboard(await loadScore()) }
}

// ── agent edit_decisions 建议:接受 / 忽略 ────────────────────────────────────

/** 接受一条 edit 建议。close-* 需要 still-endorse,不在此处理(交给 UI 打开裁决框预填)。 */
export async function doAcceptEdit(edit: EditDecision, date: string): Promise<void> {
  switch (edit.suggested_action) {
    case 'note':
      state.open = applyNote(state.open, edit.decision_id, date, edit.summary)
      await saveBoard(state.open)
      break
    case 'adjust-check-date':
      if (edit.new_check_date) {
        state.open = applyAdjustCheckDate(state.open, edit.decision_id, edit.new_check_date)
        await saveBoard(state.open)
      }
      break
    case 'drop': {
      const r = applyDrop(state.open, edit.decision_id, date)
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
