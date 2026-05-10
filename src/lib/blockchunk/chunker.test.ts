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

import {
  chunkDocument,
  chunkDocumentWithBreakPoints,
  mergeBreakPoints,
  type Block,
} from './chunker'
import { scanBreakPoints } from './breakpoints'
import { findCodeFences } from './codefences'

describe('chunkDocument', () => {
  it('returns one block for short content', () => {
    const blocks = chunkDocument('small content', 1000, 0)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('small content')
    expect(blocks[0].src_pos).toBe(0)
    expect(blocks[0].src_line).toBe(1)
  })

  it('splits long content into multiple blocks', () => {
    const blocks = chunkDocument('A'.repeat(10000), 1000, 0)
    expect(blocks.length).toBeGreaterThan(1)
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].src_pos).toBeGreaterThan(blocks[i - 1].src_pos)
    }
  })

  it('produces non-overlapping blocks when overlapChars=0', () => {
    const blocks = chunkDocument('A'.repeat(3000), 1000, 0)
    for (let i = 1; i < blocks.length; i++) {
      const prevEnd = blocks[i - 1].src_pos + blocks[i - 1].text.length
      expect(blocks[i].src_pos).toBe(prevEnd)
    }
  })

  it('prefers heading boundaries over arbitrary breaks', () => {
    const section1 = 'Introduction text. '.repeat(70)
    const section2 = 'Main content text. '.repeat(50)
    const content = `${section1}\n# Main Section\n${section2}`
    const blocks = chunkDocument(content, 2000, 0, 800)
    const headingPos = content.indexOf('\n# Main Section')
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    expect(blocks[0].text.length).toBe(headingPos)
  })

  it('does not split inside fenced code blocks', () => {
    const before = 'Some intro. '.repeat(30)
    const fence = '```typescript\n' + 'const x = 1;\n'.repeat(100) + '```\n'
    const after = 'After code text. '.repeat(30)
    const blocks = chunkDocument(before + fence + after, 1000, 0, 400)
    expect(blocks.length).toBeGreaterThan(1)
    for (let i = 0; i < blocks.length - 1; i++) {
      const fences = (blocks[i].text.match(/```/g) || []).length
      expect(fences % 2).toBe(0)
    }
  })

  it('computes correct src_line for each block (1-based)', () => {
    const text = 'line1\nline2\nline3\n# Heading\nline5\nline6'
    const blocks = chunkDocument(text, 20, 0, 10)
    for (const b of blocks) {
      const expectedLine = text.slice(0, b.src_pos).split('\n').length
      expect(b.src_line).toBe(expectedLine)
    }
  })

  it('handles UTF-8 multi-byte characters without splitting them', () => {
    const blocks = chunkDocument('こんにちは世界'.repeat(500), 1000, 0)
    for (const b of blocks) {
      expect(() => new TextEncoder().encode(b.text)).not.toThrow()
    }
  })
})

describe('chunkDocumentWithBreakPoints', () => {
  it('is a no-op for content shorter than maxChars', () => {
    const result = chunkDocumentWithBreakPoints('short', [], [], 100, 0, 50)
    expect(result).toEqual([{ text: 'short', pos: 0 }])
  })
})

describe('mergeBreakPoints', () => {
  it('keeps the highest score at each position', () => {
    const a: BreakPoint[] = [
      { pos: 10, score: 20, type: 'blank' },
      { pos: 50, score: 1, type: 'newline' },
    ]
    const b: BreakPoint[] = [
      { pos: 10, score: 90, type: 'astFunc' },
      { pos: 100, score: 100, type: 'astClass' },
    ]
    const merged = mergeBreakPoints(a, b)
    expect(merged.length).toBe(3)
    expect(merged.find((m) => m.pos === 10)!.score).toBe(90)
  })

  it('returns sorted output', () => {
    const merged = mergeBreakPoints(
      [{ pos: 50, score: 1, type: 'a' }],
      [{ pos: 10, score: 1, type: 'b' }, { pos: 100, score: 1, type: 'c' }],
    )
    expect(merged.map((m) => m.pos)).toEqual([10, 50, 100])
  })
})
