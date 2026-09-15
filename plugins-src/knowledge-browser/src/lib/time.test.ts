import { describe, expect, it } from 'vitest'
import { parseTimeValue, timeIntersects } from './time'

describe('time', () => {
  it('keeps absent, unknown and unstandardized values distinct', () => {
    expect(parseTimeValue(undefined, false).kind).toBe('not-applicable')
    expect(parseTimeValue(null).kind).toBe('unknown')
    expect(parseTimeValue('下季度').kind).toBe('unstandardized')
  })
  it('does not silently reverse invalid ranges and handles open intersection', () => {
    expect(parseTimeValue(['2026-09-16', '2026-09-15']).kind).toBe('invalid-range')
    expect(timeIntersects(parseTimeValue([null, '2026-09-15']), Date.parse('2026-09-01'), Date.parse('2026-09-02'))).toBe(true)
  })
})
