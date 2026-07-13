// src/lib/outline/commands.test.ts
import { describe, it, expect } from 'vitest'
import {
  createSiblingBelow, createSiblingAbove, indentNode, outdentNode,
  moveNodeUp, moveNodeDown, mergeWithPrevious, applyInlineWrap,
  subtreeToMarkdown, deleteNodes, indentNodes, outdentNodes, moveNodesAfter, moveNodesToChild, nodesToMarkdown,
  insertPastedTree,
} from './commands'
import { createTree, addNode, childrenOf, type OutlineTree } from './model'

function manualTree(): OutlineTree {
  const t = createTree()
  addNode(t, { id: 'a', parentId: null, order: 0, content: 'A', collapsed: false, source: 'manual' })
  addNode(t, { id: 'b', parentId: null, order: 100, content: 'B', collapsed: false, source: 'manual' })
  addNode(t, { id: 'b1', parentId: 'b', order: 0, content: 'B1', collapsed: false, source: 'manual' })
  return t
}

describe('create siblings (hulunote render.cljs:806/846)', () => {
  it('below: inserts between b and next; returns new id', () => {
    const t = manualTree()
    const id = createSiblingBelow(t, 'a')!
    const roots = childrenOf(t, null).map(n => n.id)
    expect(roots).toEqual(['a', id, 'b'])
  })
  it('above: first sibling gets order before current', () => {
    const t = manualTree()
    const id = createSiblingAbove(t, 'a')!
    expect(childrenOf(t, null)[0].id).toBe(id)
  })
})

describe('indent / outdent (render.cljs:918/952)', () => {
  it('indent moves under prev sibling as last child; no prev sibling → no-op', () => {
    const t = manualTree()
    expect(indentNode(t, 'a')).toBe(false)     // 无前兄弟
    expect(indentNode(t, 'b')).toBe(true)
    expect(t.nodes.get('b')!.parentId).toBe('a')
  })
  it('outdent makes node next sibling of its parent', () => {
    const t = manualTree()
    expect(outdentNode(t, 'b1')).toBe(true)
    expect(t.nodes.get('b1')!.parentId).toBeNull()
    expect(childrenOf(t, null).map(n => n.id)).toEqual(['a', 'b', 'b1'])
  })
  it('structure ops refuse auto nodes', () => {
    const t = manualTree()
    addNode(t, { id: 'toc1', parentId: null, order: 200, content: 'T', collapsed: false, source: 'toc', anchorLine: 1 })
    expect(indentNode(t, 'toc1')).toBe(false)
    expect(outdentNode(t, 'toc1')).toBe(false)
    expect(createSiblingBelow(t, 'toc1')).not.toBeNull() // 在 auto 节点旁新建手写节点是允许的
  })
})

describe('move up/down', () => {
  it('swaps order with adjacent sibling', () => {
    const t = manualTree()
    expect(moveNodeDown(t, 'a')).toBe(true)
    expect(childrenOf(t, null).map(n => n.id)).toEqual(['b', 'a'])
    expect(moveNodeUp(t, 'a')).toBe(true)
    expect(childrenOf(t, null).map(n => n.id)).toEqual(['a', 'b'])
  })
})

describe('mergeWithPrevious', () => {
  it('appends content to previous visible node and removes current (childless)', () => {
    const t = manualTree()
    const res = mergeWithPrevious(t, 'b1')   // prev visible = b
    expect(res).toEqual({ mergedInto: 'b', joinAt: 1 })  // joinAt = 原内容长度
    expect(t.nodes.get('b')!.content).toBe('BB1')
    expect(t.nodes.get('b1')).toBeUndefined()
  })
  it('refuses when node has children', () => {
    const t = manualTree()
    expect(mergeWithPrevious(t, 'b')).toBeNull()
  })
})

