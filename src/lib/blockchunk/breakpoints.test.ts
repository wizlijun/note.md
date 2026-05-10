import { describe, it, expect } from 'vitest'
import { scanBreakPoints, BREAK_PATTERNS } from './breakpoints'

describe('BREAK_PATTERNS', () => {
  it('exposes h1..h6, codeblock, hr, blank, list, numlist, newline in score order', () => {
    const types = BREAK_PATTERNS.map((p) => p[2])
    expect(types).toEqual([
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'codeblock', 'hr', 'blank', 'list', 'numlist', 'newline',
    ])
  })
})

describe('scanBreakPoints', () => {
  it('detects h1 at score 100', () => {
    const text = 'Intro\n# Heading 1\nMore text'
    const breaks = scanBreakPoints(text)
    const h1 = breaks.find((b) => b.type === 'h1')
    expect(h1).toBeDefined()
    expect(h1!.score).toBe(100)
    expect(h1!.pos).toBe(5)
  })

  it('detects multiple heading levels with descending scores', () => {
    const text = 'Text\n# H1\n## H2\n### H3\nMore'
    const breaks = scanBreakPoints(text)
    expect(breaks.find((b) => b.type === 'h1')!.score).toBe(100)
    expect(breaks.find((b) => b.type === 'h2')!.score).toBe(90)
    expect(breaks.find((b) => b.type === 'h3')!.score).toBe(80)
  })

  it('detects code block fence at score 80', () => {
    const text = 'Before\n```js\ncode\n```\nAfter'
    const breaks = scanBreakPoints(text).filter((b) => b.type === 'codeblock')
    expect(breaks.length).toBe(2)
    expect(breaks[0].score).toBe(80)
  })

  it('detects horizontal rule at score 60', () => {
    const text = 'Text\n---\nMore'
    expect(scanBreakPoints(text).find((b) => b.type === 'hr')!.score).toBe(60)
  })

  it('detects blank line at score 20', () => {
    const text = 'A.\n\nB.'
    expect(scanBreakPoints(text).find((b) => b.type === 'blank')!.score).toBe(20)
  })

  it('detects list and numlist at score 5', () => {
    const text = 'Intro\n- Item\n- Item2\n1. Numbered'
    const lists = scanBreakPoints(text).filter((b) => b.type === 'list')
    const nums = scanBreakPoints(text).filter((b) => b.type === 'numlist')
    expect(lists.length).toBe(2)
    expect(nums.length).toBe(1)
    expect(lists[0].score).toBe(5)
    expect(nums[0].score).toBe(5)
  })

  it('detects plain newline at score 1', () => {
    const text = 'Line1\nLine2\nLine3'
    const newlines = scanBreakPoints(text).filter((b) => b.type === 'newline')
    expect(newlines.length).toBe(2)
    expect(newlines[0].score).toBe(1)
  })

  it('returns breaks sorted by position', () => {
    const text = 'A\n# B\n\nC\n## D'
    const breaks = scanBreakPoints(text)
    for (let i = 1; i < breaks.length; i++) {
      expect(breaks[i].pos).toBeGreaterThan(breaks[i - 1].pos)
    }
  })

  it('keeps highest-scoring pattern at the same position', () => {
    const text = 'Text\n# Heading'
    const atFour = scanBreakPoints(text).filter((b) => b.pos === 4)
    expect(atFour.length).toBe(1)
    expect(atFour[0].type).toBe('h1')
    expect(atFour[0].score).toBe(100)
  })
})
