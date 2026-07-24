import { describe, it, expect } from 'vitest'
import { STAR_ANCHORS, anchorOf, starOf, normalizeConfidence, isConfidence, isOutcome } from './model'

describe('model', () => {
  it('exposes five star anchors', () => {
    expect(STAR_ANCHORS).toEqual([0.55, 0.65, 0.75, 0.85, 0.95])
    expect(anchorOf(1)).toBe(0.55)
    expect(anchorOf(5)).toBe(0.95)
  })
  it('starOf maps probabilities to nearest star (ties round up)', () => {
    expect(starOf(0.55)).toBe(1)
    expect(starOf(0.95)).toBe(5)
    expect(starOf(0.6)).toBe(2)   // legacy low midpoint
    expect(starOf(0.75)).toBe(3)  // legacy medium midpoint
    expect(starOf(0.9)).toBe(5)   // legacy high midpoint (tie → up)
    expect(starOf(0.51)).toBe(1)  // clamped
    expect(starOf(0.99)).toBe(5)  // clamped
  })
  it('normalizeConfidence accepts numeric 0-1 and legacy enums', () => {
    expect(normalizeConfidence(0.85)).toBe(0.85)
    expect(normalizeConfidence('low')).toBe(0.6)
    expect(normalizeConfidence('medium')).toBe(0.75)
    expect(normalizeConfidence('high')).toBe(0.9)
    expect(normalizeConfidence('x')).toBeNull()
    expect(normalizeConfidence(0)).toBeNull()
    expect(normalizeConfidence(1)).toBeNull()
    expect(normalizeConfidence(null)).toBeNull()
  })
  it('validates confidence and outcome', () => {
    expect(isConfidence('high')).toBe(true)
    expect(isConfidence(0.75)).toBe(true)
    expect(isConfidence('x')).toBe(false)
    expect(isOutcome('hit')).toBe(true)
    expect(isOutcome('nope')).toBe(false)
  })
})
