// src/lib/outline/backlinks.test.ts
import { describe, it, expect } from 'vitest'
import { createIndex, indexFileContent, removeFileFromIndex, backlinksFor, pageNameOf, pageCandidates } from './backlinks'

describe('pageNameOf', () => {
  it('strips extension and .notes suffix', () => {
    expect(pageNameOf('/dir/Foo.md')).toBe('Foo')
    expect(pageNameOf('/dir/Foo.notes.md')).toBe('Foo')
    expect(pageNameOf('/dir/a.b.md')).toBe('a.b')
  })
})

describe('index', () => {
  it('collects [[links]] and #tags with node text and line', () => {
    const idx = createIndex()
    indexFileContent(idx, '/d/one.notes.md', '- see [[Target]] here\n- #Target tagged\n- nothing\n')
    expect(backlinksFor(idx, 'target')).toEqual([
      { file: '/d/one.notes.md', text: 'see [[Target]] here', line: 1 },
      { file: '/d/one.notes.md', text: '#Target tagged', line: 2 },
    ])
  })
  it('re-indexing a file replaces its old entries', () => {
    const idx = createIndex()
    indexFileContent(idx, '/d/a.md', 'x [[T]]\n')
    indexFileContent(idx, '/d/a.md', 'no links now\n')
    expect(backlinksFor(idx, 't')).toEqual([])
  })
  it('removeFileFromIndex drops entries', () => {
    const idx = createIndex()
    indexFileContent(idx, '/d/a.md', '[[T]]\n')
    removeFileFromIndex(idx, '/d/a.md')
    expect(backlinksFor(idx, 't')).toEqual([])
  })
  it('pageCandidates lists indexed file pages, unique', () => {
    const idx = createIndex()
    indexFileContent(idx, '/d/Alpha.md', 'x\n')
    indexFileContent(idx, '/d/Alpha.notes.md', 'y\n')
    indexFileContent(idx, '/d/Beta.md', 'z\n')
    expect(pageCandidates(idx).sort()).toEqual(['Alpha', 'Beta'])
  })
})
