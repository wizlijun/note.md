// src/lib/outline/parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseInline } from './parser'

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
  it('emphasis family', () => {
    expect(parseInline('**b** __i__ ~~s~~ ^^h^^ `c`')).toEqual([
      { t: 'bold', text: 'b' }, { t: 'text', text: ' ' },
      { t: 'italics', text: 'i' }, { t: 'text', text: ' ' },
      { t: 'strikethrough', text: 's' }, { t: 'text', text: ' ' },
      { t: 'highlight', text: 'h' }, { t: 'text', text: ' ' },
      { t: 'code', text: 'c' },
    ])
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
