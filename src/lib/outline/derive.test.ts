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
  it('emits the containing sentence with [[...]] style preserved', () => {
    const items = deriveAutoItems('# T\n## A\nsee [[Page One]] and ==hl==\n')
    expect(items.map(i => [i.source, i.content])).toEqual([
      ['toc', 'A'],
      ['wikilink', 'see [[Page One]] and ==hl=='],
      ['highlight', 'hl'],
    ])
  })
  it('does not double-emit wikilinks inside a highlight span', () => {
    const items = deriveAutoItems('## A\n==note [[X]] here==\n')
    expect(items.map(i => i.source)).toEqual(['toc', 'highlight'])
  })
})

describe('deriveAutoItems — annotations (CriticMarkup)', () => {
  it('wrapped annotation: original text as content, note carried on the item', () => {
    const md = '这段是{==被批注的文字==}{>>记得核实<<}，后面是正文。\n'
    const items = deriveAutoItems(md)
    expect(items).toEqual([
      { source: 'annotation', content: '被批注的文字', note: '记得核实', depth: 0, anchorLine: 1 },
    ])
  })

  it('point annotation: annotation mark (※) as content, note carried on the item', () => {
    const md = '前一句。这句话结尾有批注{>>单独备注<<}。后一句。\n'
    const items = deriveAutoItems(md)
    expect(items).toEqual([
      { source: 'annotation', content: '※', note: '单独备注', depth: 0, anchorLine: 1 },
    ])
  })

  it('point annotation alone on a line still emits a mark node', () => {
    const items = deriveAutoItems('{>>只有批注<<}\n')
    expect(items).toEqual([
      { source: 'annotation', content: '※', note: '只有批注', depth: 0, anchorLine: 1 },
    ])
  })

  it('point annotation with an empty note still emits a mark node', () => {
    const items = deriveAutoItems('文字{>><<}\n')
    expect(items).toEqual([
      { source: 'annotation', content: '※', note: '', depth: 0, anchorLine: 1 },
    ])
  })

  it('annotation groups under headings like highlights do', () => {
    const md = '## A\n{==核心==}{>>注<<}\n'
    expect(deriveAutoItems(md)).toEqual([
      { source: 'toc', content: 'A', depth: 0, anchorLine: 1 },
      { source: 'annotation', content: '核心', note: '注', depth: 1, anchorLine: 2 },
    ])
  })

  it('empty note is preserved as empty string', () => {
    const items = deriveAutoItems('{==文字==}{>><<}\n')
    expect(items[0]).toMatchObject({ source: 'annotation', content: '文字', note: '' })
  })

  it('wrapped annotation is not double-collected as highlight', () => {
    const items = deriveAutoItems('{==高亮词==}{>>n<<}\n')
    expect(items.filter(i => i.source === 'highlight')).toEqual([])
  })
})

describe('deriveAutoItems — wikilink sentence extraction', () => {
  it('collects the whole sentence containing the wikilink', () => {
    const md = '开头。这里提到 [[目标页]] 的内容。结尾。\n'
    expect(strip(deriveAutoItems(md))).toEqual([
      { source: 'wikilink', content: '这里提到 [[目标页]] 的内容。', depth: 0, anchorLine: 1 },
    ])
  })

  it('one node per sentence even with multiple wikilinks', () => {
    const md = '同句有 [[甲]] 和 [[乙]] 两个链接。\n'
    const items = deriveAutoItems(md)
    expect(items).toHaveLength(1)
    expect(items[0].content).toBe('同句有 [[甲]] 和 [[乙]] 两个链接。')
  })

  it('does not split sentences inside [[...]]', () => {
    const md = '看 [[a.b 页面]] 结束。\n'
    expect(deriveAutoItems(md)[0].content).toBe('看 [[a.b 页面]] 结束。')
  })

  it('whole line when no sentence punctuation', () => {
    const md = '- 列表项提到 [[页]]\n'
    expect(deriveAutoItems(md)[0].content).toBe('- 列表项提到 [[页]]')
  })

  it('wikilink inside a highlight is still not separately collected', () => {
    const md = '==含 [[链]] 的高亮== 后文。\n'
    const items = deriveAutoItems(md)
    expect(items).toEqual([
      { source: 'highlight', content: '含 [[链]] 的高亮', depth: 0, anchorLine: 1 },
    ])
  })

  it('sentence content strips annotation markers from sibling annotations', () => {
    const md = '本句有 [[链]] 也有{==批过的词==}{>>注<<}。\n'
    const items = deriveAutoItems(md)
    const wl = items.find(i => i.source === 'wikilink')!
    expect(wl.content).toBe('本句有 [[链]] 也有批过的词。')
  })
})

