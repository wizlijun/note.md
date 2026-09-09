import { describe, expect, it } from 'vitest'
import { parseIndex } from './parser'

const uri = 'indexes/books.index.md'
const list = '- [书籍](../books/book.md)\n  - 状态：已读'

describe('parseIndex list records', () => {
  it('reads ordinary Markdown lists and named fields without frontmatter', () => {
    const doc = parseIndex('# **书籍**\n\n阅读清单。\n\n> 来自本地收藏。\n\n' + list, uri)!
    expect(doc).toMatchObject({ uri, title: '书籍', description: ['阅读清单。', '来自本地收藏。'], columns: ['文件', '状态'], view: 'table', groupBy: '', laneBy: '' })
    expect(doc.rows[0]).toMatchObject({ id: 'row-1', title: '书籍', href: '../books/book.md', section: '', cells: [{ text: '书籍', links: [{ text: '书籍', href: '../books/book.md' }], images: [] }, { text: '已读' }] })
  })

  it.each(['table', 'list', 'board', 'gallery'])('supports %s using the same list data and unrelated YAML metadata', view => {
    expect(parseIndex(`---\nview: ${view}\ngroup_by: 状态\nlane_by: 文件\ntags: [阅读]\n---\n${list}`, uri)).toMatchObject({ view, groupBy: '状态', laneBy: '文件' })
  })

  it.each(['', ' ', '  ', '   ', '    ', '       ', '\t', '\t  '])('ignores field indentation %j without changing ownership', indent => {
    const doc = parseIndex(`- [一](a.md)\n${indent}- 状态：已读\n    - [二](b.md)\n${indent}- 状态: 待读`, uri)!
    expect(doc.rows.map(row => [row.title, row.cells[1].text])).toEqual([['一', '已读'], ['二', '待读']])
  })

  it('accepts mixed markers, tabs, unbulleted fields and blank lines', () => {
    const doc = parseIndex('* [一](a.md)\n\n\t+ **状态**：已读\n作者: A\n\n  2. [二](b.md)\n  1) 状态: 待读\n\t- 作者：B', uri)!
    expect(doc.columns).toEqual(['文件', '状态', '作者'])
    expect(doc.rows.map(row => row.cells.map(value => value.text))).toEqual([['一', '已读', 'A'], ['二', '待读', 'B']])
  })

  it('unions fields in first-seen order and fills missing or empty values without shifting them', () => {
    const doc = parseIndex('- [一](a.md)\n- 作者: A\n- 状态:\n- [二](b.md)\n- 项目: P\n- 作者: B\n- [三](c.md)', uri)!
    expect(doc.columns).toEqual(['文件', '作者', '状态', '项目'])
    expect(doc.rows.map(row => row.cells.map(value => value.text))).toEqual([['一', 'A', '', ''], ['二', 'B', '', 'P'], ['三', '', '', '']])
  })

  it('preserves H2 sections and duplicate file entries', () => {
    const doc = parseIndex(`## 第一组\n\n${list}\n\n## 第二组\n\n另一分节。\n${list}`, uri)!
    expect(doc.title).toBe('books')
    expect(doc.rows.map(row => [row.id, row.section])).toEqual([['row-1', '第一组'], ['row-2', '第二组']])
    expect(doc.description).toEqual(['另一分节。'])
  })

  it('supports reference links, inline markup, literal pipes and covers', () => {
    const doc = parseIndex('- [**Book**][book]\n  - 资料: *重点* `a|b` [来源](source.md)\n  - 封面: ![第一张][cover] ![第二张](second.png)\n\n[book]: ../book.md\n[cover]: ../cover.png', uri)!
    expect(doc.rows[0]).toMatchObject({ title: 'Book', href: '../book.md', cover: { alt: '第一张', href: '../cover.png' } })
    expect(doc.rows[0].cells[1]).toMatchObject({ text: '重点 a|b 来源', links: [{ text: '来源', href: 'source.md' }] })
    expect(doc.rows[0].cells[2].images).toHaveLength(2)
  })

  it('preserves colons in values and links without creating extra fields or records', () => {
    const doc = parseIndex('- [书籍](book.md)\n- 说明：10:30：讨论 [文档](<docs/a b.md>)\n- 相关: [第二份](other.md)', uri)!
    expect(doc.rows).toHaveLength(1)
    expect(doc.rows[0].cells[1].text).toBe('10:30：讨论 文档')
    expect(doc.rows[0].cells[2].links[0].href).toBe('other.md')
  })

  it('records exact UTF-16 link offsets despite repeated labels, markup, images and emoji', () => {
    const doc = parseIndex('- [  书籍  ](book.md)\n- 说明：📚 [![封面](cover.png)](details.md) 说明 [**说明**](a.md)', uri)!
    expect(doc.rows[0].cells[0].links).toEqual([{ text: '书籍', href: 'book.md', start: 0, end: 2 }])
    expect(doc.rows[0].cells[1]).toEqual({
      text: '📚 封面 说明 说明',
      links: [{ text: '封面', href: 'details.md', start: 3, end: 5 }, { text: '说明', href: 'a.md', start: 9, end: 11 }],
      images: [{ alt: '封面', href: 'cover.png' }],
    })
  })

  it('normalizes BOM and Windows newlines', () => {
    expect(parseIndex('\uFEFF---\r\nview: gallery\r\n---\r\n' + list.replaceAll('\n', '\r\n'), uri)?.view).toBe('gallery')
  })

  it('chooses the first cover in each record even when field order differs', () => {
    const doc = parseIndex('- [一](a.md)\n- 附图: ![A](a.png)\n- 封面: ![B](b.png)\n- [二](b.md)\n- 封面: ![C](c.png)\n- 附图: ![D](d.png)', uri)!
    expect(doc.rows.map(row => row.cover?.href)).toEqual(['a.png', 'c.png'])
  })

  it('keeps unbulleted introductory text with a colon as description', () => {
    expect(parseIndex('来源：本地文件\n' + list, uri)?.description).toEqual(['来源：本地文件'])
  })

  it.each([
    '[书籍](book.md) [另一本](other.md)', '[书籍](book.md) 注释', '前缀 [书籍](book.md)',
    '![书籍](book.png)', '[![书籍](book.png)](book.md)', '**[书籍](book.md)**',
    '[书籍][missing]', '普通文件名', '[书籍](https://example.com/book.md)',
    '[书籍](javascript:alert)', '[书籍](//example.com/book.md)', '[书籍](#chapter)', '[](book.md)',
  ])('rejects an ambiguous or invalid file item: %s', first => {
    expect(parseIndex(`- ${first}\n  - 状态：已读`, uri)).toBeNull()
  })

  it.each([
    '- 状态：已读\n' + list,
    list + '\n- 状态：重复属性不能覆盖',
    list + '\n- 文件：主链接不能覆盖',
    list + '\n- [会议：设计](meeting.md',
    list + '\n- [二](https://example.com',
    list + '\n- ![封面：草稿](cover.png',
    list + '\n## 新分节\n- 作者：不能归属前节',
    list + '\n\n- 不能丢失的列表',
    list + '\n无法确定归属的正文',
    list + '\n```md\n- [隐藏数据](hidden.md)\n```',
    list + '\n\n### 不支持的分节',
    list + '\n\n<div>隐藏数据</div>',
    list.replace('已读', '<b>已读</b>'),
    '# 一个标题\n\n# 第二个标题\n\n' + list,
    '没有文件列表的普通文档',
    '| 文件 | 状态 |\n| --- | --- |\n| [书籍](book.md) | 已读 |',
  ])('falls back on ambiguity or unsupported input without dropping data (%#)', markdown => {
    expect(parseIndex(markdown, uri)).toBeNull()
  })

  it.each([
    'view: unknown', 'view: [table]', 'group_by: 不存在', 'lane_by: 不存在',
    'group_by: 123', 'lane_by: [状态]', 'view: table\nview: list', '- table', 'view: [',
    'view: null', 'group_by: null', 'lane_by: null',
  ])('rejects invalid configuration: %s', metadata => {
    expect(parseIndex(`---\n${metadata}\n---\n${list}`, uri)).toBeNull()
  })

  it('rejects unclosed frontmatter and accepts empty frontmatter', () => {
    expect(parseIndex(`---\nview: table\n${list}`, uri)).toBeNull()
    expect(parseIndex(`---\n---\n${list}`, uri)?.rows).toHaveLength(1)
  })
})
