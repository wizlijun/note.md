// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRecent, loadRecent, loadRecentCounts, rememberRecent, rememberRecentCount } from './recent'

const KEY = 'notemd.smartLookup.recent'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('recent lookups', () => {
  it('keeps 20 distinct recent questions, newest first', () => {
    for (let i = 0; i < 25; i++) rememberRecent(`q${i}`)
    rememberRecent(' q24 ')
    expect(loadRecent()).toHaveLength(20)
    expect(loadRecent()[0]).toBe('q24')
    expect(loadRecent().filter((q) => q === 'q24')).toHaveLength(1)
    expect(loadRecent().at(-1)).toBe('q5')
  })

  it('moves a repeated question to the front and returns the new list', () => {
    rememberRecent('alpha')
    rememberRecent('beta')
    expect(rememberRecent('  alpha')).toEqual(['alpha', 'beta'])
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['alpha', 'beta'])
  })

  it('ignores blank questions and caps each entry at 500 characters', () => {
    rememberRecent('   ')
    expect(loadRecent()).toEqual([])
    rememberRecent('x'.repeat(600))
    expect(loadRecent()[0]).toHaveLength(500)
  })

  it('drops damaged stored values', () => {
    localStorage.setItem(KEY, '{not json')
    expect(loadRecent()).toEqual([])
    localStorage.setItem(KEY, JSON.stringify({ a: 1 }))
    expect(loadRecent()).toEqual([])
    localStorage.setItem(KEY, JSON.stringify(['ok', 3, '', ' ok ', null, 'y'.repeat(700)]))
    expect(loadRecent()).toEqual(['ok', 'y'.repeat(500)])
  })

  it('clearRecent empties the list', () => {
    rememberRecent('alpha')
    clearRecent()
    expect(loadRecent()).toEqual([])
  })

  it('survives a throwing localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(loadRecent()).toEqual([])
  })

  it('a throwing write never throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => rememberRecent('alpha')).not.toThrow()
    expect(() => clearRecent()).not.toThrow()
  })

  it('a missing localStorage returns an empty list', () => {
    vi.stubGlobal('localStorage', undefined)
    try {
      expect(loadRecent()).toEqual([])
      expect(rememberRecent('alpha')).toEqual([])
      expect(() => clearRecent()).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps result counts only for listed questions and clears them with the list', () => {
    rememberRecent('alpha')
    expect(rememberRecentCount(' alpha ', 12)).toEqual({ alpha: 12 })
    expect(rememberRecentCount('not listed', 3)).toEqual({ alpha: 12 })
    expect(rememberRecentCount('alpha', -1)).toEqual({ alpha: 12 })
    localStorage.setItem('notemd.smartLookup.recentCounts', JSON.stringify({ alpha: 4, gone: 2, beta: 'x' }))
    expect(loadRecentCounts()).toEqual({ alpha: 4 })
    localStorage.setItem('notemd.smartLookup.recentCounts', '{bad')
    expect(loadRecentCounts()).toEqual({})
    rememberRecentCount('alpha', 5)
    clearRecent()
    expect(loadRecentCounts()).toEqual({})
    expect(localStorage.getItem('notemd.smartLookup.recentCounts')).toBeNull()
  })
})