describe('deriveAutoItems — marks on headings (pure toc + child items)', () => {
  it('highlight in a heading: toc stays clean, highlight becomes a child', () => {
    const md = '## 本章 ==重点== 结论\n'
    expect(deriveAutoItems(md)).toEqual([
      { source: 'toc', content: '本章 重点 结论', depth: 0, anchorLine: 1 },
      { source: 'highlight', content: '重点', depth: 1, anchorLine: 1 },
    ])
  })

  it('wrapped annotation in a heading: clean toc + annotation child with note', () => {
    const md = '## 三{==级==}{>>有歧义<<}标题\n'
    expect(deriveAutoItems(md)).toEqual([
      { source: 'toc', content: '三级标题', depth: 0, anchorLine: 1 },
      { source: 'annotation', content: '级', note: '有歧义', depth: 1, anchorLine: 1 },
    ])
  })

  it('point annotation in a heading: clean toc + ※ child', () => {
    const md = '## 标题{>>待补充<<}\n'
    expect(deriveAutoItems(md)).toEqual([
      { source: 'toc', content: '标题', depth: 0, anchorLine: 1 },
      { source: 'annotation', content: '※', note: '待补充', depth: 1, anchorLine: 1 },
    ])
  })

  it('wikilink in a heading: toc plain text + [[target]] child', () => {
    const md = '## 关于 [[规划]] 的讨论\n'
    expect(deriveAutoItems(md)).toEqual([
      { source: 'toc', content: '关于 规划 的讨论', depth: 0, anchorLine: 1 },
      { source: 'wikilink', content: '[[规划]]', depth: 1, anchorLine: 1 },
    ])
  })

  it('mixed marks on nested headings keep depths and order', () => {
    const md = '## A ==亮点==\n### B [[链接]]\n^^正文亮^^\n'
    expect(deriveAutoItems(md)).toEqual([
      { source: 'toc', content: 'A 亮点', depth: 0, anchorLine: 1 },
      { source: 'highlight', content: '亮点', depth: 1, anchorLine: 1 },
      { source: 'toc', content: 'B 链接', depth: 1, anchorLine: 2 },
      { source: 'wikilink', content: '[[链接]]', depth: 2, anchorLine: 2 },
      { source: 'highlight', content: '正文亮', depth: 2, anchorLine: 3 },
    ])
  })

  it('heading marks alone force the heading path to emit', () => {
    const md = '## 无正文\n### 只有标记 {>>注<<}\n'
    expect(deriveAutoItems(md)).toEqual([
      { source: 'toc', content: '无正文', depth: 0, anchorLine: 1 },
      { source: 'toc', content: '只有标记', depth: 1, anchorLine: 2 },
      { source: 'annotation', content: '※', note: '注', depth: 2, anchorLine: 2 },
    ])
  })
})

describe('deriveAutoItems — marks on H1 (no toc parent → root depth)', () => {
  it('wrapped annotation on an H1: emits at root depth, no toc node for the H1', () => {
    const md = '# 顶级标题{==词==}{>>批注<<}\n'
    expect(deriveAutoItems(md)).toEqual([
      { source: 'annotation', content: '词', note: '批注', depth: 0, anchorLine: 1 },
    ])
  })

  it('point annotation on an H1: ※ node at root depth', () => {
    const md = '# 顶级标题{>>备注<<}\n'
    expect(deriveAutoItems(md)).toEqual([
      { source: 'annotation', content: '※', note: '备注', depth: 0, anchorLine: 1 },
    ])
  })

  it('H1 annotation sits at root; a following H2 subtree nests under itself', () => {
    const md = '# 顶{>>顶注<<}\n## 子\n^^亮^^\n'
    expect(deriveAutoItems(md)).toEqual([
      { source: 'annotation', content: '※', note: '顶注', depth: 0, anchorLine: 1 },
      { source: 'toc', content: '子', depth: 0, anchorLine: 2 },
      { source: 'highlight', content: '亮', depth: 1, anchorLine: 3 },
    ])
  })

  it('a plain H1 (no marks) still emits nothing', () => {
    expect(deriveAutoItems('# 纯标题\n')).toEqual([])
  })
})
