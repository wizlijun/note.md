import { describe, it, expect } from 'vitest'
import { generateBlockMd, splitFrontmatter } from './inject'
import type { ActiveBlock } from './yaml-schema'

function ab(id: string, src_line: number, src_pos: number): ActiveBlock {
  return {
    id, src_line, src_pos,
    fingerprint: { hash: '0', length: 1, minhash: '' },
    parents: [], created_gen: 1,
  }
}

describe('splitFrontmatter', () => {
  it('returns { fm: "", body } when no frontmatter', () => {
    const { fm, body, fmLines } = splitFrontmatter('hello world')
    expect(fm).toBe('')
    expect(body).toBe('hello world')
    expect(fmLines).toBe(0)
  })

  it('lifts a YAML frontmatter block', () => {
    const src = '---\ntitle: foo\nauthor: bruce\n---\nbody starts here'
    const { fm, body, fmLines } = splitFrontmatter(src)
    expect(fm).toBe('---\ntitle: foo\nauthor: bruce\n---\n')
    expect(body).toBe('body starts here')
    expect(fmLines).toBe(4)
  })

  it('does not match a partial frontmatter', () => {
    const src = '---\ntitle: foo\nbody without closing'
    const { fm, body } = splitFrontmatter(src)
    expect(fm).toBe('')
    expect(body).toBe(src)
  })
})

describe('generateBlockMd', () => {
  it('inserts anchor + blank line before each block', () => {
    const source = '# Heading 1\nPara 1\n\n# Heading 2\nPara 2'
    const blocks: ActiveBlock[] = [
      ab('b-aaaaaa', 1, 0),
      ab('b-bbbbbb', 4, source.indexOf('# Heading 2')),
    ]
    const { output, outLines } = generateBlockMd(source, blocks, false, 'doc.md')
    expect(output).toBe(
      '<a id="b-aaaaaa"></a>\n\n# Heading 1\nPara 1\n\n<a id="b-bbbbbb"></a>\n\n# Heading 2\nPara 2',
    )
    expect(outLines.get('b-aaaaaa')).toBe(1)
    expect(outLines.get('b-bbbbbb')).toBe(6)
  })

  it('preserves frontmatter at the top with no anchor before it', () => {
    const source = '---\ntitle: x\n---\n# Heading\nBody'
    const blocks: ActiveBlock[] = [ab('b-aaaaaa', 4, source.indexOf('# Heading'))]
    const { output } = generateBlockMd(source, blocks, false, 'doc.md')
    expect(output.startsWith('---\ntitle: x\n---\n')).toBe(true)
    expect(output.includes('<a id="b-aaaaaa"></a>')).toBe(true)
  })

  it('injects AI hint when requested', () => {
    const source = '# Heading\nBody'
    const blocks: ActiveBlock[] = [ab('b-aaaaaa', 1, 0)]
    const { output } = generateBlockMd(source, blocks, true, 'note.md')
    expect(output).toContain('Each block in this document is preceded by an HTML anchor')
    expect(output).toContain('((note.md#b-xxxxxx))')
  })

  it('is idempotent (same input → same output bytes)', () => {
    const source = 'A\n\nB\n\nC'
    const blocks: ActiveBlock[] = [
      ab('b-aaaaaa', 1, 0),
      ab('b-bbbbbb', 3, 3),
      ab('b-cccccc', 5, 6),
    ]
    const a = generateBlockMd(source, blocks, false, 'doc.md').output
    const b = generateBlockMd(source, blocks, false, 'doc.md').output
    expect(a).toBe(b)
  })

  it('out_line accounts for frontmatter (no AI hint)', () => {
    const source = '---\nx: 1\n---\nFirst block\n\nSecond block'
    const blocks: ActiveBlock[] = [
      ab('b-aaaaaa', 4, source.indexOf('First block')),
      ab('b-bbbbbb', 6, source.indexOf('Second block')),
    ]
    const { output, outLines } = generateBlockMd(source, blocks, false, 'doc.md')
    // Sanity: output starts with frontmatter
    expect(output.startsWith('---\nx: 1\n---\n')).toBe(true)
    // Both blocks have anchors that come AFTER the frontmatter
    const firstAnchorPos = output.indexOf('<a id="b-aaaaaa">')
    const fmLen = '---\nx: 1\n---\n'.length
    expect(firstAnchorPos).toBeGreaterThanOrEqual(fmLen)
    // out_line ordering: second comes after first
    expect(outLines.get('b-bbbbbb')!).toBeGreaterThan(outLines.get('b-aaaaaa')!)
  })
})
