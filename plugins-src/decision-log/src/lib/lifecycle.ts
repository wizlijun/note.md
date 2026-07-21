import { decisionId, nextSeq } from './id'
import type { OpenDecision, ArchivedDecision, Confidence, Outcome, Evidence, ScoreEvent, StateSnapshot, Trigger } from './model'

// caller injects `now` (ISO) so the module stays deterministic/testable.
export interface SignInput {
  title: string; prediction: string; confidence: Confidence; checkDate: string
  origin: 'agent' | 'manual'; created: string
  source_conv?: string; quote?: string; triggers?: Trigger[]; state?: StateSnapshot
  now?: string
}
export function sign(open: OpenDecision[], i: SignInput): { open: OpenDecision[]; event: ScoreEvent } {
  const id = decisionId(i.created, nextSeq(open.map((d) => d.id), i.created))
  const dec: OpenDecision = {
    id, title: i.title, prediction: i.prediction, confidence: i.confidence,
    'check-date': i.checkDate, created: i.created, origin: i.origin, strikes: 0,
    ...(i.source_conv ? { source_conv: i.source_conv } : {}),
    ...(i.quote ? { quote: i.quote } : {}),
    ...(i.triggers?.length ? { triggers: i.triggers } : {}),
    ...(i.state ? { state: i.state } : {}),
  }
  const event: ScoreEvent = { ts: i.now ?? i.created, event: 'create', id, confidence: i.confidence, ...(i.state ? { state: i.state } : {}) }
  return { open: [...open, dec], event }
}

export function manualCreate(open: OpenDecision[], i: Omit<SignInput, 'origin'>): { open: OpenDecision[]; event: ScoreEvent } {
  return sign(open, { ...i, origin: 'manual' })
}

export interface VerdictInput { outcome: Outcome; stillEndorse: boolean; resolved: string; evidence?: Evidence[]; now?: string }
export function verdict(open: OpenDecision[], id: string, v: VerdictInput): { open: OpenDecision[]; archived: ArchivedDecision; event: ScoreEvent } {
  const d = open.find((x) => x.id === id)
  if (!d) throw new Error(`verdict: id ${id} not open`)
  const archived: ArchivedDecision = {
    id: d.id, created: d.created, status: 'closed', prediction: d.prediction, confidence: d.confidence,
    outcome: v.outcome, 'still-endorse': v.stillEndorse, origin: d.origin,
    ...(v.evidence?.length ? { evidence: v.evidence } : {}),
    ...(d.state ? { state: d.state } : {}),
  }
  const event: ScoreEvent = { ts: v.now ?? v.resolved, event: 'verdict', id, confidence: d.confidence, outcome: v.outcome, still_endorse: v.stillEndorse, ...(d.state ? { state: d.state } : {}) }
  return { open: open.filter((x) => x.id !== id), archived, event }
}

export function incStrike(open: OpenDecision[], id: string, resolvedIfDowngrade: string, now?: string):
  { open: OpenDecision[]; archived?: ArchivedDecision; event?: ScoreEvent } {
  const d = open.find((x) => x.id === id)
  if (!d) return { open }
  const strikes = d.strikes + 1
  if (strikes >= 3) {
    const archived: ArchivedDecision = {
      id: d.id, created: d.created, status: 'downgraded', prediction: d.prediction, confidence: d.confidence,
      origin: d.origin, ...(d.state ? { state: d.state } : {}),
    }
    const event: ScoreEvent = { ts: now ?? resolvedIfDowngrade, event: 'downgrade', id, category: d.title }
    return { open: open.filter((x) => x.id !== id), archived, event }
  }
  return { open: open.map((x) => (x.id === id ? { ...x, strikes } : x)) }
}
