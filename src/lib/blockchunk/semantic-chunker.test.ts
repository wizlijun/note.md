import { describe, it, expect } from 'vitest'
import { chunkDocumentSemantic } from './semantic-chunker'

describe('chunkDocumentSemantic', () => {
  it('cuts at H2 by default; one block per H2', () => {
    const src = [
      '# Title',
      '',
      '## A',
      'Para A.',
      '',
      '## B',
      'Para B.',
      '',
      '## C',
      'Para C.',
    ].join('\n')
    const blocks = chunkDocumentSemantic(src, { cutLevel: 2, maxChars: 9999, minChars: 0 })
    // Expect: H1 preamble + 3 H2 sections = 4 blocks
    expect(blocks.length).toBe(4)
    expect(blocks[0].text.startsWith('# Title')).toBe(true)
    expect(blocks[1].text.startsWith('## A')).toBe(true)
    expect(blocks[2].text.startsWith('## B')).toBe(true)
    expect(blocks[3].text.startsWith('## C')).toBe(true)
  })

  it('preserves block boundaries at line starts', () => {
    const src = '# Title\n\n## Sec\nContent line.\n'
    const blocks = chunkDocumentSemantic(src, { cutLevel: 2, maxChars: 9999, minChars: 0 })
    expect(blocks.length).toBe(2)
    expect(blocks[0].src_line).toBe(1)
    expect(blocks[1].src_line).toBe(3)
    expect(blocks[1].text).toBe('## Sec\nContent line.')
  })

  it('splits an oversized H2 section at H3 boundaries', () => {
    const big = (label: string, n: number) => Array(n).fill(`text ${label}`).join('\n')
    const src = [
      '## Big section',
      big('intro', 5),     // ~50 chars
      '### Sub A',
      big('A', 200),       // ~2000 chars
      '### Sub B',
      big('B', 200),       // ~2000 chars
    ].join('\n')
    const blocks = chunkDocumentSemantic(src, { cutLevel: 2, maxChars: 1500, minChars: 100 })
    // Big H2 over 1500 chars → split at H3 → preamble + Sub A + Sub B = 3
    expect(blocks.length).toBe(3)
    expect(blocks[0].text.startsWith('## Big section')).toBe(true)
    expect(blocks[1].text.startsWith('### Sub A')).toBe(true)
    expect(blocks[2].text.startsWith('### Sub B')).toBe(true)
  })

  it('falls back to size chunker when an oversized section has no deeper headings', () => {
    // Single H2 with no H3+ inside, but huge content.
    const big = Array(200).fill('Aaaaaaaaaaaaaaaaa').join('\n')
    const src = `## Only section\n\n${big}\n`
    const blocks = chunkDocumentSemantic(src, { cutLevel: 2, maxChars: 800, minChars: 0 })
    // Should produce >=2 blocks (size chunker kicks in for the oversized section)
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    // Every block stays within reasonable size
    for (const b of blocks) {
      expect(b.text.length).toBeLessThanOrEqual(2000)
    }
  })

  it('merges undersized sections forward', () => {
    const src = [
      '## A',
      'short',           // 5 chars + newlines
      '## B',
      'also short',
      '## C',
      'C is much longer with much more padding text added so it crosses the min threshold safely.',
    ].join('\n')
    const blocks = chunkDocumentSemantic(src, { cutLevel: 2, maxChars: 9999, minChars: 50 })
    // A and B both <50 chars → merged into A; A+B forms one block; C separate
    // OR: B merges into A, then C ≥ 50 stays. Result: 2 blocks.
    expect(blocks.length).toBe(2)
    expect(blocks[0].text).toContain('## A')
    expect(blocks[0].text).toContain('## B')
    expect(blocks[1].text).toContain('## C')
  })

  it('does not detect # inside code fences as headings', () => {
    const src = [
      '## Real',
      '```',
      '# Not a heading',
      '## Also not',
      '```',
      'after code',
    ].join('\n')
    const blocks = chunkDocumentSemantic(src, { cutLevel: 2, maxChars: 9999, minChars: 0 })
    // Only one real H2 → 1 block
    expect(blocks.length).toBe(1)
    expect(blocks[0].text).toContain('# Not a heading')
  })

  it('falls back to size chunker when there are no headings at all', () => {
    const src = 'just\nplain\nlines\nwithout\nany\nheadings\n'
    const blocks = chunkDocumentSemantic(src, { cutLevel: 2, maxChars: 9999, minChars: 0 })
    expect(blocks.length).toBe(1)
    expect(blocks[0].src_line).toBe(1)
  })

  it('falls back to size chunker when no heading meets the cut level', () => {
    const src = '### Only H3\nContent\n### Another H3\nMore content\n'
    const blocks = chunkDocumentSemantic(src, { cutLevel: 2, maxChars: 9999, minChars: 0 })
    // No H1/H2 → fall back to size chunker; for short content that is one block
    expect(blocks.length).toBe(1)
  })

  it('handles a preamble before the first heading', () => {
    const src = 'Some prose first.\nMore prose.\n## First Heading\nBody.'
    const blocks = chunkDocumentSemantic(src, { cutLevel: 2, maxChars: 9999, minChars: 0 })
    expect(blocks.length).toBe(2)
    expect(blocks[0].src_line).toBe(1)
    expect(blocks[1].src_line).toBe(3)
  })

  it('block N+1 starts at a line boundary (the char before src_pos is \\n)', () => {
    const src = [
      '## A',
      'A line one.',
      'A line two.',
      '## B',
      'B line one.',
      'B line two.',
    ].join('\n')
    const blocks = chunkDocumentSemantic(src, { cutLevel: 2, maxChars: 9999, minChars: 0 })
    expect(blocks.length).toBe(2)
    expect(blocks[1].src_pos).toBeGreaterThan(0)
    expect(src.charCodeAt(blocks[1].src_pos - 1)).toBe(10) // \n
    // Block 0's text spans lines 1..3, block 1's text spans lines 4..6
    expect(blocks[0].src_line).toBe(1)
    expect(blocks[1].src_line).toBe(4)
    // Texts are disjoint and tile the source (gap is exactly the \n between them)
    const totalLen = blocks[0].text.length + 1 + blocks[1].text.length
    expect(totalLen).toBe(src.length)
  })
})
