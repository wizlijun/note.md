import { describe, it, expect } from 'vitest'
import { buildFencedBlock, stripCodeFence } from './code-fence'

describe('buildFencedBlock', () => {
  it('wraps with language', () => {
    expect(buildFencedBlock('x = 1', 'python')).toBe('```python\nx = 1\n```')
  })

  it('wraps with empty language', () => {
    expect(buildFencedBlock('plain text', '')).toBe('```\nplain text\n```')
  })

  it('preserves trailing newline in content', () => {
    expect(buildFencedBlock('a\nb\n', 'js')).toBe('```js\na\nb\n\n```')
  })

  it('handles empty content', () => {
    expect(buildFencedBlock('', 'json')).toBe('```json\n\n```')
  })
})

describe('stripCodeFence', () => {
  it('strips a clean fenced block with language', () => {
    expect(stripCodeFence('```python\nx = 1\n```')).toBe('x = 1')
  })

  it('strips a fenced block without language', () => {
    expect(stripCodeFence('```\nplain text\n```')).toBe('plain text')
  })

  it('preserves multi-line content', () => {
    expect(stripCodeFence('```js\nline 1\nline 2\nline 3\n```')).toBe('line 1\nline 2\nline 3')
  })

  it('returns input as-is when not a single fenced block (no leading ```)', () => {
    expect(stripCodeFence('not a fence')).toBe('not a fence')
  })

  it('returns input as-is when no closing fence', () => {
    expect(stripCodeFence('```python\nx = 1')).toBe('```python\nx = 1')
  })

  it('returns input as-is when extra content surrounds the fence (defensive)', () => {
    const md = '# header\n\n```py\nx = 1\n```'
    expect(stripCodeFence(md)).toBe(md)
  })

  it('round-trips with buildFencedBlock', () => {
    const original = 'def hello():\n    return 42\n'
    const round = stripCodeFence(buildFencedBlock(original, 'python'))
    expect(round).toBe(original)
  })
})
