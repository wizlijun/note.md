import { describe, it, expect } from 'vitest'
import { getMenuModel } from './menu-model'

describe('getMenuModel', () => {
  it('always includes a clipboard group and the emphasis items', () => {
    const groups = getMenuModel({ hasSelection: true })
    const ids = groups.flatMap(g => g.items.map(i => i.id))
    expect(ids).toContain('cut')
    expect(ids).toContain('highlight')
    expect(ids).toContain('wikilink')
  })

  it('marks highlight and wikilink as emphasis and orders them before other marks', () => {
    const groups = getMenuModel({ hasSelection: true })
    const emphasis = groups.find(g => g.id === 'emphasis')!
    expect(emphasis.items.map(i => i.id)).toEqual(['highlight', 'wikilink'])
    expect(emphasis.items.every(i => i.emphasis)).toBe(true)
  })

  it('flags link-from-text as needing a selection', () => {
    const groups = getMenuModel({ hasSelection: false })
    const link = groups.flatMap(g => g.items).find(i => i.id === 'link')!
    expect(link.needsSelection).toBe(true)
  })

  it('exposes block and insert submenus with children', () => {
    const groups = getMenuModel({ hasSelection: false })
    const all = groups.flatMap(g => g.items)
    expect(all.find(i => i.id === 'heading')!.children!.map(c => c.id))
      .toEqual(['h1', 'h2', 'h3'])
    expect(all.find(i => i.id === 'list')!.children!.map(c => c.id))
      .toEqual(['bullet', 'ordered', 'task'])
    expect(all.find(i => i.id === 'insert')!.children!.map(c => c.id))
      .toEqual(['table', 'image', 'math', 'mermaid', 'date'])
  })
})
