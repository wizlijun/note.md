// src/lib/outline/select.test.ts
import { describe, it, expect } from 'vitest'
import { rangeBetween, selectionRoots } from './select'
import { createTree, addNode, type OutlineTree } from './model'

// a ── b(b1, b2) ── c   (visible order: a, b, b1, b2, c)
function sampleTree(): OutlineTree {
  const t = createTree()
  addNode(t, { id: 'a', parentId: null, order: 0, content: 'A', collapsed: false, source: 'manual' })
  addNode(t, { id: 'b', parentId: null, order: 100, content: 'B', collapsed: false, source: 'manual' })
  addNode(t, { id: 'b1', parentId: 'b', order: 0, content: 'B1', collapsed: false, source: 'manual' })
  addNode(t, { id: 'b2', parentId: 'b', order: 100, content: 'B2', collapsed: false, source: 'manual' })
  addNode(t, { id: 'c', parentId: null, order: 200, content: 'C', collapsed: false, source: 'manual' })
  return t
}

describe('rangeBetween', () => {
  it('returns inclusive visible range in either direction', () => {
    const t = sampleTree()
    expect(rangeBetween(t, 'a', 'b1')).toEqual(['a', 'b', 'b1'])
    expect(rangeBetween(t, 'b1', 'a')).toEqual(['a', 'b', 'b1'])
  })
  it('skips children of collapsed nodes', () => {
    const t = sampleTree()
    t.nodes.get('b')!.collapsed = true
    expect(rangeBetween(t, 'a', 'c')).toEqual(['a', 'b', 'c'])
  })
  it('returns empty when an endpoint is hidden', () => {
    const t = sampleTree()
    t.nodes.get('b')!.collapsed = true
    expect(rangeBetween(t, 'a', 'b1')).toEqual([])
  })
})

describe('selectionRoots', () => {
  it('drops nodes whose ancestor is selected', () => {
    const t = sampleTree()
    const roots = selectionRoots(t, new Set(['b', 'b1', 'c']))
    expect(roots.map(n => n.id)).toEqual(['b', 'c'])
  })
  it('keeps visible order', () => {
    const t = sampleTree()
    expect(selectionRoots(t, new Set(['c', 'a'])).map(n => n.id)).toEqual(['a', 'c'])
  })
})
