import { describe, expect, it } from 'vitest'
import { parseIndex } from './parser'

const uri = 'indexes/books.index.md'
const list = '- [书籍](../books/book.md) [状态:: 已读]'
function values(source: string) {
  const doc = parseIndex(source, uri)!
  return doc.rows.map(row => Object.fromEntries(doc.columns.map((key, index) => [key, row.cells[index].text])))
}

describe('heading categories and single-line records', () => {
  it('makes hashtags, delimited tags and wikilinks target the same logical page', () => {
    const doc = parseIndex('- [[主题/设计|设计页]] #主题/设计 #[[多词页面]] [相关:: [[主题/设计|方案]] #主题/设计] 另见 [[多词页面]]', uri)!
    expect(doc.rows[0]).toMatchObject({ title: '设计页', href: '主题/设计', linkKind: 'page' })
    const links = doc.rows[0].cells.flatMap(value => value.links)
    expect(links.every(link => link.kind === 'page')).toBe(true)
    expect(links.filter(link => link.href === '主题/设计')).toHaveLength(4)
    expect(links.filter(link => link.href === '多词页面')).toHaveLength(2)
    expect(doc.rows[0].cells.find(value => value.text.includes('#[['))?.text).toBe('#主题/设计 #[[多词页面]]')
  })

  it('supports a tag as the primary page item and keeps source line numbers with frontmatter', () => {
    const doc = parseIndex('---\nview: list\n---\n## 工作\n  - #设计\n- [[设计]]', uri)!
    expect(doc.rows.map(row => [row.href, row.linkKind, row.line])).toEqual([['设计', 'page', 5], ['设计', 'page', 6]])
  })

  it('does not reinterpret knowledge markers inside code, escapes, Markdown labels or URLs', () => {
    const doc = parseIndex('- [文件](file.md) `[[代码]] #code` \\[[转义]] \\#escaped [#标签 \\[\\[文字\\]\\]](path.md) [详情:: [[真实]]]', uri)!
    const links = doc.rows[0].cells.flatMap(value => value.links)
    expect(links.filter(link => link.kind === 'page').map(link => link.href)).toEqual(['真实'])
    expect(links.filter(link => !link.kind).map(link => link.href)).toEqual(['file.md', 'path.md'])
  })

  it('keeps wiki tokens intact even when a matching Markdown reference is defined', () => {
    const doc = parseIndex('- [[设计]] [关联:: [[设计|方案]]]\n\n[设计]: wrong.md', uri)!
    expect(doc.rows[0].href).toBe('设计')
    expect(doc.rows[0].cells[1].links[0]).toMatchObject({ href: '设计', kind: 'page', text: '方案' })
  })
  it('defaults to the category list and reads named inline fields without metadata', () => {
    const doc = parseIndex('# **书籍**\n\n阅读清单。\n\n> 来自本地收藏。\n\n' + list, uri)!
    expect(doc).toMatchObject({ uri, title: '书籍', description: ['阅读清单。', '来自本地收藏。'], columns: ['文件', '状态'], view: 'list', groupBy: '', laneBy: '', sections: [] })
    expect(doc.rows[0]).toMatchObject({ id: 'row-1', title: '书籍', href: '../books/book.md', section: '', sectionId: '', cells: [{ text: '书籍', links: [{ text: '书籍', href: '../books/book.md' }], images: [] }, { text: '已读' }] })
  })

  it.each(['table', 'list', 'board', 'gallery'])('uses the same records for %s and allows unrelated YAML metadata', view => {
    expect(parseIndex(`---\nview: ${view}\ngroup_by: 状态\nlane_by: 文件\ntags: [阅读]\n---\n${list}`, uri)).toMatchObject({ view, groupBy: '状态', laneBy: '文件' })
  })

  it.each(['', ' ', '  ', '   ', '    ', '       ', '\t', '\t  '])('ignores item indentation %j while keeping inline field ownership', indent => {
    const doc = parseIndex(`## 工作\n${indent}- [一](a.md) [状态:: 已读]\n    - [二](b.md) [状态:: 待读]`, uri)!
    expect(doc.rows.map(row => [row.title, row.cells[1].text, row.section])).toEqual([['一', '已读', '工作'], ['二', '待读', '工作']])
  })

  it('accepts mixed markers, tabs, reordered fields, empty values and missing fields', () => {
    expect(values('* [一](a.md) [作者:: A B] [状态:: ]\n\n\t2. [二](b.md) [项目:: P] [作者:: B]\n  3) [三](c.md)')).toEqual([
      { 文件: '一', 作者: 'A B', 状态: '', 项目: '' }, { 文件: '二', 作者: 'B', 状态: '', 项目: 'P' }, { 文件: '三', 作者: '', 状态: '', 项目: '' },
    ])
  })

  it('builds a heading stack, tolerates skipped levels and clears stale descendants', () => {
    const doc = parseIndex('# 资料\n## 工作\n工作说明。\n### 项目\n- [A](a.md)\n##### 设计\n- [B](b.md)\n###### 细节\n- [C](c.md)\n### 项目\n- [D](d.md)\n## 兴趣\n- [E](e.md)', uri)!
    expect(doc.sections.map(s => [s.title, s.level, s.parentId, s.path])).toEqual([
      ['工作', 2, '', ['工作']], ['项目', 3, 'section-1', ['工作', '项目']], ['设计', 5, 'section-2', ['工作', '项目', '设计']],
      ['细节', 6, 'section-3', ['工作', '项目', '设计', '细节']], ['项目', 3, 'section-1', ['工作', '项目']], ['兴趣', 2, '', ['兴趣']],
    ])
    expect(doc.sections[0].description).toEqual(['工作说明。'])
    expect(doc.description).toEqual([])
    expect(doc.rows.map(row => row.sectionId)).toEqual(['section-2', 'section-3', 'section-4', 'section-5', 'section-6'])
    expect(doc.rows[1].section).toBe('工作 / 项目 / 设计')
  })

  it('does not merge identically named categories or paths containing slashes', () => {
    const doc = parseIndex('## A / B\n- [一](a.md)\n## A\n### B\n- [二](b.md)\n## A\n### B\n- [三](c.md)', uri)!
    expect(new Set(doc.rows.map(row => row.sectionId)).size).toBe(3)
    expect(doc.sections.map(s => s.id)).toEqual(['section-1', 'section-2', 'section-3', 'section-4', 'section-5'])
  })

  it('retains uncategorized entries, empty categories and explanations with their headings', () => {
    const doc = parseIndex('来源：本地文件\n- [一](a.md)\n## 空分类\n待整理。\n#### 阅读\n> 分类说明。\n- [二](b.md)\n补充说明。', uri)!
    expect(doc.description).toEqual(['来源：本地文件'])
    expect(doc.rows.map(row => row.section)).toEqual(['', '空分类 / 阅读'])
    expect(doc.sections[1].description).toEqual(['分类说明。', '补充说明。'])
  })

  it('accepts a category-only index without inventing file records', () => {
    expect(parseIndex('# 索引\n## 待整理\n尚未收录文件。', uri)).toMatchObject({ rows: [], sections: [{ title: '待整理', description: ['尚未收录文件。'] }] })
  })

  it('supports reference links, inline markup, literal pipes and first image in source order', () => {
    const doc = parseIndex('- [**Book**][book] [资料:: *重点* `a|b` [来源](source.md)] [封面:: ![第一张][cover] ![第二张](second.png)]\n\n[book]: ../book.md\n[cover]: ../cover.png', uri)!
    expect(doc.rows[0]).toMatchObject({ title: 'Book', href: '../book.md', cover: { alt: '第一张', href: '../cover.png' } })
    expect(doc.rows[0].cells[1]).toMatchObject({ text: '重点 a|b 来源', links: [{ text: '来源', href: 'source.md' }] })
    expect(doc.rows[0].cells[2].images).toHaveLength(2)
    const changedOrder = parseIndex('- [一](a.md) [附图:: ![A](a.png)] [封面:: ![B](b.png)]\n- [二](b.md) [封面:: ![C](c.png)] [附图:: ![D](d.png)]', uri)!
    expect(changedOrder.rows.map(row => row.cover?.href)).toEqual(['a.png', 'c.png'])
  })

  it('preserves nested brackets, escaped closers, codespans and Markdown link destinations inside values', () => {
    const doc = parseIndex('- [书籍](book.md) [详情:: `a]b` 数组[0] 转义\\] [来源](<docs/a]b.md>)] [时间:: 10:30：讨论]', uri)!
    expect(doc.rows[0].cells[1].text).toBe('a]b 数组[0] 转义] 来源')
    expect(doc.rows[0].cells[1].links[0].href).toBe('docs/a]b.md')
    expect(doc.rows[0].cells[2].text).toBe('10:30：讨论')
  })

  it('accepts angle-delimited file and cover destinations containing spaces', () => {
    const doc = parseIndex('- [Life in Three Dimensions](<./Life in Three Dimensions/summary.md>) [封面:: ![封面](<./Life in Three Dimensions/cover.jpg>)]', uri)!
    expect(doc.rows[0]).toMatchObject({
      href: './Life in Three Dimensions/summary.md',
      cover: { alt: '封面', href: './Life in Three Dimensions/cover.jpg' },
    })
  })

  it('extracts case-insensitive and nested tags without treating them as status fields', () => {
    expect(values('- [书籍](book.md) #主题/设计 #Tag #tag #中文 #📚 [状态:: 已读]')).toEqual([{ 文件: '书籍', 状态: '已读', 标签: '#主题/设计 #Tag #中文 #📚' }])
  })

  it('keeps numeric hashes, escaped markers and markers in code, links or field values literal', () => {
    const doc = parseIndex('- [书籍](book.md) #1984 `#code [状态:: 假]` \\#escaped \\[评分:: 9] [#链接](docs/a.md#tag) [内容:: #内部标签] #real', uri)!
    expect(doc.columns).toEqual(['文件', '内容', '标签', '说明'])
    expect(doc.rows[0].cells[2].text).toBe('#real')
    expect(doc.rows[0].cells[3].text).toContain('#code [状态:: 假]')
    expect(doc.rows[0].cells[3].text).toContain('[评分:: 9]')
    expect(doc.rows[0].cells[3].text).toContain('#1984')
    expect(doc.rows[0].cells[3].text).toContain('#escaped')
  })

  it('retains trailing prose, related links and images as a readable description', () => {
    const doc = parseIndex('- [书籍](book.md) 适合入门 [相关](other.md) ![封面](cover.png) [评分:: 9]', uri)!
    expect(doc.rows[0].cover?.href).toBe('cover.png')
    expect(doc.rows[0].cells.at(-1)).toMatchObject({ text: '适合入门 相关 封面', links: [{ text: '相关', href: 'other.md' }] })
  })

  it('records exact UTF-16 link offsets in field values', () => {
    const doc = parseIndex('- [  书籍  ](book.md) [详情:: 📚 [![封面](cover.png)](details.md) 说明 [**说明**](a.md)]', uri)!
    expect(doc.rows[0].cells[0].links).toEqual([{ text: '书籍', href: 'book.md', start: 0, end: 2 }])
    expect(doc.rows[0].cells[1]).toEqual({ text: '📚 封面 说明 说明', links: [{ text: '封面', href: 'details.md', start: 3, end: 5 }, { text: '说明', href: 'a.md', start: 9, end: 11 }], images: [{ alt: '封面', href: 'cover.png' }] })
  })

  it('normalizes BOM and Windows newlines', () => {
    expect(parseIndex('\uFEFF---\r\nview: gallery\r\n---\r\n' + list, uri)?.view).toBe('gallery')
  })

  it.each([
    '前缀 [书籍](book.md)', '![书籍](book.png)', '[![书籍](book.png)](book.md)', '**[书籍](book.md)**',
    '[书籍][missing]', '普通文件名', '[书籍](https://example.com/book.md)', '[书籍](javascript:alert)',
    '[书籍](//example.com/book.md)', '[书籍](#chapter)', '[](book.md)', '[会议：设计](meeting.md',
  ])('rejects invalid primary file item: %s', first => expect(parseIndex(`- ${first}`, uri)).toBeNull())

  it.each([
    list + ' [状态:: 重复]', list + ' [文件:: 不可覆盖]', list + ' [标签:: 不可覆盖]', list + ' [说明:: 不可覆盖]',
    list + ' [缺失:: 未闭合', list + ' [:: 缺失名称]', list + ' [字段:: [嵌套缺失]',
    list + '\n- 状态：旧版属性列表', list + '\n  - [状态:: 孤立属性]',
    list + '\n  [状态:: 不能续行]',
    list + '\n```md\n- [隐藏数据](hidden.md)\n```', list + '\n####### 超过六级',
    list + '\n<div>隐藏数据</div>', list.replace('已读', '<b>已读</b>'),
    '# 一个标题\n# 第二个标题\n' + list, '没有文件列表的普通文档',
    '| 文件 | 状态 |\n| --- | --- |\n| [书籍](book.md) | 已读 |',
  ])('falls back on ambiguous or unsupported input without losing records (%#)', markdown => expect(parseIndex(markdown, uri)).toBeNull())

  it.each([
    'view: unknown', 'view: [list]', 'group_by: 不存在', 'lane_by: 不存在', 'group_by: 123', 'lane_by: [状态]',
    'view: table\nview: list', '- table', 'view: [', 'view: null', 'group_by: null', 'lane_by: null',
  ])('rejects invalid configuration: %s', metadata => expect(parseIndex(`---\n${metadata}\n---\n${list}`, uri)).toBeNull())

  it('rejects unclosed frontmatter and accepts empty frontmatter', () => {
    expect(parseIndex(`---\nview: table\n${list}`, uri)).toBeNull()
    expect(parseIndex(`---\n---\n${list}`, uri)?.rows).toHaveLength(1)
  })
})
