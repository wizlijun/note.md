import { describe, it, expect } from 'vitest'
import { classifyLink } from './link-route'

describe('daily/link-route', () => {
  it('external http(s) → external', () => {
    expect(classifyLink('https://a.com')).toEqual({ kind: 'external', href: 'https://a.com' })
    expect(classifyLink('http://a.com/x')).toEqual({ kind: 'external', href: 'http://a.com/x' })
  })
  it('wikilink date → feed-date', () => {
    expect(classifyLink('[[2026-07-23]]')).toEqual({ kind: 'feed-date', date: '2026-07-23' })
  })
  it('wikilink non-date → page', () => {
    expect(classifyLink('[[Some Page]]')).toEqual({ kind: 'page', page: 'Some Page' })
  })
  it('wikilink ending in .md → md', () => {
    expect(classifyLink('[[notes/foo.md]]')).toEqual({ kind: 'md', path: 'notes/foo.md' })
  })
  it('.md path → md', () => {
    expect(classifyLink('notes/foo.md')).toEqual({ kind: 'md', path: 'notes/foo.md' })
  })
  it('unknown → null', () => {
    expect(classifyLink('mailto:x@y.com')).toBeNull()
  })
})
