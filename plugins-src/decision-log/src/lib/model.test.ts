import { describe, it, expect } from 'vitest'
import { CONFIDENCE_BUCKETS, confidenceMidpoint, isConfidence, isOutcome } from './model'

describe('model', () => {
  it('exposes three confidence buckets in order', () => {
    expect(CONFIDENCE_BUCKETS).toEqual(['low', 'medium', 'high'])
  })
  it('maps buckets to calibration midpoints', () => {
    expect(confidenceMidpoint('low')).toBe(0.6)
    expect(confidenceMidpoint('medium')).toBe(0.75)
    expect(confidenceMidpoint('high')).toBe(0.9)
  })
  it('validates enums', () => {
    expect(isConfidence('high')).toBe(true)
    expect(isConfidence('x')).toBe(false)
    expect(isOutcome('hit')).toBe(true)
    expect(isOutcome('nope')).toBe(false)
  })
})