describe('applyInlineWrap (render.cljs:1003)', () => {
  it('wraps selection', () => {
    expect(applyInlineWrap('hello world', 6, 11, '**')).toEqual({ text: 'hello **world**', selStart: 8, selEnd: 13 })
  })
  it('inserts paired markers at collapsed caret, caret centered', () => {
    expect(applyInlineWrap('ab', 1, 1, '__')).toEqual({ text: 'a____b', selStart: 3, selEnd: 3 })
  })
})

describe('subtreeToMarkdown', () => {
  it('indents multi-line content continuations', () => {
    const t = createTree()
    addNode(t, { id: 'c', parentId: null, order: 0, content: '```js\nconst x = 1\n```', collapsed: false, source: 'manual' })
    expect(subtreeToMarkdown(t, 'c')).toBe('- ```js\n  const x = 1\n  ```\n')
  })
})

describe('manual node timestamps', () => {
  it('stamps createdAt on createSiblingBelow/Above', () => {
    const t = manualTree()
    const below = t.nodes.get(createSiblingBelow(t, 'a')!)!
    const above = t.nodes.get(createSiblingAbove(t, 'a')!)!
    expect(below.createdAt).toBeDefined()
    expect(above.createdAt).toBeDefined()
  })
  it('stamps updatedAt on merge target', () => {
    const t = manualTree()
    addNode(t, { id: 'a2', parentId: null, order: 50, content: 'tail', collapsed: false, source: 'manual' })
    const res = mergeWithPrevious(t, 'a2')!
    expect(res.mergedInto).toBe('a')
    expect(t.nodes.get('a')!.updatedAt).toBeDefined()
  })
})

describe('batch commands (multi-select)', () => {
  // a ── b(b1) ── c 全 manual
  function batchTree(): OutlineTree {
    const t = createTree()
    addNode(t, { id: 'a', parentId: null, order: 0, content: 'A', collapsed: false, source: 'manual' })
    addNode(t, { id: 'b', parentId: null, order: 100, content: 'B', collapsed: false, source: 'manual' })
    addNode(t, { id: 'b1', parentId: 'b', order: 0, content: 'B1', collapsed: false, source: 'manual' })
    addNode(t, { id: 'c', parentId: null, order: 200, content: 'C', collapsed: false, source: 'manual' })
    return t
  }
  it('deleteNodes removes manual roots with subtrees, skips auto', () => {
    const t = batchTree()
    t.nodes.get('a')!.source = 'toc'
    expect(deleteNodes(t, new Set(['a', 'b', 'b1']))).toBe(true)
    expect([...t.nodes.keys()].sort()).toEqual(['a', 'c'])
  })
  it('indentNodes moves the group under the previous unselected sibling', () => {
    const t = batchTree()
    expect(indentNodes(t, new Set(['b', 'c']))).toBe(true)
    expect(childrenOf(t, 'a').map(n => n.id)).toEqual(['b', 'c'])
    expect(childrenOf(t, 'b').map(n => n.id)).toEqual(['b1'])  // 子树随动
  })
  it('indentNodes no-ops when group leads its siblings', () => {
    const t = batchTree()
    expect(indentNodes(t, new Set(['a']))).toBe(false)
  })
  it('outdentNodes keeps relative order', () => {
    const t = batchTree()
    addNode(t, { id: 'b2', parentId: 'b', order: 100, content: 'B2', collapsed: false, source: 'manual' })
    expect(outdentNodes(t, new Set(['b1', 'b2']))).toBe(true)
    expect(childrenOf(t, null).map(n => n.id)).toEqual(['a', 'b', 'b1', 'b2', 'c'])
  })
  it('moveNodesAfter moves group after target preserving order', () => {
    const t = batchTree()
    expect(moveNodesAfter(t, new Set(['a', 'b']), 'c')).toBe(true)
    expect(childrenOf(t, null).map(n => n.id)).toEqual(['c', 'a', 'b'])
  })
  it('moveNodesToChild appends group as children of target', () => {
    const t = batchTree()
    expect(moveNodesToChild(t, new Set(['a', 'c']), 'b')).toBe(true)
    expect(childrenOf(t, 'b').map(n => n.id)).toEqual(['b1', 'a', 'c'])
  })
  it('nodesToMarkdown serializes selection roots with subtrees', () => {
    const t = batchTree()
    expect(nodesToMarkdown(t, new Set(['b', 'b1']))).toBe('- B\n  - B1\n')
  })
})

