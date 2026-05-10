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

import { resolvePageUri, resolveCitationViaYaml } from './citation'
import type { BlockYaml } from './yaml-schema'

describe('resolvePageUri', () => {
  it('empty pageuri returns the current doc path', () => {
    expect(resolvePageUri('', '/Users/x/notes/today.md')).toBe('/Users/x/notes/today.md')
  })

  it('relative pageuri resolves against current dir', () => {
    expect(resolvePageUri('sub/note.md', '/Users/x/notes/today.md'))
      .toBe('/Users/x/notes/sub/note.md')
  })

  it('absolute pageuri is returned as-is', () => {
    expect(resolvePageUri('/etc/hosts.md', '/Users/x/today.md'))
      .toBe('/etc/hosts.md')
  })

  it('rejects ../ traversal', () => {
    expect(() => resolvePageUri('../../etc/passwd', '/Users/x/today.md'))
      .toThrow(/traversal/i)
  })
})

describe('resolveCitationViaYaml (pure)', () => {
  const yaml: BlockYaml = {
    meta: {
      source: 'doc.md', source_hash: '', generation: 47,
      updated_at: '', schema_version: 1, has_block_md: false,
    },
    config: {
      chunk_size_chars: 2400, break_window_chars: 800,
      similarity_threshold: 0.5, split_coverage_threshold: 0.3,
      inject_ai_hint: true,
    },
    active: [
      { id: 'b-aaaaaa', src_line: 5, src_pos: 50,
        fingerprint: { hash: '', length: 1 }, text: '', parents: [], created_gen: 1 },
      { id: 'b-eeeeee', src_line: 30, src_pos: 500,
        fingerprint: { hash: '', length: 1 }, text: '', parents: [], created_gen: 47 },
    ],
    history: [
      { id: 'b-bbbbbb', retired_gen: 47, replaced_by: ['b-eeeeee'],
        last_fingerprint: { hash: '', length: 0 } },
      { id: 'b-cccccc', retired_gen: 47, replaced_by: ['b-bbbbbb'],
        last_fingerprint: { hash: '', length: 0 } },
      { id: 'b-dddddd', retired_gen: 23, replaced_by: [],
        last_fingerprint: { hash: '', length: 0 } },
    ],
  }

  it('active hit returns srcLine + status="active"', () => {
    expect(resolveCitationViaYaml(yaml, 'b-aaaaaa'))
      .toEqual({ srcLine: 5, status: 'active' })
  })

  it('single-hop history walks to active', () => {
    const r = resolveCitationViaYaml(yaml, 'b-bbbbbb')
    expect(r.status).toBe('retired')
    expect(r.srcLine).toBe(30)
    expect(r.banner).toMatch(/b-eeeeee/)
  })

  it('multi-hop history walks chain', () => {
    const r = resolveCitationViaYaml(yaml, 'b-cccccc')
    expect(r.status).toBe('retired')
    expect(r.srcLine).toBe(30) // ends at b-eeeeee via b-bbbbbb
  })

  it('chain ending in pure deletion', () => {
    const r = resolveCitationViaYaml(yaml, 'b-dddddd')
    expect(r.status).toBe('deleted')
    expect(r.srcLine).toBeUndefined()
    expect(r.banner).toMatch(/已删除/)
  })

  it('unknown id returns not_found', () => {
    const r = resolveCitationViaYaml(yaml, 'b-zzzzzz')
    expect(r.status).toBe('not_found')
  })
})
