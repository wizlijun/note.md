// src/lib/outline/derive.test.ts
import { describe, it, expect } from 'vitest'
import { deriveAutoItems, type AutoItem } from './derive'

const strip = (items: AutoItem[]) => items.map(({ source, content, depth, anchorLine }) => ({ source, content, depth, anchorLine }))

describe('deriveAutoItems', () => {
  it('headings nest relatively; anchorLine 1-based', () => {
    const md = '# A\n\ntext\n\n### B\n\n## C\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 1 },
      { source: 'toc', content: 'B', depth: 1, anchorLine: 5 },
      { source: 'toc', content: 'C', depth: 1, anchorLine: 7 },
    ])
  })
  it('highlights attach under nearest heading; before any heading → depth 0', () => {
    const md = 'intro ^^first^^\n\n# A\n\nsome ==second== here\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'highlight', content: 'first', depth: 0, anchorLine: 1 },
      { source: 'toc', content: 'A', depth: 0, anchorLine: 3 },
      { source: 'highlight', content: 'second', depth: 1, anchorLine: 5 },
    ])
  })
  it('skips frontmatter and fenced code', () => {
    const md = '---\ntitle: x\n---\n# Real\n```\n# not a heading\n^^not a highlight^^\n```\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'toc', content: 'Real', depth: 0, anchorLine: 4 },
    ])
  })
  it('multiple highlights on one line, in order', () => {
    const md = '# H\n^^a^^ and ^^b^^\n'
    expect(strip(deriveAutoItems(md)).map(i => i.content)).toEqual(['H', 'a', 'b'])
  })
  it('== noise (a==b) does not create false highlights', () => {
    const md = '# H\nformula a==b and ==real==\n'
    expect(strip(deriveAutoItems(md)).map(i => i.content)).toEqual(['H', 'real'])
  })
})
