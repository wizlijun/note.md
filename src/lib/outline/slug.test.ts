// src/lib/outline/slug.test.ts
import { describe, it, expect } from 'vitest'
import { sanitizeFileName } from './slug'

describe('sanitizeFileName', () => {
  it('keeps CJK and spaces, replaces filesystem-illegal chars with -', () => {
    expect(sanitizeFileName('我的 笔记')).toBe('我的 笔记')
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
  })
  it('trims and collapses leading dots (hidden-file guard)', () => {
    expect(sanitizeFileName('  x  ')).toBe('x')
    expect(sanitizeFileName('..secret')).toBe('secret')
  })
  it('empty after sanitize → untitled', () => {
    expect(sanitizeFileName('///')).toBe('untitled')
    expect(sanitizeFileName('   ')).toBe('untitled')
  })
})
