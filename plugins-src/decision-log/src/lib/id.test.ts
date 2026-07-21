import { describe, it, expect } from 'vitest'
import { decisionId, nextSeq } from './id'

describe('id', () => {
  it('builds date-based decision id with sequence, no LLM', () => {
    expect(decisionId('2026-07-21', 1)).toBe('2026-07-21-01')
    expect(decisionId('2026-07-21', 12)).toBe('2026-07-21-12')
  })
  it('nextSeq picks max existing same-day seq + 1', () => {
    expect(nextSeq(['2026-07-21-01', '2026-07-21-03', '2026-07-20-09'], '2026-07-21')).toBe(4)
    expect(nextSeq([], '2026-07-21')).toBe(1)
  })
})
