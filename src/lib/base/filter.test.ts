import { describe, it, expect } from 'vitest'
import { evalFilter, resolveProp } from './filter'
import type { FileRecord } from './model'

function rec(over: Partial<FileRecord> = {}): FileRecord {
  return {
    path: '/v/books/dune.md', name: 'dune.md', folder: '/v/books',
    ext: 'md', mtime: 100, ctime: 50, size: 20,
    tags: ['book', 'scifi'], frontmatter: { status: 'read', rating: 5 },
    ...over,
  }
}

describe('resolveProp', () => {
  it('resolves file.*, note.field and bare field', () => {
    const r = rec()
    expect(resolveProp('file.name', r)).toBe('dune.md')
    expect(resolveProp('file.ext', r)).toBe('md')
    expect(resolveProp('note.status', r)).toBe('read')
    expect(resolveProp('rating', r)).toBe(5)
    expect(resolveProp('formula.x', r)).toBeUndefined()
  })
})

describe('evalFilter', () => {
  it('undefined filter keeps every row', () => {
    expect(evalFilter(undefined, rec())).toBe(true)
  })

  it('comparison operators', () => {
    expect(evalFilter('rating >= 5', rec())).toBe(true)
    expect(evalFilter('rating > 5', rec())).toBe(false)
    expect(evalFilter('status == "read"', rec())).toBe(true)
    expect(evalFilter('status != "read"', rec())).toBe(false)
  })

  it('file functions', () => {
    expect(evalFilter('file.hasTag("book")', rec())).toBe(true)
    expect(evalFilter('file.hasTag("missing")', rec())).toBe(false)
    expect(evalFilter('file.inFolder("books")', rec())).toBe(true)
    expect(evalFilter('file.inFolder("notes")', rec())).toBe(false)
  })

  it('and / or / not', () => {
    expect(evalFilter({ and: ['rating >= 5', 'file.hasTag("book")'] }, rec())).toBe(true)
    expect(evalFilter({ and: ['rating >= 5', 'file.hasTag("no")'] }, rec())).toBe(false)
    expect(evalFilter({ or: ['rating > 9', 'file.hasTag("scifi")'] }, rec())).toBe(true)
    expect(evalFilter({ not: ['file.hasTag("draft")'] }, rec())).toBe(true)
  })

  it('multi-element not is NOR: excludes when any child matches', () => {
    // has "book" tag → one child matches → row excluded
    expect(evalFilter({ not: ['file.hasTag("book")', 'file.hasTag("draft")'] }, rec())).toBe(false)
    // neither tag present → kept
    expect(evalFilter({ not: ['file.hasTag("draft")', 'file.hasTag("wip")'] }, rec())).toBe(true)
  })

  it('null/undefined property does not satisfy numeric comparison', () => {
    const r = rec({ frontmatter: { rating: null } })
    expect(evalFilter('rating < 5', r)).toBe(false) // null must not coerce to 0
    expect(evalFilter('missing > 0', r)).toBe(false) // absent key
  })

  it('unknown leaf fails open (keeps row)', () => {
    expect(evalFilter('someWeird.thing(1,2,3)', rec())).toBe(true)
  })
})
