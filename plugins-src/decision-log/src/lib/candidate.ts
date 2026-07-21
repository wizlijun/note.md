import { isConfidence, type Confidence, type Trigger, type Evidence, type StateSnapshot } from './model'

export interface NewCandidate {
  id: string; title: string
  prediction_source: 'quoted' | 'nominated'
  quote?: string
  prediction: string | null
  confidence: Confidence | null
  check_date?: string | null
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
export interface CandidateFile { date: string; new_candidates: NewCandidate[]; closures: Closure[] }

function validCandidate(c: any): c is NewCandidate {
  if (!c || typeof c.id !== 'string' || typeof c.title !== 'string') return false
  if (c.prediction_source !== 'quoted' && c.prediction_source !== 'nominated') return false
  if (c.prediction_source === 'quoted' && typeof c.quote !== 'string') return false // quoted 必带原话
  if (c.confidence != null && !isConfidence(c.confidence)) return false
  return true
}
function validClosure(c: any): c is Closure {
  return c && typeof c.decision_id === 'string' && (c.reason === 'due' || c.reason === 'trigger')
}

/** 宽容解析:整体 JSON 必须合法(否则 throw);单个不合法的候选/关闭项被静默丢弃。 */
export function parseCandidateFile(raw: string): CandidateFile {
  const obj = JSON.parse(raw)
  const date = typeof obj?.date === 'string' ? obj.date : ''
  const new_candidates = Array.isArray(obj?.new_candidates) ? obj.new_candidates.filter(validCandidate) : []
  const closures = Array.isArray(obj?.closures) ? obj.closures.filter(validClosure) : []
  return { date, new_candidates, closures }
}
