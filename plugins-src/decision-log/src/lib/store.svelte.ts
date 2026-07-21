import { loadBoard, saveBoard, appendArchive, appendScore, loadScore, loadCandidates } from './host-io'
import { sign, verdict, incStrike, manualCreate, type SignInput, type VerdictInput } from './lifecycle'
import { computeScoreboard, type Scoreboard } from './scoreboard'
import type { OpenDecision } from './model'
import type { CandidateFile } from './candidate'

export const state = $state<{ open: OpenDecision[]; candidates: CandidateFile[]; score: Scoreboard | null; loading: boolean }>({
  open: [], candidates: [], score: null, loading: true,
})

export async function refresh(): Promise<void> {
  state.loading = true
  state.open = await loadBoard()
  state.candidates = await loadCandidates()
  state.score = computeScoreboard(await loadScore())
  state.loading = false
}
export async function doSign(input: SignInput): Promise<void> {
  const r = sign(state.open, input)
  state.open = r.open
  await saveBoard(state.open)
  await appendScore(r.event)
  state.score = computeScoreboard(await loadScore())
}
export async function doManualCreate(input: Omit<SignInput, 'origin'>): Promise<void> {
  const r = manualCreate(state.open, input)
  state.open = r.open
  await saveBoard(state.open)
  await appendScore(r.event)
  state.score = computeScoreboard(await loadScore())
}
export async function doVerdict(id: string, v: VerdictInput): Promise<void> {
  const r = verdict(state.open, id, v)
  state.open = r.open
  await saveBoard(state.open)
  await appendArchive(v.resolved, r.archived)
  await appendScore(r.event)
  state.score = computeScoreboard(await loadScore())
}
export async function doStrike(id: string, resolved: string): Promise<void> {
  const r = incStrike(state.open, id, resolved)
  state.open = r.open
  await saveBoard(state.open)
  if (r.archived) await appendArchive(resolved, r.archived)
  if (r.event) { await appendScore(r.event); state.score = computeScoreboard(await loadScore()) }
}
