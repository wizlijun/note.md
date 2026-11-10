import { describe, expect, it } from 'vitest'
import { hitKey } from './hit-key'

describe('hitKey', () => {
  it('distinguishes hits by path and line range', () => {
    expect(hitKey({ path: 'a.md', line: 1, lineEnd: 2 })).toBe(hitKey({ path: 'a.md', line: 1, lineEnd: 2 }))
    expect(hitKey({ path: 'a.md', line: 1, lineEnd: 2 })).not.toBe(hitKey({ path: 'a.md', line: 1, lineEnd: 3 }))
    expect(hitKey({ path: 'a.md1', line: 1, lineEnd: 2 })).not.toBe(hitKey({ path: 'a.md', line: 11, lineEnd: 2 }))
  })
})
