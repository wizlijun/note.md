import { describe, expect, it } from 'vitest'
import type { SearchHit } from '../search/api'
import {
  crumbAfterTitle,
  dateSections,
  hitReference,
  redactError,
  sourceSections,
} from './lookup-view'

function hit(path: string, docDate: string | null, overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    path, absPath: `/vault/${path}`, line: 3, lineEnd: 3, text: 'body', breadcrumb: '',
    level: 'line', score: 1, docDate, sourceRef: `${path}#L3`, agentBy: null,
    humanVerified: false, origin: 'human', conceptType: null, pinned: false, ...overrides,
  }
}

describe('result sections', () => {
  it('groups by month, newest first, with undated hits last', () => {
    const sections = dateSections([
      hit('a.md', '2026-08-20'), hit('b.md', null), hit('c.md', '2026-10-01'), hit('d.md', '2026-08-02'),
    ], 'Date unknown')
    expect(sections.map((section) => [section.label, section.hits.map((h) => h.path)])).toEqual([
      ['2026-10', ['c.md']],
      ['2026-08', ['a.md', 'd.md']],
      ['Date unknown', ['b.md']],
    ])
  })

  it('keeps the shared source grouping order', () => {
    const sections = sourceSections([
      hit('raw.md', null, { origin: 'source' }), hit('mine.md', null),
    ], (group) => group.kind)
    expect(sections.map((section) => section.label)).toEqual(['human', 'source'])
    expect(sections.flatMap((section) => section.hits.map((h) => h.path))).toEqual(['mine.md', 'raw.md'])
  })
})

describe('lookup helpers', () => {
  it('formats a path:line reference', () => {
    expect(hitReference(hit('notes/a.md', null, { line: 4, lineEnd: 9 }))).toBe('notes/a.md:4')
  })

  it('redacts local paths and secrets from errors', () => {
    const text = redactError(new Error('failed at /Users/me/Vault/.notemd/index token=abc123 sk-abcdefgh12345'))
    expect(text).not.toContain('/Users/me')
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('sk-abcdefgh12345')
    expect(redactError('search index not ready')).toBe('search index not ready')
  })
})

describe('crumbAfterTitle', () => {
  it('drops a leading level that repeats the title and joins the rest with ›', () => {
    expect(crumbAfterTitle('决策日志', '决策日志 > 6.1110 是否按期发布')).toBe('6.1110 是否按期发布')
    expect(crumbAfterTitle('决策日志', '决策日志 › 6.1110 是否按期发布 › 结论')).toBe('6.1110 是否按期发布 › 结论')
    expect(crumbAfterTitle('决策日志', '决策日志')).toBe('')
  })
  it('keeps a path that does not start with the title', () => {
    expect(crumbAfterTitle('人员与职责', '发布工程 > 王磊')).toBe('发布工程 › 王磊')
    expect(crumbAfterTitle('A', 'AB > C')).toBe('AB › C')
    expect(crumbAfterTitle('A', '')).toBe('')
  })
})
