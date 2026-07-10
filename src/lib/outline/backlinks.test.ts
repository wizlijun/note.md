// src/lib/outline/backlinks.test.ts
import { describe, it, expect } from 'vitest'
import { createIndex, indexFileContent, removeFileFromIndex, backlinksFor, pageNameOf, pageCandidates, resolveTarget, detectNameCollisions } from './backlinks'

function idxWith(files: Record<string, string>) {
  const idx = createIndex()
  for (const [p, c] of Object.entries(files)) indexFileContent(idx, p, c)
  return idx
}

describe('resolveTarget', () => {
  it('resolves plain .md by filename (case-insensitive)', () => {
    const idx = idxWith({ '/v/Foo.md': 'x' })
    expect(resolveTarget(idx, 'foo')).toBe('/v/Foo.md')
  })
  it('standalone .note.md IS a valid target (wiki page)', () => {
    const idx = idxWith({ '/v/wikipage/wiki.note.md': '- x' })
    expect(resolveTarget(idx, 'wiki')).toBe('/v/wikipage/wiki.note.md')
  })
  it('companion .note.md is NEVER a target; main doc wins', () => {
    const idx = idxWith({ '/v/a.md': 'x', '/v/a.note.md': '- anno' })
    expect(resolveTarget(idx, 'a')).toBe('/v/a.md')
  })
  it('main doc beats a同名 standalone note in another dir', () => {
    const idx = idxWith({ '/v/sub/x.md': 'x', '/v/wikipage/x.note.md': '- x' })
    expect(resolveTarget(idx, 'x')).toBe('/v/sub/x.md')
  })
  it('null when nothing matches', () => {
    expect(resolveTarget(idxWith({}), 'nope')).toBeNull()
  })
})

describe('detectNameCollisions', () => {
  it('reports same page name in different dirs', () => {
    const idx = idxWith({ '/v/a/x.md': '1', '/v/b/x.md': '2' })
    const m = detectNameCollisions(idx)
    expect(m.get('x')).toEqual(expect.arrayContaining(['/v/a/x.md', '/v/b/x.md']))
  })
  it('companion pair is NOT a collision', () => {
    const idx = idxWith({ '/v/a.md': '1', '/v/a.note.md': '- x' })
    expect(detectNameCollisions(idx).size).toBe(0)
  })
  it('standalone note vs md with same name IS a collision', () => {
    const idx = idxWith({ '/v/sub/x.md': '1', '/v/wikipage/x.note.md': '- x' })
    expect(detectNameCollisions(idx).get('x')).toHaveLength(2)
  })
})

describe('pageNameOf', () => {
  it('strips extension and .notes suffix', () => {
    expect(pageNameOf('/dir/Foo.md')).toBe('Foo')
    expect(pageNameOf('/dir/Foo.notes.md')).toBe('Foo')
    expect(pageNameOf('/dir/a.b.md')).toBe('a.b')
  })
  it('strips .note.md, legacy .notes.md and plain .md', () => {
    expect(pageNameOf('/v/foo.note.md')).toBe('foo')
    expect(pageNameOf('/v/foo.notes.md')).toBe('foo')
    expect(pageNameOf('/v/foo.md')).toBe('foo')
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
