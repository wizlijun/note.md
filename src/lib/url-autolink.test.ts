import { describe, it, expect } from 'vitest'
import { URL_RE, matchUrl } from './wikilink-plugin'

/** Collect every bare URL found in a string (post trailing-punctuation trim). */
function urls(text: string): string[] {
  URL_RE.lastIndex = 0
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text)) !== null) out.push(matchUrl(m[0]))
  return out
}

describe('URL_RE', () => {
  it('matches a bare http URL', () => {
    expect(urls('go to http://example.com now')).toEqual(['http://example.com'])
  })

  it('matches a bare https URL', () => {
    expect(urls('see https://example.com/a/b?q=1#x here')).toEqual([
      'https://example.com/a/b?q=1#x',
    ])
  })

  it('matches multiple URLs on one line', () => {
    expect(urls('http://a.com and https://b.com')).toEqual(['http://a.com', 'https://b.com'])
  })

  it('trims trailing sentence punctuation', () => {
    expect(urls('visit https://example.com.')).toEqual(['https://example.com'])
    expect(urls('(https://example.com),')).toEqual(['https://example.com'])
  })

  it('does not match non-http schemes', () => {
    expect(urls('mailto:foo@bar.com ftp://x.com')).toEqual([])
  })

  it('does not match a scheme with no host', () => {
    expect(urls('http:// nope')).toEqual([])
  })
})
