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
    // Sub-heading ## B is ignored; the highlight attaches to top-level H1 A.
    expect(roots.map(n => [n.source, n.content])).toEqual([['toc', 'A']])
    expect(childrenOf(t, roots[0].id).map(n => [n.source, n.content])).toEqual([['highlight', 'hl']])
  })
  it('keeps id + collapsed + manual children across re-derive (diff match)', () => {
    const t = build(md1)
    const a = [...t.nodes.values()].find(n => n.content === 'A')!
    a.collapsed = true
    addNode(t, { id: 'note1', parentId: a.id, order: 500, content: 'my note', collapsed: false, source: 'manual' })
    syncAutoItems(t, deriveAutoItems('# A\n## B\n^^hl^^\nnew text\n'))
    const a2 = [...t.nodes.values()].find(n => n.content === 'A')!
    expect(a2.id).toBe(a.id)
    expect(a2.collapsed).toBe(true)
    expect(childrenOf(t, a2.id).some(n => n.id === 'note1')).toBe(true)
  })
  it('removing highlight deletes its node; manual children reparent to nearest survivor', () => {
    const t = build(md1)
    const hl = [...t.nodes.values()].find(n => n.source === 'highlight')!
    addNode(t, { id: 'child', parentId: hl.id, order: 0, content: 'attached', collapsed: false, source: 'manual' })
    // Re-derive keeps H1 A (still has a highlight) but drops the old 'hl'.
    syncAutoItems(t, deriveAutoItems('# A\n^^other^^\n'))
    expect([...t.nodes.values()].some(n => n.content === 'hl')).toBe(false)
    const child = t.nodes.get('child')!
    const a = [...t.nodes.values()].find(n => n.content === 'A')!
    expect(child.parentId).toBe(a.id)
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
    // md1 now derives a single top-level H1 (## B is ignored).
    expect([...t.nodes.values()].filter(n => n.source === 'toc')).toHaveLength(1)
  })
})
