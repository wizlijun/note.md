export const CONFIDENCE_BUCKETS = ['low', 'medium', 'high'] as const
export type Confidence = (typeof CONFIDENCE_BUCKETS)[number]
export const OUTCOMES = ['hit', 'partial', 'miss'] as const
export type Outcome = (typeof OUTCOMES)[number]
export type Status = 'closed' | 'dropped' | 'downgraded'

const MID: Record<Confidence, number> = { low: 0.6, medium: 0.75, high: 0.9 }
export function confidenceMidpoint(c: Confidence): number { return MID[c] }
export function isConfidence(x: unknown): x is Confidence {
  return typeof x === 'string' && (CONFIDENCE_BUCKETS as readonly string[]).includes(x)
}
export function isOutcome(x: unknown): x is Outcome {
  return typeof x === 'string' && (OUTCOMES as readonly string[]).includes(x)
}

export interface StateSnapshot { time?: string; speech_rate?: 'slow'|'normal'|'fast'; calendar_density?: 'low'|'medium'|'high' }
export interface Trigger { if: string; source?: string }
export interface Evidence { conv_id?: string; quote: string; time?: string }

/** 未决看板中的一条(front-matter decisions[] 元素)。 */
export interface OpenDecision {
  id: string
  title: string
  prediction: string        // 🔒 签字后不可改
  confidence: Confidence     // 🔒
  'check-date': string
  created: string            // 🔒
  origin: 'agent' | 'manual' // 🔒
  source_conv?: string
  quote?: string             // 🔒 来自 quoted 候选
  strikes: number            // 0..3
  triggers?: Trigger[]
  state?: StateSnapshot      // 🔒
  progress?: { date: string; text: string }[]  // agent/手动追加的进展笔记(非 🔒)
}

/** 归档记录(archive front-matter decisions[] 元素)。 */
export interface ArchivedDecision {
  id: string
  created: string
  status: Status
  prediction: string
  confidence: Confidence
  outcome?: Outcome          // status=closed 必填
  'still-endorse'?: boolean  // status=closed 必填
  evidence?: Evidence[]
  origin: 'agent' | 'manual'
  state?: StateSnapshot
}

export interface ScoreEvent {
  ts: string
  event: 'create' | 'verdict' | 'downgrade' | 'adjust' | 'reopen'
  id: string
  confidence?: Confidence
  outcome?: Outcome
  still_endorse?: boolean
  category?: string
  state?: StateSnapshot
}
