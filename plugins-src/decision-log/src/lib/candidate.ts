import { normalizeConfidence, type Confidence, type Trigger, type Evidence, type StateSnapshot } from './model'

export interface NewCandidate {
  id: string; title: string
  prediction_source: 'quoted' | 'nominated'
  quote?: string
  prediction: string | null
  confidence: Confidence | null   // normalized numeric (accepts number or legacy enum in JSON)
  check_date?: string | null
  premortem_hint?: string         // agent-nominated premortem draft(可选)
  alternatives?: string[]         // agent-nominated落选备选项(可选)
  triggers?: Trigger[]
  state?: StateSnapshot
  source?: Evidence
}
export interface Closure {
  decision_id: string
  reason: 'due' | 'trigger'
  suggested_outcome?: 'hit' | 'partial' | 'miss'
  evidence?: Evidence[]
}
export type EditKind = 'progress' | 'breakthrough' | 'resolved' | 'abandoned'
export type EditAction = 'note' | 'adjust-check-date' | 'close-hit' | 'close-partial' | 'close-miss' | 'drop'
export interface EditDecision {
  decision_id: string; kind: EditKind; summary: string
  suggested_action: EditAction; new_check_date?: string; evidence?: Evidence[]
}

const EDIT_KINDS: readonly EditKind[] = ['progress', 'breakthrough', 'resolved', 'abandoned']
const EDIT_ACTIONS: readonly EditAction[] = ['note', 'adjust-check-date', 'close-hit', 'close-partial', 'close-miss', 'drop']

export interface CandidateFile { date: string; fileDate: string; new_candidates: NewCandidate[]; closures: Closure[]; edit_decisions: EditDecision[] }

/** 建议已被消费(accepted/dismissed)的项不再返回;只保留 pending 或缺失 status 的。 */
function isPending(c: any): boolean {
  return c == null || c.status == null || c.status === 'pending'
}

function validCandidate(c: any): c is NewCandidate {
  if (!c || typeof c.id !== 'string' || typeof c.title !== 'string') return false
  if (c.prediction_source !== 'quoted' && c.prediction_source !== 'nominated') return false
  if (c.prediction_source === 'quoted' && typeof c.quote !== 'string') return false // quoted 必带原话
  if (c.confidence != null && normalizeConfidence(c.confidence) === null) return false
  return true
}

/** Coerce lenient candidate fields to canonical form (numeric confidence,
 *  string[] alternatives, string premortem_hint) — drops malformed extras. */
function canonCandidate(c: NewCandidate & { confidence: unknown }): NewCandidate {
  const conf = normalizeConfidence(c.confidence)
  const alts = Array.isArray((c as any).alternatives)
    ? (c as any).alternatives.filter((a: unknown) => typeof a === 'string' && a.trim()).map((a: string) => a.trim())
    : undefined
  const pm = typeof (c as any).premortem_hint === 'string' && (c as any).premortem_hint.trim()
    ? (c as any).premortem_hint.trim() : undefined
  return {
    ...c,
    confidence: conf,
    ...(alts?.length ? { alternatives: alts } : { alternatives: undefined }),
    ...(pm ? { premortem_hint: pm } : { premortem_hint: undefined }),
  }
}
function validClosure(c: any): c is Closure {
  return c && typeof c.decision_id === 'string' && (c.reason === 'due' || c.reason === 'trigger')
}
function validEdit(c: any): c is EditDecision {
  if (!c || typeof c.decision_id !== 'string' || c.decision_id.length === 0) return false
  if (!EDIT_KINDS.includes(c.kind)) return false
  if (!EDIT_ACTIONS.includes(c.suggested_action)) return false
  return true
}

/** 宽容解析:整体 JSON 必须合法(否则 throw);单个不合法的项被静默丢弃;已消费(非 pending)的项不返回。
 *  注:fileDate 由调用方(loadCandidates)在解析后补上,此处留空串占位。 */
export function parseCandidateFile(raw: string): CandidateFile {
  const obj = JSON.parse(raw)
  const date = typeof obj?.date === 'string' ? obj.date : ''
  const new_candidates = Array.isArray(obj?.new_candidates)
    ? obj.new_candidates.filter(isPending).filter(validCandidate).map(canonCandidate)
    : []
  const closures = Array.isArray(obj?.closures) ? obj.closures.filter(isPending).filter(validClosure) : []
  const edit_decisions = Array.isArray(obj?.edit_decisions) ? obj.edit_decisions.filter(isPending).filter(validEdit) : []
  return { date, fileDate: '', new_candidates, closures, edit_decisions }
}
