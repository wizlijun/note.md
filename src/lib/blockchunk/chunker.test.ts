import { describe, it, expect } from 'vitest'
import {
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_CHARS,
  CHUNK_WINDOW_CHARS,
  findBestCutoff,
} from './chunker'
import type { BreakPoint } from './breakpoints'
import type { CodeFenceRegion } from './codefences'

describe('chunk constants', () => {
  it('uses the spec values: 600 tokens / 0 overlap / 2400 chars / 800 window', () => {
    expect(CHUNK_SIZE_TOKENS).toBe(600)
    expect(CHUNK_OVERLAP_TOKENS).toBe(0)
    expect(CHUNK_SIZE_CHARS).toBe(2400)
    expect(CHUNK_WINDOW_CHARS).toBe(800)
  })
})

describe('findBestCutoff', () => {
  it('prefers higher-scoring break points', () => {
    const bp: BreakPoint[] = [
      { pos: 100, score: 1, type: 'newline' },
      { pos: 150, score: 100, type: 'h1' },
      { pos: 180, score: 20, type: 'blank' },
    ]
    expect(findBestCutoff(bp, 200, 100, 0.7)).toBe(150)
  })

  it('h2 at window edge beats blank near target due to squared decay', () => {
    const bp: BreakPoint[] = [
      { pos: 100, score: 90, type: 'h2' },
      { pos: 195, score: 20, type: 'blank' },
    ]
    expect(findBestCutoff(bp, 200, 100, 0.7)).toBe(100)
  })

  it('high score easily overcomes distance', () => {
    const bp: BreakPoint[] = [
      { pos: 150, score: 100, type: 'h1' },
      { pos: 195, score: 1, type: 'newline' },
    ]
    expect(findBestCutoff(bp, 200, 100, 0.7)).toBe(150)
  })

  it('returns target when no break points are in window', () => {
    const bp: BreakPoint[] = [{ pos: 10, score: 100, type: 'h1' }]
    expect(findBestCutoff(bp, 200, 100, 0.7)).toBe(200)
  })

  it('skips break points that fall inside code fences', () => {
    const bp: BreakPoint[] = [
      { pos: 150, score: 100, type: 'h1' },
      { pos: 180, score: 20, type: 'blank' },
    ]
    const fences: CodeFenceRegion[] = [{ start: 140, end: 160 }]
    expect(findBestCutoff(bp, 200, 100, 0.7, fences)).toBe(180)
  })

  it('handles empty break-point array', () => {
    expect(findBestCutoff([], 200, 100, 0.7)).toBe(200)
  })
})
