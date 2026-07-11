// src/lib/roam-import/parse.test.ts
import { describe, it, expect } from 'vitest'
import { parseRoamJson, dailyDateFromUid } from './parse'

const G = JSON.stringify([
  {
    title: 'July 11th, 2026', uid: '07-11-2026', 'edit-time': 1700000000000,
    children: [
      { uid: 'aaa111', string: 'hello ((bbb222)) world', 'edit-time': 1700000000001 },
    ],
  },
  {
    title: 'Wiki Page', uid: 'pg1',
    children: [
      { uid: 'bbb222', string: 'target block', children: [
        { uid: 'ccc333', string: '{{[[embed]]: ((ddd444))}}' },
      ] },
    ],
  },
])

describe('parseRoamJson', () => {
  it('parses pages and collects referenced uids across the whole graph', () => {
    const g = parseRoamJson(G)
    expect(g.pages).toHaveLength(2)
    expect(g.referencedUids).toEqual(new Set(['bbb222', 'ddd444']))
  })

  it('rejects non-array json', () => {
    expect(() => parseRoamJson('{"a":1}')).toThrow(/array/i)
    expect(() => parseRoamJson('not json')).toThrow()
  })

  it('skips entries without a string title', () => {
    const g = parseRoamJson('[{"title":"ok"},{"notitle":true},null]')
    expect(g.pages.map((p) => p.title)).toEqual(['ok'])
  })
})

describe('dailyDateFromUid', () => {
  it('converts Roam daily uid MM-DD-YYYY to yyyy-MM-dd', () => {
    expect(dailyDateFromUid('07-11-2026')).toBe('2026-07-11')
  })
  it('rejects non-daily uids and out-of-range dates', () => {
    expect(dailyDateFromUid('aaa111')).toBeNull()
    expect(dailyDateFromUid(undefined)).toBeNull()
    expect(dailyDateFromUid('13-01-2026')).toBeNull()
    expect(dailyDateFromUid('12-32-2026')).toBeNull()
  })
})
