import { describe, it, expect } from 'vitest'
import { parseCsv, serializeCsv } from './csv'

describe('parseCsv', () => {
  it('parses simple CSV', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
  })

  it('handles quoted cell with comma', () => {
    expect(parseCsv('"a,b",c')).toEqual([['a,b', 'c']])
  })

  it('handles escaped double quote inside quoted cell', () => {
    expect(parseCsv('"say ""hi""",ok')).toEqual([['say "hi"', 'ok']])
  })

  it('returns 3x3 empty grid for empty string', () => {
    expect(parseCsv('')).toEqual([['', '', ''], ['', '', ''], ['', '', '']])
  })

  it('skips blank lines', () => {
    expect(parseCsv('a,b\n\nc,d')).toEqual([['a', 'b'], ['c', 'd']])
  })
})

describe('serializeCsv', () => {
  it('serializes simple grid', () => {
    expect(serializeCsv([['a', 'b'], ['1', '2']])).toBe('a,b\n1,2')
  })

  it('escapes cells containing commas', () => {
    expect(serializeCsv([['a,b', 'c']])).toBe('"a,b",c')
  })

  it('escapes cells containing double quotes', () => {
    expect(serializeCsv([['say "hi"']])).toBe('"say ""hi"""')
  })

  it('round-trips', () => {
    const original = [['日期', '金额', '备注'], ['2026-05-01', '-45', '午餐,外卖']]
    expect(parseCsv(serializeCsv(original))).toEqual(original)
  })
})
