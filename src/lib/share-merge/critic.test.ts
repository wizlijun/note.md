import { expect, it } from 'vitest'
import { anchor, extractGuestAnnotations } from './index'

it('K19 extracts guest annotations while preserving owner markup', () => {
  const base = '{==甲==}{>>主人注<<}乙'
  const result = extractGuestAnnotations({ base, draft: '{==甲==}{>>主人注<<}{==乙==}{>>建议<<}' })
  expect(result.clean).toBe(base)
  expect(result.annotations).toEqual([{ selector: { exact: '乙', prefix: '{==甲==}{>>主人注<<}', suffix: '', start: 16, end: 17 }, comment: '建议', kind: 'comment' }])
  expect(anchor(result.clean, result.annotations[0].selector)).toEqual({ status: 'exact', start: 16, end: 17 })
  expect(result.ownerAnnotationsTouched).toEqual([])
})

it('consumes owner annotations as a raw-string multiset in draft order', () => {
  const markup = '{==甲==}{>>同文<<}'
  const result = extractGuestAnnotations({ base: markup, draft: markup + markup })
  expect(result.clean).toBe(markup + '甲')
  expect(result.annotations.map(a => [a.selector.start, a.selector.exact, a.comment])).toEqual([[15, '甲', '同文']])
  expect(result.ownerAnnotationsTouched).toEqual([])
  const deleted = extractGuestAnnotations({ base: markup + markup, draft: markup })
  expect(deleted.ownerAnnotationsTouched).toEqual([markup])
})

it('reports deleted and changed owner annotations without silently assigning ownership', () => {
  const base = '{>>原注<<}甲{>>原注<<}'
  const result = extractGuestAnnotations({ base, draft: '{>>修改<<}甲' })
  expect(result.clean).toBe('甲')
  expect(result.ownerAnnotationsTouched).toEqual(['{>>原注<<}', '{>>原注<<}'])
  expect(result.annotations).toEqual([{ selector: { exact: '', prefix: '', suffix: '甲', start: 0, end: 0 }, comment: '修改', kind: 'comment' }])
})

it('builds all selectors in final clean UTF-16 coordinates including point annotations', () => {
  const result = extractGuestAnnotations({ base: '', draft: '😀{==中文==}{>>注一<<}{>>点<<}末{==尾==}{>>注二<<}' })
  expect(result.clean).toBe('😀中文末尾')
  expect(result.annotations.map(a => a.selector)).toEqual([
    { exact: '中文', prefix: '😀', suffix: '末尾', start: 2, end: 4 },
    { exact: '', prefix: '😀中文', suffix: '末尾', start: 4, end: 4 },
    { exact: '尾', prefix: '😀中文末', suffix: '', start: 5, end: 6 },
  ])
})

it.each([
  '{>>outer{>>inner<<}tail<<}', '{==outer{==inner==}{>>comment<<}',
  '{==incomplete{>>nested point<<}', '{>>missing', '{==missing==}{>>unfinished',
  '{==text==}', '{++addition++}{--deletion--}{~~from~>to~~}', '\\{>>escaped<<}',
])('preserves nested, incomplete, unsupported and escaped markup: %s', draft => {
  expect(extractGuestAnnotations({ base: '', draft })).toEqual({ clean: draft, annotations: [], ownerAnnotationsTouched: [] })
})
