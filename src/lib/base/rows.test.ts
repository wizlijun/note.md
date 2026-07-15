import { describe, it, expect } from 'vitest'
import { buildRows, sortRows, groupRows, displayCell } from './rows'
import type { FileRecord } from './model'

function rec(name: string, fm: Record<string, unknown>, over: Partial<FileRecord> = {}): FileRecord {
  return {
    path: '/v/' + name, name, folder: '/v', ext: 'md',
    mtime: 0, ctime: 0, size: 0, tags: [], frontmatter: fm, ...over,
  }
}

const recs = [
  rec('a.md', { status: 'read', rating: 3 }, { mtime: 300 }),
  rec('b.md', { status: 'new', rating: 5 }, { mtime: 100 }),
  rec('c.md', { status: 'read', rating: 4 }, { mtime: 200 }),
]

describe('buildRows', () => {
  it('resolves cells for the given order', () => {
    const rows = buildRows(recs, ['file.name', 'note.rating'])
    expect(rows[0].cells['file.name']).toBe('a.md')
    expect(rows[0].cells['note.rating']).toBe(3)
  })
})

describe('sortRows', () => {
  it('sorts numeric descending', () => {
    const rows = buildRows(recs, ['note.rating'])
    const sorted = sortRows(rows, 'note.rating', 'DESC')
    expect(sorted.map((r) => r.record.name)).toEqual(['b.md', 'c.md', 'a.md'])
  })
  it('sorts by file.mtime ascending', () => {
    const rows = buildRows(recs, ['file.mtime'])
    const sorted = sortRows(rows, 'file.mtime', 'ASC')
    expect(sorted.map((r) => r.record.name)).toEqual(['b.md', 'c.md', 'a.md'])
  })
})

describe('groupRows', () => {
  it('groups by property and counts', () => {
    const rows = buildRows(recs, ['note.status'])
    const groups = groupRows(rows, 'note.status', 'ASC')
    expect(groups.map((g) => [g.key, g.rows.length])).toEqual([['new', 1], ['read', 2]])
  })
})

describe('displayCell', () => {
  it('joins arrays and stringifies objects', () => {
    expect(displayCell(['a', 'b'])).toBe('a, b')
    expect(displayCell({ x: 1 })).toBe('{"x":1}')
    expect(displayCell(undefined)).toBe('')
    expect(displayCell(5)).toBe('5')
  })
})
