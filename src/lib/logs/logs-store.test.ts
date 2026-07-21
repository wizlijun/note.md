import { describe, it, expect } from 'vitest'
import { capLines, MAX_LINES } from './logs-store.svelte'
import type { LogLine } from './console-bridge'

function line(i: number): LogLine {
  return { ts: `${i}`, source: 'backend', category: 'core', level: 'info', message: `m${i}` }
}

describe('capLines', () => {
  it('keeps at most MAX_LINES, dropping the oldest', () => {
    const arr = Array.from({ length: MAX_LINES + 5 }, (_, i) => line(i))
    const capped = capLines(arr)
    expect(capped.length).toBe(MAX_LINES)
    expect(capped[capped.length - 1].message).toBe(`m${MAX_LINES + 4}`)
    expect(capped[0].message).toBe('m5')
  })

  it('returns the array unchanged when under the cap', () => {
    const arr = [line(1), line(2)]
    expect(capLines(arr)).toBe(arr)
  })
})
