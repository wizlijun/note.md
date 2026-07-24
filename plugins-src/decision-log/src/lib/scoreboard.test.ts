import { describe, it, expect } from 'vitest'
import { appendEvent, parseLog, computeScoreboard, scoreOf } from './scoreboard'
import type { ScoreEvent } from './model'

const verdicts: ScoreEvent[] = [
  { ts: '1', event: 'verdict', id: 'a', confidence: 0.95, outcome: 'hit', still_endorse: true },
  { ts: '2', event: 'verdict', id: 'b', confidence: 0.95, outcome: 'miss', still_endorse: true },
  { ts: '3', event: 'verdict', id: 'c', confidence: 0.55, outcome: 'hit', still_endorse: false },
  { ts: '4', event: 'create', id: 'd', confidence: 0.75 },
  { ts: '5', event: 'downgrade', id: 'e', category: '招聘' },
]

describe('scoreboard', () => {
  it('appendEvent produces one JSON line appended to prior log', () => {
    const log = appendEvent('', verdicts[0])
    const log2 = appendEvent(log, verdicts[1])
    expect(parseLog(log2)).toHaveLength(2)
    expect(log2.endsWith('\n')).toBe(true)
  })
  it('parseLog normalizes legacy enum confidence to numeric', () => {
    const legacy = '{"ts":"1","event":"verdict","id":"a","confidence":"high","outcome":"hit"}\n'
    expect(parseLog(legacy)[0].confidence).toBe(0.9)
  })
  it('calibration buckets = hits/total per star, from verdict events only', () => {
    const s = computeScoreboard(verdicts)
    expect(s.buckets[5]).toEqual({ hits: 1, total: 2 })   // 0.95 hit + miss
    expect(s.buckets[1]).toEqual({ hits: 1, total: 1 })   // 0.55 hit
    expect(s.buckets[3]).toEqual({ hits: 0, total: 0 })   // create doesn't count
  })
  it('sampleCount counts resolved verdicts only', () => {
    expect(computeScoreboard(verdicts).sampleCount).toBe(3)
  })
  it('avoidance tallies downgrade categories', () => {
    expect(computeScoreboard(verdicts).avoidance).toEqual({ '招聘': 1 })
  })

  describe('scoreOf (net-positive proper score)', () => {
    it('participation floor: p=0.5 → 10 pts; partial always 10', () => {
      expect(scoreOf(0.5, 'hit')).toBe(10)
      expect(scoreOf(0.95, 'partial')).toBe(10)
    })
    it('confident hit earns more than timid hit', () => {
      expect(scoreOf(0.95, 'hit')).toBeGreaterThan(scoreOf(0.55, 'hit'))
      expect(scoreOf(0.95, 'hit')).toBe(47)
    })
    it('never negative: confident miss floors at 0', () => {
      expect(scoreOf(0.95, 'miss')).toBe(0)
      expect(scoreOf(0.55, 'miss')).toBeGreaterThan(0) // humble miss keeps a little
    })
  })

  it('totalScore sums frozen scores, deriving for legacy events without score', () => {
    const s = computeScoreboard(verdicts)
    expect(s.totalScore).toBe(scoreOf(0.95, 'hit') + scoreOf(0.95, 'miss') + scoreOf(0.55, 'hit'))
    const frozen: ScoreEvent[] = [{ ts: '1', event: 'verdict', id: 'a', confidence: 0.95, outcome: 'hit', score: 99 }]
    expect(computeScoreboard(frozen).totalScore).toBe(99) // frozen wins over recompute
  })
})
