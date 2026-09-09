import { describe, expect, it } from 'vitest'
import { parseIndex } from './parser'

const uri = 'indexes/books.index.md'
const table = '| 文件 | 状态 |\n| --- | --- |\n| [书籍](../books/book.md) | 已读 |'

describe('parseIndex', () => {
  it('reads ordinary Markdown without frontmatter and preserves custom columns', () => {
    const doc = parseIndex('# **书籍**\n\n阅读清单。\n\n> 来自本地收藏。\n\n' + table, uri)!
    expect(doc).toMatchObject({ uri, title: '书籍', description: ['阅读清单。', '来自本地收藏。'], columns: ['文件', '状态'], view: 'table', groupBy: '', laneBy: '' })
    expect(doc.rows[0]).toMatchObject({ id: 'row-1', title: '书籍', href: '../books/book.md', section: '', cells: [{ text: '书籍', links: [{ text: '书籍', href: '../books/book.md' }], images: [] }, { text: '已读' }] })
  })

  it.each(['table', 'list', 'board', 'gallery'])('supports %s and unrelated YAML metadata', view => {
    const doc = parseIndex(`---\nview: ${view}\ngroup_by: 状态\nlane_by: 文件\ntags: [阅读]\n---\n${table}`, uri)!
    expect(doc).toMatchObject({ view, groupBy: '状态', laneBy: '文件' })
  })

  it('merges matching tables and preserves H2 sections and duplicate file entries', () => {
    const doc = parseIndex(`## 第一组\n\n${table}\n\n## 第二组\n\n${table}`, uri)!
    expect(doc.title).toBe('books')
    expect(doc.rows.map(row => [row.id, row.section])).toEqual([['row-1', '第一组'], ['row-2', '第二组']])
  })

  it('supports reference links, styled labels, escaped pipes, code, and the first cover in any column', () => {
    const doc = parseIndex('| 文件 | 资料 | 封面 |\n| --- | --- | --- |\n| [**Book**][book] | *重点* `a\\|b` [来源](source.md) | ![第一张][cover] ![第二张](second.png) |\n\n[book]: ../book.md\n[cover]: ../cover.png', uri)!
    expect(doc.rows[0]).toMatchObject({ title: 'Book', href: '../book.md', cover: { alt: '第一张', href: '../cover.png' } })
    expect(doc.rows[0].cells[1]).toMatchObject({ text: '重点 a|b 来源', links: [{ text: '来源', href: 'source.md' }] })
    expect(doc.rows[0].cells[2].images).toHaveLength(2)
  })

  it('accepts header-only empty tables and GFM tables without outside pipes', () => {
    expect(parseIndex('| 文件 | 状态 |\n| --- | --- |', uri)?.rows).toEqual([])
    expect(parseIndex('文件 | 状态\n--- | ---\n[书籍](book.md) | 已读', uri)?.rows).toHaveLength(1)
    expect(parseIndex('| 文件 |\n| --- |\n| [书籍](book.md) |', uri)?.rows).toHaveLength(1)
  })

  it('records exact link offsets despite repeated labels, emphasis, images, and trimmed whitespace', () => {
    const doc = parseIndex('| 文件 | 说明 |\n| --- | --- |\n| [  书籍  ](book.md) |   说明 [**说明**](a.md) ![封面](cover.png) [*说明*](b.md)   |', uri)!
    expect(doc.rows[0].cells[0].links).toEqual([{ text: '书籍', href: 'book.md', start: 0, end: 2 }])
    const detail = doc.rows[0].cells[1]
    expect(detail.text).toBe('说明 说明 封面 说明')
    expect(detail.links).toEqual([
      { text: '说明', href: 'a.md', start: 3, end: 5 },
      { text: '说明', href: 'b.md', start: 9, end: 11 },
    ])
    for (const link of detail.links) expect(detail.text.slice(link.start, link.end)).toBe(link.text)
  })

  it('keeps UTF-16 link positions for linked images after emoji and preserves image metadata', () => {
    const doc = parseIndex('| 文件 | 说明 |\n| --- | --- |\n| [书籍](book.md) | 📚 [![封面](cover.png)](details.md) [详情](other.md) |', uri)!
    expect(doc.rows[0].cells[1]).toEqual({
      text: '📚 封面 详情',
      links: [{ text: '封面', href: 'details.md', start: 3, end: 5 }, { text: '详情', href: 'other.md', start: 6, end: 8 }],
      images: [{ alt: '封面', href: 'cover.png' }],
    })
  })

  it('normalizes BOM and Windows newlines', () => {
    expect(parseIndex('\uFEFF---\r\nview: gallery\r\n---\r\n' + table.replaceAll('\n', '\r\n'), uri)?.view).toBe('gallery')
  })

  it.each([
    '[书籍](book.md) [另一本](other.md)',
    '[书籍](book.md) 注释',
    '前缀 [书籍](book.md)',
    '![书籍](book.png)',
    '[![书籍](book.png)](book.md)',
    '**[书籍](book.md)**',
    '[书籍][missing]',
    '普通文件名',
    '[书籍](https://example.com/book.md)',
    '[书籍](javascript:alert)',
    '[书籍](//example.com/book.md)',
    '[书籍](#chapter)',
    '[](book.md)',
  ])('rejects an invalid primary file cell: %s', first => {
    expect(parseIndex(`| 文件 | 状态 |\n| --- | --- |\n| ${first} | 已读 |`, uri)).toBeNull()
  })

  it.each([
    '| 文件 | 状态 |\n| --- | --- |\n| [书籍](book.md) | 已读 | 不可丢失 |',
    '| 文件 | 状态 |\n| --- | --- |\n| [书籍](book.md) |',
    '| 文件 | 文件 |\n| --- | --- |',
    '| 文件 | |\n| --- | --- |',
    '| 文件 | 状态 |\n| --- |\n| [书籍](book.md) | 已读 |',
    table + '\n\n| 文件 | 作者 |\n| --- | --- |',
    table + '\n\n- 不能丢失的列表',
    table + '\n\n```md\n隐藏数据\n```',
    table + '\n\n### 不支持的分节',
    table + '\n\n<div>隐藏数据</div>',
    table.replace('已读', '<b>已读</b>'),
    '# 一个标题\n\n# 第二个标题\n\n' + table,
    '没有表格的普通文档',
  ])('falls back for unsupported structures or malformed rows without dropping data (%#)', markdown => {
    expect(parseIndex(markdown, uri)).toBeNull()
  })

  it.each([
    'view: unknown', 'view: [table]', 'group_by: 不存在', 'lane_by: 不存在',
    'group_by: 123', 'lane_by: [状态]', 'view: table\nview: list', '- table', 'view: [',
    'view: null', 'group_by: null', 'lane_by: null',
  ])('rejects invalid configuration: %s', metadata => {
    expect(parseIndex(`---\n${metadata}\n---\n${table}`, uri)).toBeNull()
  })

  it('rejects unclosed frontmatter and accepts empty frontmatter', () => {
    expect(parseIndex(`---\nview: table\n${table}`, uri)).toBeNull()
    expect(parseIndex(`---\n---\n${table}`, uri)?.rows).toHaveLength(1)
  })
})
