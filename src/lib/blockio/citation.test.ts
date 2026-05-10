import { describe, it, expect } from 'vitest'
import { CITATION_RE, parseCitations, type ParsedCitation } from './citation'

describe('CITATION_RE', () => {
  it('matches well-formed citations', () => {
    const cases = [
      '((doc.md#b-7f3a9c))',
      '((notes/sub.md#b-abc123))',
      '((/abs/path.md#b-000000))',
      '((#b-deadbe))',
    ]
    for (const c of cases) {
      const r = new RegExp(CITATION_RE.source, '')
      expect(r.test(c)).toBe(true)
    }
  })

  it('rejects invalid forms', () => {
    const cases = [
      '((doc.md#wrong))',         // bad id
      '((doc.md#b-XYZABC))',      // uppercase
      '((doc#b-12345))',          // 5-char id
      '((doc(x)#b-123456))',      // paren in pageuri
      '((doc#b-1234567))',        // 7-char id
      '(no parens at all)',
    ]
    for (const c of cases) {
      const r = new RegExp(CITATION_RE.source, '')
      expect(r.test(c)).toBe(false)
    }
  })
})

describe('parseCitations', () => {
  it('extracts all citations in a string', () => {
    const text = 'See ((a.md#b-aaa111)) and also ((b.md#b-bbb222)) for context.'
    const cs = parseCitations(text)
    expect(cs).toHaveLength(2)
    expect(cs[0]).toMatchObject({ pageuri: 'a.md', blockid: 'b-aaa111' })
    expect(cs[1]).toMatchObject({ pageuri: 'b.md', blockid: 'b-bbb222' })
  })

  it('records start and end offsets', () => {
    const text = 'X((a.md#b-aaa111))Y'
    const [c] = parseCitations(text)
    expect(c.start).toBe(1)
    expect(c.end).toBe(text.length - 1)
    expect(text.slice(c.start, c.end)).toBe('((a.md#b-aaa111))')
  })

  it('treats empty pageuri as same-document', () => {
    const [c] = parseCitations('((#b-7f3a9c))')
    expect(c.pageuri).toBe('')
    expect(c.blockid).toBe('b-7f3a9c')
  })
})
