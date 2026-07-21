import { describe, it, expect } from 'vitest'
import { appendEvent, parseLog, computeScoreboard } from './scoreboard'
import type { ScoreEvent } from './model'

const verdicts: ScoreEvent[] = [
  { ts: '1', event: 'verdict', id: 'a', confidence: 'high', outcome: 'hit', still_endorse: true },
  { ts: '2', event: 'verdict', id: 'b', confidence: 'high', outcome: 'miss', still_endorse: true },
  { ts: '3', event: 'verdict', id: 'c', confidence: 'low', outcome: 'hit', still_endorse: false },
  { ts: '4', event: 'create', id: 'd', confidence: 'medium' },
  { ts: '5', event: 'downgrade', id: 'e', category: '招聘' },
]

describe('scoreboard', () => {
  it('appendEvent produces one JSON line appended to prior log', () => {
    const log = appendEvent('', verdicts[0])
    const log2 = appendEvent(log, verdicts[1])
    expect(parseLog(log2)).toHaveLength(2)
    expect(log2.endsWith('\n')).toBe(true)
  })
  it('calibration buckets = hits/total per confidence, from verdict events only', () => {
    const s = computeScoreboard(verdicts)
    expect(s.buckets.high).toEqual({ hits: 1, total: 2 })   // hit + miss
    expect(s.buckets.low).toEqual({ hits: 1, total: 1 })
    expect(s.buckets.medium).toEqual({ hits: 0, total: 0 }) // create doesn't count
  })
  it('sampleCount counts resolved verdicts only', () => {
    expect(computeScoreboard(verdicts).sampleCount).toBe(3)
  })
  it('avoidance tallies downgrade categories', () => {
    expect(computeScoreboard(verdicts).avoidance).toEqual({ '招聘': 1 })
  })
})
