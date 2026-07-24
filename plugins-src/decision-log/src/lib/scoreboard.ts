import { normalizeConfidence, starOf, type Confidence, type Outcome, type ScoreEvent } from './model'

export function appendEvent(log: string, ev: ScoreEvent): string {
  const line = JSON.stringify(ev)
  return log ? `${log.endsWith('\n') ? log : log + '\n'}${line}\n` : `${line}\n`
}
export function parseLog(log: string): ScoreEvent[] {
  return log.split('\n').filter(Boolean).map((l) => {
    const e = JSON.parse(l) as ScoreEvent
    const c = normalizeConfidence(e.confidence)
    return c === null ? e : { ...e, confidence: c }
  })
}

/** Net-positive proper-ish decision score (v1.1, Metaculus-style baseline):
 *  score = max(0, round(10 + 40·log2(2p))), p = probability assigned to what
 *  happened (hit→conf, miss→1−conf, partial→0.5 ⇒ flat 10 participation pts).
 *  Every verdict earns ≥0 — participation is rewarded, miscalibration is never
 *  punished below zero (loss-aversion / retention, design review §1.3). */
export function scoreOf(confidence: Confidence, outcome: Outcome): number {
  const p = outcome === 'hit' ? confidence : outcome === 'miss' ? 1 - confidence : 0.5
  return Math.max(0, Math.round(10 + 40 * Math.log2(2 * p)))
}

export interface Scoreboard {
  /** Calibration buckets keyed by star level 1..5 (index 0 unused). */
  buckets: { hits: number; total: number }[]
  totalScore: number
  sampleCount: number
  avoidance: Record<string, number>
}
export function computeScoreboard(events: ScoreEvent[]): Scoreboard {
  const buckets = Array.from({ length: 6 }, () => ({ hits: 0, total: 0 }))
  const avoidance: Record<string, number> = {}
  let sampleCount = 0
  let totalScore = 0
  for (const e of events) {
    if (e.event === 'verdict' && typeof e.confidence === 'number' && e.outcome) {
      const b = buckets[starOf(e.confidence)]
      b.total += 1
      if (e.outcome === 'hit') b.hits += 1
      sampleCount += 1
      totalScore += e.score ?? scoreOf(e.confidence, e.outcome) // legacy events lack score
    }
    if (e.event === 'downgrade' && e.category) {
      avoidance[e.category] = (avoidance[e.category] ?? 0) + 1
    }
  }
  return { buckets, totalScore, sampleCount, avoidance }
}
