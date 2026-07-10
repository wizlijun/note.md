// src/lib/outline/commands.test.ts
import { describe, it, expect } from 'vitest'
import {
  createSiblingBelow, createSiblingAbove, indentNode, outdentNode,
  moveNodeUp, moveNodeDown, mergeWithPrevious, applyInlineWrap,
  subtreeToMarkdown, deleteNodes, indentNodes, outdentNodes, moveNodesAfter, moveNodesToChild, nodesToMarkdown,
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
