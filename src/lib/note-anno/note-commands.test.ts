import { describe, it, expect } from 'vitest'
import { parseMarkdown } from '@moraya/core'
import { sanitizeNote, findAnnotationRange } from './note-commands'

describe('sanitizeNote', () => {
  it('flattens newlines and defuses <<}', () => {
    expect(sanitizeNote('a\nb\r\nc')).toBe('a b c')
    expect(sanitizeNote('x <<} y')).toBe('x < <} y')
  })
})

describe('findAnnotationRange', () => {
  // doc: paragraph("a", annotated("bc", note "n"), "d") → positions:
  // a=1..2, bc=2..4, d=4..5
  const doc = parseMarkdown('a{==bc==}{>>n<<}d\n')

  it('finds the range from a position inside the mark', () => {
    expect(findAnnotationRange(doc, 3)).toEqual({ from: 2, to: 4, note: 'n' })
  })

  it('finds the range at its end boundary', () => {
    expect(findAnnotationRange(doc, 4)).toEqual({ from: 2, to: 4, note: 'n' })
  })

  it('returns null outside any annotation', () => {
    expect(findAnnotationRange(doc, 1)).toBeNull()
  })

  it('spans split text nodes (bold inside annotation)', () => {
    const d2 = parseMarkdown('{==x **y** z==}{>>m<<}\n')
    const r = findAnnotationRange(d2, 3)
    expect(r?.note).toBe('m')
    expect(r?.from).toBe(1)
    expect(r?.to).toBe(1 + 'x y z'.length)
  })
})
