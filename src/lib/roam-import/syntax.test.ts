// src/lib/roam-import/syntax.test.ts
import { describe, it, expect } from 'vitest'
import { convertInline, rewriteLinks, escapeReservedProps } from './syntax'

describe('convertInline', () => {
  it('converts TODO/DONE markers', () => {
    expect(convertInline('{{[[TODO]]}} buy milk')).toBe('[ ] buy milk')
    expect(convertInline('{{[[DONE]]}} done it')).toBe('[x] done it')
    expect(convertInline('{{TODO}} short form')).toBe('[ ] short form')
  })
  it('degrades embeds to block refs', () => {
    expect(convertInline('{{[[embed]]: ((abc123))}}')).toBe('((abc123))')
    expect(convertInline('{{embed: ((abc123))}}')).toBe('((abc123))')
  })
  it('converts __italic__ to *italic*', () => {
    expect(convertInline('a __word__ b')).toBe('a *word* b')
  })
  it('converts #[[multi word]] tags to wikilinks, keeps #plain tags', () => {
    expect(convertInline('x #[[multi word]] y #plain')).toBe('x [[multi word]] y #plain')
  })
  it('keeps bold/highlight/strike/wikilinks/block refs as-is', () => {
    const s = '**b** ^^h^^ ~~s~~ [[Page]] ((abc123))'
    expect(convertInline(s)).toBe(s)
  })
  it('does not transform inside inline code or code fences', () => {
    expect(convertInline('`__x__` and ```\n__y__\n``` and __z__'))
      .toBe('`__x__` and ```\n__y__\n``` and *z*')
  })
})

describe('rewriteLinks', () => {
  it('rewrites [[Old]] to [[New]] per rename map', () => {
    const renames = new Map([['a/b', 'a-b']])
    expect(rewriteLinks('see [[a/b]] end', renames)).toBe('see [[a-b]] end')
    expect(rewriteLinks('see [[untouched]]', renames)).toBe('see [[untouched]]')
  })
  it('empty map is a no-op', () => {
    expect(rewriteLinks('see [[x]]', new Map())).toBe('see [[x]]')
  })
})

describe('escapeReservedProps', () => {
  it('prefixes reserved prop-like continuation lines with a space', () => {
    expect(escapeReservedProps('first\nid:: sneaky\nnormal line'))
      .toBe('first\n id:: sneaky\nnormal line')
  })
  it('leaves first line and non-reserved keys alone', () => {
    expect(escapeReservedProps('id:: first-line-safe\nfoo:: bar'))
      .toBe('id:: first-line-safe\nfoo:: bar')
  })
})
