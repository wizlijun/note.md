import { describe, it, expect } from 'vitest'
import { applyWrap, expandToWord } from './text-format'

describe('applyWrap', () => {
  it('wraps a selection', () => {
    const r = applyWrap('foo bar baz', 4, 7, '**', '**')
    expect(r.value).toBe('foo **bar** baz')
    expect(r.selStart).toBe(6)
    expect(r.selEnd).toBe(9)
  })

  it('unwraps when the selection itself includes the markers', () => {
    const r = applyWrap('foo **bar** baz', 4, 11, '**', '**')
    expect(r.value).toBe('foo bar baz')
    expect(r.selStart).toBe(4)
    expect(r.selEnd).toBe(7)
  })

  it('unwraps when markers sit just outside the selection', () => {
    const r = applyWrap('foo **bar** baz', 6, 9, '**', '**')
    expect(r.value).toBe('foo bar baz')
    expect(r.selStart).toBe(4)
    expect(r.selEnd).toBe(7)
  })

  it('inserts empty markers on a collapsed selection', () => {
    const r = applyWrap('foo ', 4, 4, '**', '**')
    expect(r.value).toBe('foo ****')
    expect(r.selStart).toBe(6)
    expect(r.selEnd).toBe(6)
  })
})

describe('expandToWord', () => {
  it('expands to the ascii word under the cursor', () => {
    expect(expandToWord('foo bar baz', 5)).toEqual({ start: 4, end: 7 })
  })
  it('expands to a CJK run', () => {
    expect(expandToWord('你好世界', 2)).toEqual({ start: 0, end: 4 })
  })
  it('returns the cursor collapsed when not on a word', () => {
    expect(expandToWord('foo   bar', 4)).toEqual({ start: 4, end: 4 })
  })
})
