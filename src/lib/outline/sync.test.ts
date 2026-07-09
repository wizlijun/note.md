// src/lib/outline/sync.test.ts
import { describe, it, expect } from 'vitest'
import { syncAutoItems, regenerate } from './sync'
import { deriveAutoItems } from './derive'
import { createTree, addNode, childrenOf } from './model'

const md1 = '# A\n## B\n^^hl^^\n'

function build(md: string) {
  const tree = createTree()
  syncAutoItems(tree, deriveAutoItems(md))
  return tree
}

describe('syncAutoItems', () => {
  it('builds initial auto tree', () => {
    const t = build(md1)
    const roots = childrenOf(t, null)
    expect(roots.map(n => [n.source, n.content])).toEqual([['toc', 'A']])
    const bs = childrenOf(t, roots[0].id)
    expect(bs.map(n => [n.source, n.content])).toEqual([['toc', 'B']])
    expect(childrenOf(t, bs[0].id).map(n => [n.source, n.content])).toEqual([['highlight', 'hl']])
  })
  it('keeps id + collapsed + manual children across re-derive (diff match)', () => {
    const t = build(md1)
    const b = [...t.nodes.values()].find(n => n.content === 'B')!
    b.collapsed = true
    addNode(t, { id: 'note1', parentId: b.id, order: 500, content: 'my note', collapsed: false, source: 'manual' })
    syncAutoItems(t, deriveAutoItems('# A\n## B\n^^hl^^\nnew text\n'))
    const b2 = [...t.nodes.values()].find(n => n.content === 'B')!
    expect(b2.id).toBe(b.id)
    expect(b2.collapsed).toBe(true)
    expect(childrenOf(t, b2.id).some(n => n.id === 'note1')).toBe(true)
  })
  it('removing highlight deletes its node; manual children reparent to nearest survivor', () => {
    const t = build(md1)
    const hl = [...t.nodes.values()].find(n => n.source === 'highlight')!
    addNode(t, { id: 'child', parentId: hl.id, order: 0, content: 'attached', collapsed: false, source: 'manual' })
    syncAutoItems(t, deriveAutoItems('# A\n## B\n'))
    expect([...t.nodes.values()].some(n => n.source === 'highlight')).toBe(false)
    const child = t.nodes.get('child')!
    const b = [...t.nodes.values()].find(n => n.content === 'B')!
    expect(child.parentId).toBe(b.id)
  })
  it('anchorLine refreshes on match', () => {
    const t = build(md1)
    syncAutoItems(t, deriveAutoItems('intro\n\n# A\n## B\n^^hl^^\n'))
    expect([...t.nodes.values()].find(n => n.content === 'A')!.anchorLine).toBe(3)
  })
  it('root-level manual node survives and stays at root', () => {
    const t = build(md1)
    addNode(t, { id: 'root-note', parentId: null, order: 950, content: 'root note', collapsed: false, source: 'manual' })
    syncAutoItems(t, deriveAutoItems('# A2\n'))
    expect(t.nodes.get('root-note')!.parentId).toBeNull()
  })
})

describe('regenerate', () => {
  it('rebuilds autos fresh but keeps manual nodes (spec 验收 5)', () => {
    const t = build(md1)
    const a = [...t.nodes.values()].find(n => n.content === 'A')!
    addNode(t, { id: 'keep', parentId: a.id, order: 999, content: 'keep me', collapsed: false, source: 'manual' })
    regenerate(t, deriveAutoItems(md1))
    expect(t.nodes.get('keep')).toBeDefined()
    expect([...t.nodes.values()].filter(n => n.source === 'toc')).toHaveLength(2)
  })
})
