// src/lib/outline/derive.test.ts
import { describe, it, expect } from 'vitest'
import { deriveAutoItems, type AutoItem } from './derive'

const strip = (items: AutoItem[]) => items.map(({ source, content, depth, anchorLine }) => ({ source, content, depth, anchorLine }))

describe('deriveAutoItems (highlights only, grouped under top-level H1)', () => {
  it('emits the containing H1 (read-only) then its highlights', () => {
    const md = '# A\n\nsome ^^first^^ text\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 1 },
      { source: 'highlight', content: 'first', depth: 1, anchorLine: 3 },
    ])
  })
  it('emits each H1 only once even with multiple highlights', () => {
    const md = '# A\n^^one^^\n^^two^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 1 },
      { source: 'highlight', content: 'one', depth: 1, anchorLine: 2 },
      { source: 'highlight', content: 'two', depth: 1, anchorLine: 3 },
    ])
  })
  it('ignores sub-headings; their highlights attach to the top-level H1', () => {
    const md = '# A\n\n## B\n\n^^deep^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 1 },
      { source: 'highlight', content: 'deep', depth: 1, anchorLine: 5 },
    ])
  })
  it('omits H1s that contain no highlights', () => {
    const md = '# A\n\ntext only\n\n# B\n\n^^hit^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'B', depth: 0, anchorLine: 5 },
      { source: 'highlight', content: 'hit', depth: 1, anchorLine: 7 },
    ])
  })
  it('a heading-less doc yields nothing', () => {
    expect(strip(deriveAutoItems('# A\n\n## B\n\nplain text\n'))).toEqual([])
  })
  it('highlights before any H1 sit at depth 0 with no toc', () => {
    const md = 'intro ^^early^^\n\n# A\n\n^^under^^\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'highlight', content: 'early', depth: 0, anchorLine: 1 },
      { source: 'toc', content: 'A', depth: 0, anchorLine: 3 },
      { source: 'highlight', content: 'under', depth: 1, anchorLine: 5 },
    ])
  })
  it('skips frontmatter and fenced code', () => {
    const md = '---\ntitle: x\n---\n# Real\n^^kept^^\n```\n^^not a highlight^^\n```\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'Real', depth: 0, anchorLine: 4 },
      { source: 'highlight', content: 'kept', depth: 1, anchorLine: 5 },
    ])
  })
  it('supports == highlights and multiple per line, in order', () => {
    const md = '# H\n^^a^^ and ==b==\n'
    expect(strip(deriveAutoItems(md)).map(i => i.content)).toEqual(['H', 'a', 'b'])
  })
  it('== noise (a==b) does not create false highlights', () => {
    const md = '# H\nformula a==b and ==real==\n'
    expect(strip(deriveAutoItems(md)).map(i => i.content)).toEqual(['H', 'real'])
  })
})
