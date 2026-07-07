import { describe, it, expect } from 'vitest'
import { parentDir, isWithinDir, sortEntries, type FolderEntry } from './folder-view.svelte'

describe('parentDir', () => {
  it('returns parent of a file path', () => {
    expect(parentDir('/a/b/c.md')).toBe('/a/b')
  })
  it('returns parent of a directory path (no trailing slash)', () => {
    expect(parentDir('/a/b')).toBe('/a')
  })
  it('strips a trailing slash before computing', () => {
    expect(parentDir('/a/b/')).toBe('/a')
  })
  it('returns "/" when parent is root', () => {
    expect(parentDir('/a')).toBe('/')
  })
  it('returns "/" for root itself', () => {
    expect(parentDir('/')).toBe('/')
  })
})

describe('isWithinDir', () => {
  it('true for a direct child file', () => {
    expect(isWithinDir('/a/b/c.md', '/a/b')).toBe(true)
  })
  it('true for a nested descendant', () => {
    expect(isWithinDir('/a/b/deep/c.md', '/a/b')).toBe(true)
  })
  it('false for a sibling directory', () => {
    expect(isWithinDir('/a/bb/c.md', '/a/b')).toBe(false)
  })
  it('tolerates a trailing slash on dir', () => {
    expect(isWithinDir('/a/b/c.md', '/a/b/')).toBe(true)
  })
  it('false when file is the dir itself', () => {
    expect(isWithinDir('/a/b', '/a/b')).toBe(false)
  })
})

describe('sortEntries', () => {
  it('puts folders before files, each name-sorted case-insensitively', () => {
    const input: FolderEntry[] = [
      { name: 'zebra.md', path: '/x/zebra.md', isDir: false, kind: 'markdown' },
      { name: 'Apple', path: '/x/Apple', isDir: true, kind: null },
      { name: 'banana.md', path: '/x/banana.md', isDir: false, kind: 'markdown' },
      { name: 'apricot', path: '/x/apricot', isDir: true, kind: null },
    ]
    const out = sortEntries(input).map((e) => e.name)
    expect(out).toEqual(['Apple', 'apricot', 'banana.md', 'zebra.md'])
  })
})
