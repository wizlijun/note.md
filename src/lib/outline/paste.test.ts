// src/lib/outline/paste.test.ts
import { describe, it, expect } from 'vitest'
import { parseClipboardOutline } from './paste'

describe('parseClipboardOutline', () => {
  it('markdown list with 2-space indent → depths', () => {
    const r = parseClipboardOutline('- A\n  - B\n  - C\n- D')
    expect(r).toEqual([
      { depth: 0, content: 'A' },
      { depth: 1, content: 'B' },
      { depth: 1, content: 'C' },
      { depth: 0, content: 'D' },
    ])
  })

  it('strips *, + and numbered markers', () => {
    const r = parseClipboardOutline('* A\n+ B\n1. C\n2) D')
    expect(r.map(n => n.content)).toEqual(['A', 'B', 'C', 'D'])
    expect(r.every(n => n.depth === 0)).toBe(true)
  })

  it('space-indented plain text (no markers)', () => {
    const r = parseClipboardOutline('A\n    B\n        C\n    D')
    expect(r).toEqual([
      { depth: 0, content: 'A' },
      { depth: 1, content: 'B' },
      { depth: 2, content: 'C' },
      { depth: 1, content: 'D' },
    ])
  })

  it('tab-indented plain text (workflowy-style)', () => {
    const r = parseClipboardOutline('A\n\tB\n\t\tC\n\tD')
    expect(r.map(n => n.depth)).toEqual([0, 1, 2, 1])
    expect(r.map(n => n.content)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('mixed tab/space at same visual width collapse to same depth', () => {
    // tab = 4 spaces
    const r = parseClipboardOutline('A\n\tB\n    C')
    expect(r.map(n => n.depth)).toEqual([0, 1, 1])
  })

  it('multi-line with no indentation → all siblings (depth 0)', () => {
    const r = parseClipboardOutline('one\ntwo\nthree')
    expect(r.map(n => n.depth)).toEqual([0, 0, 0])
  })

  it('skips blank lines', () => {
    const r = parseClipboardOutline('- A\n\n  - B\n   \n- C')
    expect(r.map(n => n.content)).toEqual(['A', 'B', 'C'])
    expect(r.map(n => n.depth)).toEqual([0, 1, 0])
  })

  it('normalizes CRLF and lone CR', () => {
    const r = parseClipboardOutline('A\r\n  B\rC')
    expect(r.map(n => n.content)).toEqual(['A', 'B', 'C'])
    expect(r.map(n => n.depth)).toEqual([0, 1, 0])
  })

  it('whole block indented → first line normalized to depth 0', () => {
    const r = parseClipboardOutline('    - A\n      - B')
    expect(r).toEqual([
      { depth: 0, content: 'A' },
      { depth: 1, content: 'B' },
    ])
  })

  it('empty / whitespace-only input → []', () => {
    expect(parseClipboardOutline('')).toEqual([])
    expect(parseClipboardOutline('   \n\n')).toEqual([])
  })
})
