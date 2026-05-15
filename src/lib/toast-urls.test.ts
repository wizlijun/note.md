import { describe, it, expect } from 'vitest'
import { splitUrls } from './toast-urls'

describe('splitUrls', () => {
  it('returns a single text segment when no URL is present', () => {
    expect(splitUrls('hello world')).toEqual([{ kind: 'text', value: 'hello world' }])
  })

  it('returns empty array for empty string', () => {
    expect(splitUrls('')).toEqual([])
  })

  it('splits a single https URL surrounded by text', () => {
    expect(splitUrls('see https://example.com here')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'url', value: 'https://example.com' },
      { kind: 'text', value: ' here' },
    ])
  })

  it('splits an http URL', () => {
    expect(splitUrls('go http://x.test now')).toEqual([
      { kind: 'text', value: 'go ' },
      { kind: 'url', value: 'http://x.test' },
      { kind: 'text', value: ' now' },
    ])
  })

  it('handles a URL at the very start and end', () => {
    expect(splitUrls('https://a.b')).toEqual([{ kind: 'url', value: 'https://a.b' }])
    expect(splitUrls('hi https://a.b')).toEqual([
      { kind: 'text', value: 'hi ' },
      { kind: 'url', value: 'https://a.b' },
    ])
    expect(splitUrls('https://a.b end')).toEqual([
      { kind: 'url', value: 'https://a.b' },
      { kind: 'text', value: ' end' },
    ])
  })

  it('handles multiple URLs', () => {
    expect(splitUrls('a https://x.test b https://y.test c')).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'url', value: 'https://x.test' },
      { kind: 'text', value: ' b ' },
      { kind: 'url', value: 'https://y.test' },
      { kind: 'text', value: ' c' },
    ])
  })

  it('strips trailing CJK punctuation back into the text segment', () => {
    expect(splitUrls('点这里 https://example.com，然后继续')).toEqual([
      { kind: 'text', value: '点这里 ' },
      { kind: 'url', value: 'https://example.com' },
      { kind: 'text', value: '，然后继续' },
    ])
    expect(splitUrls('看 https://example.com。')).toEqual([
      { kind: 'text', value: '看 ' },
      { kind: 'url', value: 'https://example.com' },
      { kind: 'text', value: '。' },
    ])
  })

  it('strips trailing ASCII punctuation back into the text segment', () => {
    expect(splitUrls('see https://example.com, please')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'url', value: 'https://example.com' },
      { kind: 'text', value: ', please' },
    ])
    expect(splitUrls('end https://example.com).')).toEqual([
      { kind: 'text', value: 'end ' },
      { kind: 'url', value: 'https://example.com' },
      { kind: 'text', value: ').' },
    ])
  })

  it('keeps path/query intact', () => {
    expect(splitUrls('open https://x.test/a/b?c=1&d=2 done')).toEqual([
      { kind: 'text', value: 'open ' },
      { kind: 'url', value: 'https://x.test/a/b?c=1&d=2' },
      { kind: 'text', value: ' done' },
    ])
  })
})
