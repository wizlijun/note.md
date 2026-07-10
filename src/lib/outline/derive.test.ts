// src/lib/outline/derive.test.ts
import { describe, it, expect } from 'vitest'
import { deriveAutoItems, type AutoItem } from './derive'

const strip = (items: AutoItem[]) => items.map(({ source, content, depth, anchorLine }) => ({ source, content, depth, anchorLine }))

describe('deriveAutoItems (H2+ paths to highlights, H1 skipped)', () => {
  it('skips the H1 title; highlight groups under its H2', () => {
    const md = '# Title\n## A\nsome ^^x^^ here\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 2 },
      { source: 'highlight', content: 'x', depth: 1, anchorLine: 3 },
    ])
  })
  it('nests sub-headings relatively (H2=0, H3=1, highlight under H3=2)', () => {
    const md = '## A\n### A1\n^^x^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 1 },
      { source: 'toc', content: 'A1', depth: 1, anchorLine: 2 },
      { source: 'highlight', content: 'x', depth: 2, anchorLine: 3 },
    ])
  })
  it('emits only heading paths that lead to a highlight', () => {
    const md = '## A\ntext only\n## B\n^^x^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'B', depth: 0, anchorLine: 3 },
      { source: 'highlight', content: 'x', depth: 1, anchorLine: 4 },
    ])
  })
  it('emits an ancestor heading whose descendant (not itself) has the highlight', () => {
    const md = '## B\n### B1\n^^x^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'B', depth: 0, anchorLine: 1 },
      { source: 'toc', content: 'B1', depth: 1, anchorLine: 2 },
      { source: 'highlight', content: 'x', depth: 2, anchorLine: 3 },
    ])
  })
  it('emits each heading once for multiple highlights', () => {
    const md = '## A\n^^one^^\n^^two^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 1 },
      { source: 'highlight', content: 'one', depth: 1, anchorLine: 2 },
      { source: 'highlight', content: 'two', depth: 1, anchorLine: 3 },
    ])
  })
  it('a new H1 resets the sub-heading stack', () => {
    const md = '# A\n## X\n^^x^^\n# B\n^^y^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'X', depth: 0, anchorLine: 2 },
      { source: 'highlight', content: 'x', depth: 1, anchorLine: 3 },
      { source: 'highlight', content: 'y', depth: 0, anchorLine: 5 },
    ])
  })
  it('highlight before any H2 sits at depth 0 with no heading', () => {
    const md = 'intro ^^early^^\n## A\n^^under^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'highlight', content: 'early', depth: 0, anchorLine: 1 },
      { source: 'toc', content: 'A', depth: 0, anchorLine: 2 },
      { source: 'highlight', content: 'under', depth: 1, anchorLine: 3 },
    ])
  })
  it('a doc with no highlights yields nothing', () => {
    expect(strip(deriveAutoItems('# T\n## A\n### B\nplain\n'))).toEqual([])
  })
  it('skips frontmatter and fenced code', () => {
    const md = '---\ntitle: x\n---\n## Real\n^^kept^^\n```\n^^not^^\n```\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'Real', depth: 0, anchorLine: 4 },
      { source: 'highlight', content: 'kept', depth: 1, anchorLine: 5 },
    ])
  })
  it('supports == highlights and multiple per line, in order', () => {
    const md = '## H\n^^a^^ and ==b==\n'
    expect(strip(deriveAutoItems(md)).map(i => i.content)).toEqual(['H', 'a', 'b'])
  })
  it('== noise (a==b) does not create false highlights', () => {
    const md = '## H\nformula a==b and ==real==\n'
    expect(strip(deriveAutoItems(md)).map(i => i.content)).toEqual(['H', 'real'])
  })
})

describe('wikilink derivation', () => {
  it('emits wikilink items with [[...]] style preserved', () => {
    const items = deriveAutoItems('# T\n## A\nsee [[Page One]] and ==hl==\n')
    expect(items.map(i => [i.source, i.content])).toEqual([
      ['toc', 'A'],
      ['wikilink', '[[Page One]]'],
      ['highlight', 'hl'],
    ])
  })
  it('does not double-emit wikilinks inside a highlight span', () => {
    const items = deriveAutoItems('## A\n==note [[X]] here==\n')
    expect(items.map(i => i.source)).toEqual(['toc', 'highlight'])
  })
})
