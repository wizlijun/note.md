import { describe, it, expect } from 'vitest'
import { evaluateGrid } from './formula'

describe('evaluateGrid', () => {
  it('returns non-formula cells unchanged', () => {
    expect(evaluateGrid([['hello', '42', '']])).toEqual([['hello', '42', '']])
  })

  it('evaluates simple arithmetic =A1+B1', () => {
    const grid = [['10', '20', '=A1+B1']]
    expect(evaluateGrid(grid)[0][2]).toBe('30')
  })

  it('evaluates =SUM(A1:A3)', () => {
    const grid = [['10'], ['20'], ['30'], ['=SUM(A1:A3)']]
    expect(evaluateGrid(grid)[3][0]).toBe('60')
  })

  it('evaluates =AVG(A1:A3)', () => {
    const grid = [['10'], ['20'], ['30'], ['=AVG(A1:A3)']]
    expect(evaluateGrid(grid)[3][0]).toBe('20')
  })

  it('evaluates =COUNT(A1:A3)', () => {
    const grid = [['10'], ['20'], ['hello'], ['=COUNT(A1:A3)']]
    expect(evaluateGrid(grid)[3][0]).toBe('2')
  })

  it('evaluates =A1*0.1', () => {
    const grid = [['200', '=A1*0.1']]
    expect(evaluateGrid(grid)[0][1]).toBe('20')
  })

  it('returns #ERR for syntax errors', () => {
    const grid = [['=SUM((']]
    expect(evaluateGrid(grid)[0][0]).toBe('#ERR')
  })

  it('cell ref to non-numeric resolves to 0', () => {
    const grid = [['normal', '=B1']]
    expect(evaluateGrid(grid)[0][1]).toBe('0')
  })
})
