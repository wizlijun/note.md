import { describe, it, expect } from 'vitest'
import {
  findCodeFences,
  isInsideCodeFence,
  type CodeFenceRegion,
} from './codefences'

describe('findCodeFences', () => {
  it('finds a single closed fence', () => {
    const text = 'Before\n```js\ncode\n```\nAfter'
    const fences = findCodeFences(text)
    expect(fences.length).toBe(1)
    expect(fences[0].start).toBe(6)
    expect(fences[0].end).toBe(21)
  })

  it('finds multiple fences', () => {
    const text = 'A\n```\nx\n```\nB\n```\ny\n```\nC'
    expect(findCodeFences(text).length).toBe(2)
  })

  it('treats unclosed fence as extending to EOF', () => {
    const text = 'Before\n```\nunclosed code'
    const fences = findCodeFences(text)
    expect(fences.length).toBe(1)
    expect(fences[0].end).toBe(text.length)
  })

  it('returns empty array when there are no fences', () => {
    expect(findCodeFences('plain text').length).toBe(0)
  })
})

describe('isInsideCodeFence', () => {
  const fences: CodeFenceRegion[] = [{ start: 10, end: 30 }]

  it('returns true strictly inside', () => {
    expect(isInsideCodeFence(15, fences)).toBe(true)
    expect(isInsideCodeFence(20, fences)).toBe(true)
  })

  it('returns false outside', () => {
    expect(isInsideCodeFence(5, fences)).toBe(false)
    expect(isInsideCodeFence(35, fences)).toBe(false)
  })

  it('returns false at the boundaries', () => {
    expect(isInsideCodeFence(10, fences)).toBe(false)
    expect(isInsideCodeFence(30, fences)).toBe(false)
  })

  it('handles multiple fences', () => {
    const fs: CodeFenceRegion[] = [
      { start: 10, end: 30 },
      { start: 50, end: 70 },
    ]
    expect(isInsideCodeFence(20, fs)).toBe(true)
    expect(isInsideCodeFence(60, fs)).toBe(true)
    expect(isInsideCodeFence(40, fs)).toBe(false)
  })
})
