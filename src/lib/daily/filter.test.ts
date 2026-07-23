import { describe, it, expect } from 'vitest'
import { dayMatches } from './filter'

describe('daily/filter', () => {
  it('empty query matches everything', () => {
    expect(dayMatches(['hello', 'world'], '')).toBe(true)
    expect(dayMatches([], '')).toBe(true)
  })
  it('case-insensitive substring over node texts', () => {
    expect(dayMatches(['Buy Milk', 'Call Bob'], 'milk')).toBe(true)
    expect(dayMatches(['Buy Milk'], 'bob')).toBe(false)
  })
  it('empty day never matches a non-empty query', () => {
    expect(dayMatches([], 'anything')).toBe(false)
  })
})
