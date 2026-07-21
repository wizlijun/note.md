import { CONFIDENCE_BUCKETS, type Confidence, type ScoreEvent } from './model'

export function appendEvent(log: string, ev: ScoreEvent): string {
  const line = JSON.stringify(ev)
  return log ? `${log.endsWith('\n') ? log : log + '\n'}${line}\n` : `${line}\n`
}
export function parseLog(log: string): ScoreEvent[] {
  return log.split('\n').filter(Boolean).map((l) => JSON.parse(l) as ScoreEvent)
}

export interface Scoreboard {
  buckets: Record<Confidence, { hits: number; total: number }>
  sampleCount: number
  avoidance: Record<string, number>
}
export function computeScoreboard(events: ScoreEvent[]): Scoreboard {
  const buckets = Object.fromEntries(CONFIDENCE_BUCKETS.map((b) => [b, { hits: 0, total: 0 }])) as Scoreboard['buckets']
  const avoidance: Record<string, number> = {}
  let sampleCount = 0
  for (const e of events) {
    if (e.event === 'verdict' && e.confidence) {
      buckets[e.confidence].total += 1
      if (e.outcome === 'hit') buckets[e.confidence].hits += 1
      sampleCount += 1
    }
    if (e.event === 'downgrade' && e.category) {
      avoidance[e.category] = (avoidance[e.category] ?? 0) + 1
    }
  }
  return { buckets, sampleCount, avoidance }
}
