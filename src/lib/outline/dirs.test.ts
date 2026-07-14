// src/lib/outline/dirs.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeDirName, DEFAULT_DIRS } from './dirs.svelte'

describe('normalizeDirName', () => {
  it('keeps legal names, sanitizes illegal chars', () => {
    expect(normalizeDirName('wikipage', 'wikipage')).toBe('wikipage')
    expect(normalizeDirName('我的wiki', 'wikipage')).toBe('我的wiki')
    expect(normalizeDirName('a/b', 'wikipage')).toBe('a-b')
  })
  it('empty/blank falls back to provided default', () => {
    expect(normalizeDirName('', 'wikipage')).toBe('wikipage')
    expect(normalizeDirName('   ', 'dailynote')).toBe('dailynote')
  })
})

describe('DEFAULT_DIRS', () => {
  it('matches spec defaults', () => {
    expect(DEFAULT_DIRS).toEqual({ wikipage: 'wikipage', dailynote: 'dailynote', wikilink: 'wikilink' })
  })
})
