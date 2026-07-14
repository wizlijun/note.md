// src/lib/outline/parser.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { parseInline, eachInline } from './parser'
import { setBlockedWikilinks } from '../wikilink/blocklist'

describe('parseInline (hulunote parser.cljc grammar)', () => {
  it('plain text', () => {
    expect(parseInline('hello world')).toEqual([{ t: 'text', text: 'hello world' }])
  })
  it('page link', () => {
    expect(parseInline('[[hulunote]] is best')).toEqual([
      { t: 'page-link', target: 'hulunote' },
      { t: 'text', text: ' is best' },
    ])
  })
  it('nested page link keeps full target', () => {
    expect(parseInline('[[a [[b]] c]]')).toEqual([{ t: 'page-link', target: 'a [[b]] c' }])
  })
  it('block ref', () => {
    expect(parseInline('see ((abc_12-3))')).toEqual([
      { t: 'text', text: 'see ' },
      { t: 'block-ref', refId: 'abc_12-3' },
    ])
  })
  it('bare hashtag stops at space/punct; delimited hashtag', () => {
    expect(parseInline('#tag rest')).toEqual([
      { t: 'hashtag', tag: 'tag' },
      { t: 'text', text: ' rest' },
    ])
    expect(parseInline('#[[multi word]]')).toEqual([{ t: 'hashtag', tag: 'multi word' }])
  })
  it('emphasis family (inner is recursively parsed → children)', () => {
    expect(parseInline('**b** __i__ ~~s~~ ^^h^^ `c`')).toEqual([
      { t: 'bold', children: [{ t: 'text', text: 'b' }] }, { t: 'text', text: ' ' },
      { t: 'italics', children: [{ t: 'text', text: 'i' }] }, { t: 'text', text: ' ' },
      { t: 'strikethrough', children: [{ t: 'text', text: 's' }] }, { t: 'text', text: ' ' },
      { t: 'highlight', children: [{ t: 'text', text: 'h' }] }, { t: 'text', text: ' ' },
      { t: 'code', text: 'c' },
    ])
  })
  it('wikilink nested inside emphasis is parsed as a page-link (priority)', () => {
    expect(parseInline('**[[X]]**')).toEqual([
      { t: 'bold', children: [{ t: 'page-link', target: 'X' }] },
    ])
    expect(parseInline('^^[[Y]]^^')).toEqual([
      { t: 'highlight', children: [{ t: 'page-link', target: 'Y' }] },
    ])
    expect(parseInline('text **[[Z]] and #tag** more')).toEqual([
      { t: 'text', text: 'text ' },
      { t: 'bold', children: [
        { t: 'page-link', target: 'Z' },
        { t: 'text', text: ' and ' },
        { t: 'hashtag', tag: 'tag' },
      ] },
      { t: 'text', text: ' more' },
    ])
  })
  it('a [[wikilink]] inside inline code is still a clickable page-link (code shell kept)', () => {
    // Matches the rich editor, which decorates wikilinks even inside code.
    expect(parseInline('`[[X]]`')).toEqual([
      { t: 'code', text: '[[X]]', children: [{ t: 'page-link', target: 'X' }] },
    ])
    expect(parseInline('`见 [[X]] 吧`')).toEqual([
      { t: 'code', text: '见 [[X]] 吧', children: [
        { t: 'text', text: '见 ' },
        { t: 'page-link', target: 'X' },
        { t: 'text', text: ' 吧' },
      ] },
    ])
    // plain code (no wikilink) stays a leaf — unchanged
    expect(parseInline('`plain`')).toEqual([{ t: 'code', text: 'plain' }])
  })
  it('eachInline walks nested tokens (for backlink/recall extraction)', () => {
    const found = [...eachInline(parseInline('a **[[X]] and #tag** b'))]
      .filter((t) => t.t === 'page-link' || t.t === 'hashtag')
    expect(found).toEqual([{ t: 'page-link', target: 'X' }, { t: 'hashtag', tag: 'tag' }])
  })
  it('md link / image / bare url', () => {
    expect(parseInline('[x](https://a.b)')).toEqual([{ t: 'link', text: 'x', url: 'https://a.b' }])
    expect(parseInline('![y](img.png)')).toEqual([{ t: 'image', alt: 'y', url: 'img.png' }])
    expect(parseInline('go https://a.b/c now')).toEqual([
      { t: 'text', text: 'go ' },
      { t: 'url', url: 'https://a.b/c' },
      { t: 'text', text: ' now' },
    ])
  })
  it('unclosed markers degrade to text', () => {
    expect(parseInline('**not closed')).toEqual([{ t: 'text', text: '**not closed' }])
    expect(parseInline('[[no close')).toEqual([{ t: 'text', text: '[[no close' }])
  })
})

describe('blocklisted wikilinks render as literal text', () => {
  afterEach(() => setBlockedWikilinks([]))
  it('blocked [[X]] → text token (literal), unblocked stays page-link', () => {
    setBlockedWikilinks(['wikilink', '链接'])
    expect(parseInline('[[wikilink]]')).toEqual([{ t: 'text', text: '[[wikilink]]' }])
    expect(parseInline('see [[链接]] here')).toEqual([{ t: 'text', text: 'see [[链接]] here' }])
    expect(parseInline('[[Real]]')).toEqual([{ t: 'page-link', target: 'Real' }])
  })

  it('blocked #[[X]] → literal text too (no hashtag relationship), unblocked stays hashtag', () => {
    setBlockedWikilinks(['链接'])
    expect(parseInline('#[[链接]]')).toEqual([{ t: 'text', text: '#[[链接]]' }])
    expect(parseInline('see #[[链接]] here')).toEqual([{ t: 'text', text: 'see #[[链接]] here' }])
    expect(parseInline('#[[Real]]')).toEqual([{ t: 'hashtag', tag: 'Real' }])
  })
})