describe('insertPastedTree (paste hierarchy)', () => {
  // helper: 树按可见序返回 [content, depth]
  function flat(t: OutlineTree) {
    const out: Array<{ content: string; depth: number }> = []
    const walk = (pid: string | null, depth: number) => {
      for (const n of childrenOf(t, pid)) { out.push({ content: n.content, depth }); walk(n.id, depth + 1) }
    }
    walk(null, 0)
    return out
  }

  it('first line merges into current node; rest attach by relative depth', () => {
    const t = manualTree() // roots: a(''=>'A'), b('B') with child b1
    const parsed = [
      { depth: 0, content: 'X0' },
      { depth: 1, content: 'X1' },
      { depth: 0, content: 'X2' },
    ]
    insertPastedTree(t, 'a', '', '', parsed)
    // a becomes 'X0'; X1 is a's child; X2 is a's sibling (after a, before b)
    expect(t.nodes.get('a')!.content).toBe('X0')
    expect(flat(t)).toEqual([
      { content: 'X0', depth: 0 },
      { content: 'X1', depth: 1 },
      { content: 'X2', depth: 0 },
      { content: 'B', depth: 0 },
      { content: 'B1', depth: 1 },
    ])
  })

  it('head is preserved before first pasted line', () => {
    const t = manualTree()
    insertPastedTree(t, 'a', 'HEAD ', '', [{ depth: 0, content: 'first' }, { depth: 0, content: 'second' }])
    expect(t.nodes.get('a')!.content).toBe('HEAD first')
  })

  it('tail is appended to the last created node', () => {
    const t = manualTree()
    const lastId = insertPastedTree(t, 'a', '', ' TAIL', [
      { depth: 0, content: 'p0' },
      { depth: 1, content: 'p1' },
    ])
    expect(t.nodes.get(lastId)!.content).toBe('p1 TAIL')
  })

  it('deeper nodes append AFTER current node existing children', () => {
    const t = manualTree() // b already has child b1
    insertPastedTree(t, 'b', '', '', [
      { depth: 0, content: 'B*' },
      { depth: 1, content: 'newkid' },
    ])
    const kids = childrenOf(t, 'b').map(n => n.content)
    expect(kids).toEqual(['B1', 'newkid']) // existing B1 stays first
  })

  it('returns currentNodeId and only sets content when parsed has a single line', () => {
    const t = manualTree()
    const ret = insertPastedTree(t, 'a', 'H', 'T', [{ depth: 0, content: 'solo' }])
    expect(ret).toBe('a')
    expect(t.nodes.get('a')!.content).toBe('HsoloT')
    expect(childrenOf(t, null).map(n => n.id)).toEqual(['a', 'b']) // no new nodes
  })

  it('new nodes are manual with createdAt', () => {
    const t = manualTree()
    const lastId = insertPastedTree(t, 'a', '', '', [{ depth: 0, content: 'p0' }, { depth: 0, content: 'p1' }])
    const n = t.nodes.get(lastId)!
    expect(n.source).toBe('manual')
    expect(typeof n.createdAt).toBe('string')
  })

  it('multiple same-depth siblings keep paste order and precede original next sibling', () => {
    const t = manualTree()
    insertPastedTree(t, 'a', '', '', [
      { depth: 0, content: 's0' },
      { depth: 0, content: 's1' },
      { depth: 0, content: 's2' },
    ])
    expect(childrenOf(t, null).map(n => n.content)).toEqual(['s0', 's1', 's2', 'B'])
  })
})
