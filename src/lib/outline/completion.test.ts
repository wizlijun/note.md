// src/lib/outline/completion.test.ts
import { describe, it, expect } from 'vitest'
import { SLASH_ITEMS, filterSlashItems, applySlashItem, pageLinkQueryAt, confirmPageLink, filterPages } from './completion'

describe('slash items (render.cljs:60)', () => {
  it('filter matches id and label, case-insensitive', () => {
    expect(filterSlashItems('bold').map(i => i.id)).toEqual(['bold'])
    expect(filterSlashItems('').length).toBe(SLASH_ITEMS.length)
    expect(filterSlashItems('zzz')).toEqual([])
  })
  it('applySlashItem replaces /query and positions cursor', () => {
    // content: "note /bo"，slash 起点 5，光标 8
    const r = applySlashItem('note /bo', 5, 8, SLASH_ITEMS.find(i => i.id === 'bold')!)
    expect(r.text).toBe('note ****')
    expect(r.cursor).toBe(7)
  })
  it('link item inserts [[]] with cursor inside', () => {
    const r = applySlashItem('/li', 0, 3, SLASH_ITEMS.find(i => i.id === 'link')!)
    expect(r.text).toBe('[[]]')
    expect(r.cursor).toBe(2)
  })
})

describe('page-link query (render.cljs:166)', () => {
  it('extracts open [[query before cursor', () => {
    expect(pageLinkQueryAt('see [[abc', 9)).toEqual({ start: 4, query: 'abc' })
    expect(pageLinkQueryAt('see [[abc]]', 11)).toBeNull()  // 已闭合
    expect(pageLinkQueryAt('no link', 7)).toBeNull()
  })
  it('confirmPageLink replaces query with selection (render.cljs:211)', () => {
    const r = confirmPageLink('see [[abc]] x', 4, 'abc', 'Actual Page')
    expect(r.text).toBe('see [[Actual Page]] x')
    expect(r.cursor).toBe(19)
  })
  it('confirmPageLink keeps typed text when no selection (render.cljs:232)', () => {
    const r = confirmPageLink('see [[abc]] x', 4, 'abc', null)
    expect(r.text).toBe('see [[abc]] x')
    expect(r.cursor).toBe(11)
  })
})

describe('filterPages', () => {
  it('prefix matches first, then substring, case-insensitive', () => {
    expect(filterPages(['Beta', 'alpha', 'Alphabet', 'Gamma'], 'al')).toEqual(['alpha', 'Alphabet'])
    expect(filterPages(['Beta', 'Tabla'], 'ab')).toEqual(['Tabla'])
  })
})
