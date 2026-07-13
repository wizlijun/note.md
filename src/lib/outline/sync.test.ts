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
    // H1 A is skipped; ## B is the top-level heading; the highlight nests under B.
    expect(roots.map(n => [n.source, n.content])).toEqual([['toc', 'B']])
    expect(childrenOf(t, roots[0].id).map(n => [n.source, n.content])).toEqual([['highlight', 'hl']])
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
  it('removing a highlight PRESERVES its node as manual (content not lost); child stays attached', () => {
    const t = build(md1)
    const hl = [...t.nodes.values()].find(n => n.source === 'highlight')!
    addNode(t, { id: 'child', parentId: hl.id, order: 0, content: 'attached', collapsed: false, source: 'manual' })
    // Re-derive keeps heading B (still has a highlight) but drops the old 'hl'.
    syncAutoItems(t, deriveAutoItems('## B\n^^other^^\n'))
    const preserved = [...t.nodes.values()].find(n => n.content === 'hl')!
    expect(preserved).toBeDefined()
    expect(preserved.source).toBe('manual')          // converted, no longer synced
    expect(preserved.anchorLine).toBeUndefined()      // stale anchor cleared
    expect(t.nodes.get('child')!.parentId).toBe(preserved.id)  // child stays under it
  })
  it('an all-auto note is NOT emptied when the main doc loses all its marks', () => {
    const t = build('## Section\n^^one^^\n[[Page]]\n')
    expect(t.nodes.size).toBeGreaterThan(0)
    syncAutoItems(t, deriveAutoItems('## Section\n\nplain body, no marks\n'))
    // Section toc survives (still a heading); the highlight + wikilink convert to
    // manual rather than vanish — the note keeps its content.
    expect(t.nodes.size).toBeGreaterThan(0)
    const contents = [...t.nodes.values()].map(n => n.content)
    expect(contents).toContain('one')
    expect([...t.nodes.values()].filter(n => n.source !== 'manual' && n.source !== 'toc')).toHaveLength(0)
  })
  it('anchorLine refreshes on match', () => {
    const t = build(md1)
    syncAutoItems(t, deriveAutoItems('intro\n\n# A\n## B\n^^hl^^\n'))
    expect([...t.nodes.values()].find(n => n.content === 'B')!.anchorLine).toBe(4)
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
    const b = [...t.nodes.values()].find(n => n.content === 'B')!
    addNode(t, { id: 'keep', parentId: b.id, order: 999, content: 'keep me', collapsed: false, source: 'manual' })
    regenerate(t, deriveAutoItems(md1))
    expect(t.nodes.get('keep')).toBeDefined()
    // md1 now derives a single top-level heading (B); H1 A is skipped.
    expect([...t.nodes.values()].filter(n => n.source === 'toc')).toHaveLength(1)
  })
})

describe('timestamps', () => {
  it('stamps createdAt on new highlight nodes but not toc nodes', () => {
    const t = build(md1)
    const nodes = [...t.nodes.values()]
    const toc = nodes.find(n => n.source === 'toc')!
    const hl = nodes.find(n => n.source === 'highlight')!
    expect(hl.createdAt).toBeDefined()
    expect(toc.createdAt).toBeUndefined()
  })
  it('keeps original createdAt on matched highlight across re-derive', () => {
    const t = build(md1)
    const hl = [...t.nodes.values()].find(n => n.source === 'highlight')!
    hl.createdAt = '2026-01-01T00:00:00.000Z'
    syncAutoItems(t, deriveAutoItems('# A\n## B\nmore\n^^hl^^\n'))
    const hl2 = [...t.nodes.values()].find(n => n.source === 'highlight')!
    expect(hl2.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('syncAutoItems — annotation note children', () => {
  it('creates an annotation node with a note child', () => {
    const tree = createTree()
    syncAutoItems(tree, [
      { source: 'annotation', content: '原文', note: '批注内容', depth: 0, anchorLine: 3 },
    ])
    const anno = [...tree.nodes.values()].find(n => n.source === 'annotation')!
    expect(anno.content).toBe('原文')
    const kids = childrenOf(tree, anno.id)
    expect(kids).toHaveLength(1)
    expect(kids[0].source).toBe('note')
    expect(kids[0].content).toBe('批注内容')
  })

  it('updates the note child in place when the md note changes', () => {
    const tree = createTree()
    syncAutoItems(tree, [{ source: 'annotation', content: '原文', note: '旧', depth: 0, anchorLine: 1 }])
    const noteId = [...tree.nodes.values()].find(n => n.source === 'note')!.id
    syncAutoItems(tree, [{ source: 'annotation', content: '原文', note: '新', depth: 0, anchorLine: 1 }])
    const note = tree.nodes.get(noteId)!
    expect(note.content).toBe('新')
  })

  it('preserves a vanished annotation (and its note comment) as manual instead of deleting', () => {
    const tree = createTree()
    syncAutoItems(tree, [{ source: 'annotation', content: '原文', note: 'n', depth: 0, anchorLine: 1 }])
    syncAutoItems(tree, [])
    expect(tree.nodes.size).toBe(2)
    const nodes = [...tree.nodes.values()]
    expect(nodes.every(n => n.source === 'manual')).toBe(true)
    expect(nodes.map(n => n.content).sort()).toEqual(['n', '原文'])
  })

  it('keeps manual children of an annotation node alongside the note child', () => {
    const tree = createTree()
    syncAutoItems(tree, [{ source: 'annotation', content: '原文', note: 'n', depth: 0, anchorLine: 1 }])
    const anno = [...tree.nodes.values()].find(n => n.source === 'annotation')!
    tree.nodes.set('m1', {
      id: 'm1', parentId: anno.id, order: 500, content: '手写', collapsed: false, source: 'manual',
    })
    syncAutoItems(tree, [{ source: 'annotation', content: '原文', note: 'n2', depth: 0, anchorLine: 1 }])
    const kids = childrenOf(tree, anno.id)
    expect(kids.map(k => k.source).sort()).toEqual(['manual', 'note'])
    expect(kids.find(k => k.source === 'note')!.content).toBe('n2')
  })
})
