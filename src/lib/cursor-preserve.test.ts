import { describe, it, expect } from 'vitest'
import { offsetToLineCol, lineColToOffset } from './cursor-preserve'

describe('offsetToLineCol', () => {
  it('start of file', () => {
    expect(offsetToLineCol('abc\ndef', 0)).toEqual({ line: 0, col: 0 })
  })
  it('middle of first line', () => {
    expect(offsetToLineCol('abc\ndef', 2)).toEqual({ line: 0, col: 2 })
  })
  it('start of second line', () => {
    expect(offsetToLineCol('abc\ndef', 4)).toEqual({ line: 1, col: 0 })
  })
  it('past end clamps', () => {
    expect(offsetToLineCol('abc', 999)).toEqual({ line: 0, col: 3 })
  })
})

describe('lineColToOffset', () => {
  it('round-trip with offsetToLineCol', () => {
    const text = 'one\ntwo\nthree'
    for (let off = 0; off <= text.length; off++) {
      const lc = offsetToLineCol(text, off)
      expect(lineColToOffset(text, lc.line, lc.col)).toBe(off)
    }
  })
  it('line beyond eof clamps to last line end', () => {
    expect(lineColToOffset('abc\ndef', 99, 99)).toBe(7)
  })
  it('col beyond line end clamps to line length', () => {
    expect(lineColToOffset('abc\ndef', 0, 99)).toBe(3)
  })
})
