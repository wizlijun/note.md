import { describe, it, expect } from 'vitest'
import { segmentFrontmatter } from './frontmatter-segment'

/** Concatenating segment texts must always reproduce the input exactly. */
function assertPartition(raw: string) {
  const segs = segmentFrontmatter(raw)
  expect(segs.map(s => s.text).join('')).toBe(raw)
  for (const s of segs) expect(raw.slice(s.start, s.end)).toBe(s.text)
}

describe('segmentFrontmatter', () => {
  it('treats a pure mapping as one kv segment', () => {
    const raw = 'title: Hello\nauthor: Bruce\n'
    const segs = segmentFrontmatter(raw)
    expect(segs.map(s => s.kind)).toEqual(['kv'])
    assertPartition(raw)
  })

  it('keeps an indented list/block-scalar under its key in the same kv segment', () => {
    const raw = 'date: 2026-07-08\ntags:\n  - a\n  - b\n'
    const segs = segmentFrontmatter(raw)
    expect(segs.length).toBe(1)
    expect(segs[0].kind).toBe('kv')
    expect(segs[0].text).toBe(raw)
    assertPartition(raw)
  })

  it('splits mixed content into kv / md / kv / md', () => {
    const raw = [
      'title: Hello',
      'author: Bruce',
      '',
      'Some intro prose, not key:value.',
      '',
      'date: 2026-07-08',
      'tags:',
      '  - a',
      '  - b',
      '',
      '> a quote',
      '',
    ].join('\n')
    const segs = segmentFrontmatter(raw)
    const kinds = segs.map(s => s.kind)
    // kv(title/author) md(blank+prose+blank) kv(date/tags) md(blank+quote+blank)
    expect(kinds.filter(k => k === 'kv').length).toBe(2)
    expect(segs[0].kind).toBe('kv')
    expect(segs[0].text).toContain('title: Hello')
    expect(segs[0].text).toContain('author: Bruce')
    const kv2 = segs.find(s => s.kind === 'kv' && s.text.includes('date:'))!
    expect(kv2.text).toContain('tags:')
    expect(kv2.text).toContain('- b')
    assertPartition(raw)
  })

  it('keeps blank lines inside a block scalar within the kv segment', () => {
    const raw = 'desc: |\n  line one\n\n  line two\nnext: x\n'
    const segs = segmentFrontmatter(raw)
    expect(segs.length).toBe(1)
    expect(segs[0].kind).toBe('kv')
    assertPartition(raw)
  })

  it('renders a leading non-key line as md', () => {
    const raw = 'just prose here\ntitle: X\n'
    const segs = segmentFrontmatter(raw)
    expect(segs[0].kind).toBe('md')
    expect(segs[1].kind).toBe('kv')
    assertPartition(raw)
  })

  it('handles empty input', () => {
    expect(segmentFrontmatter('')).toEqual([])
  })
})
