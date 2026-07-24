// Confidence is a numeric probability (0–1) anchored to five levels, rendered
// as the upper half of a 10-cell probability bar (5 locked 0–50% baseline + 5
// selectable). v1.1, research review 2026-07-24: coarse low/medium/high tiers
// sacrifice accuracy AND pollute calibration measurement — store numbers.
// Legacy enum values (low/medium/high) map to their spec §6 midpoints on read;
// writes are always numeric. (starOf/STAR_ANCHORS name the 5 levels — the "star"
// term is historical; the pixels are now bar cells.)
export const STAR_ANCHORS = [0.55, 0.65, 0.75, 0.85, 0.95] as const
export type Confidence = number

const LEGACY: Record<string, number> = { low: 0.6, medium: 0.75, high: 0.9 }

/** Accepts numeric (0–1 exclusive of 0/1-ish bounds) or legacy enum; null otherwise. */
export function normalizeConfidence(x: unknown): Confidence | null {
  if (typeof x === 'number' && x > 0 && x < 1) return x
  if (typeof x === 'string' && x in LEGACY) return LEGACY[x]
  return null
}
export function isConfidence(x: unknown): x is Confidence | 'low' | 'medium' | 'high' {
  return normalizeConfidence(x) !== null
}
/** Star level (1..5) whose anchor is nearest to p (ties round up: 0.6→2★, 0.9→5★).
 *  The epsilon keeps float noise (0.6−0.55 = 0.04999…) from flipping a tie down. */
export function starOf(p: Confidence): number {
  return Math.min(5, Math.max(1, Math.round((p - STAR_ANCHORS[0]) / 0.1 + 1e-9) + 1))
}
export function anchorOf(star: number): Confidence {
  return STAR_ANCHORS[Math.min(5, Math.max(1, star)) - 1]
}

export const OUTCOMES = ['hit', 'partial', 'miss'] as const
export type Outcome = (typeof OUTCOMES)[number]
export type Status = 'closed' | 'dropped' | 'downgraded'
export function isOutcome(x: unknown): x is Outcome {
  return typeof x === 'string' && (OUTCOMES as readonly string[]).includes(x)
}

// SDG Decision Quality six elements — optional third verdict question when the
// user answers "would NOT decide this way again" (outcome-independent hygiene).
export const WEAKEST_ELEMENTS = ['frame', 'alternatives', 'information', 'values', 'reasoning', 'commitment'] as const
export type WeakestElement = (typeof WEAKEST_ELEMENTS)[number]

// Review-pass skip reasons (v1.1): only "avoid" counts toward strikes;
// not-yet adjusts the check date, irrelevant drops without guilt.
export type SkipReason = 'not-yet' | 'avoid' | 'irrelevant'

export interface StateSnapshot { time?: string; speech_rate?: 'slow'|'normal'|'fast'; calendar_density?: 'low'|'medium'|'high' }
export interface Trigger { if: string; source?: string }
export interface Evidence { conv_id?: string; quote: string; time?: string }

/** 未决看板中的一条(front-matter decisions[] 元素)。 */
export interface OpenDecision {
  id: string
  title: string
  prediction: string        // 🔒 签字后不可改
  confidence: Confidence     // 🔒 numeric 0–1(legacy enums normalized on read)
  'check-date': string
  created: string            // 🔒
  origin: 'agent' | 'manual' // 🔒
  source_conv?: string
  quote?: string             // 🔒 来自 quoted 候选
  premortem?: string         // 🔒 失败预想(确定性措辞采集)
  alternatives?: string[]    // 🔒 落选备选项
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
  'weakest-element'?: WeakestElement // 可选:still-endorse=false 时的第三问
  premortem?: string
  alternatives?: string[]
  evidence?: Evidence[]
  origin: 'agent' | 'manual'
  state?: StateSnapshot
}

export interface ScoreEvent {
  ts: string
  event: 'create' | 'verdict' | 'downgrade' | 'adjust' | 'reopen' | 'skip'
  id: string
  confidence?: Confidence
  outcome?: Outcome
  still_endorse?: boolean
  weakest_element?: WeakestElement
  score?: number             // verdict 事件:净正和决策分,append 时冻结
  reason?: SkipReason        // skip 事件
  category?: string
  state?: StateSnapshot
}

/** Normalize a decision-ish record read from disk (legacy enum confidence → numeric). */
export function normalizeRecordConfidence<T extends { confidence?: unknown }>(d: T): T {
  const c = normalizeConfidence(d.confidence)
  return c === null ? d : { ...d, confidence: c }
}
