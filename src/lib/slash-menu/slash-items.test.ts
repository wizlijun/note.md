import { describe, it, expect } from 'vitest'
import { SLASH_ITEMS, filterSlashItems } from './slash-items'

describe('SLASH_ITEMS', () => {
  it('has 15 items', () => {
    expect(SLASH_ITEMS).toHaveLength(15)
  })
  it('every item has id, label, keywords, icon, desc, execute', () => {
    for (const item of SLASH_ITEMS) {
      expect(typeof item.id).toBe('string')
      expect(typeof item.label).toBe('string')
      expect(Array.isArray(item.keywords)).toBe(true)
      expect(typeof item.icon).toBe('string')
      expect(typeof item.desc).toBe('string')
      expect(typeof item.execute).toBe('function')
    }
  })
  it('ids are unique', () => {
    const ids = SLASH_ITEMS.map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('filterSlashItems', () => {
  it('returns all items for empty query', () => {
    expect(filterSlashItems('')).toHaveLength(15)
  })
  it('filters by label (Chinese)', () => {
    const result = filterSlashItems('代码')
    expect(result.some(i => i.id === 'code')).toBe(true)
  })
  it('filters by keyword (English)', () => {
    const result = filterSlashItems('table')
    expect(result.some(i => i.id === 'table')).toBe(true)
  })
  it('filters by keyword (todo)', () => {
    const result = filterSlashItems('todo')
    expect(result.some(i => i.id === 'task')).toBe(true)
  })
  it('returns empty array for no match', () => {
    expect(filterSlashItems('zzznomatch999')).toHaveLength(0)
  })
  it('is case-insensitive', () => {
    expect(filterSlashItems('CODE').some(i => i.id === 'code')).toBe(true)
  })
})
