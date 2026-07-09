// src/lib/outline/commands.test.ts
import { describe, it, expect } from 'vitest'
import {
  createSiblingBelow, createSiblingAbove, indentNode, outdentNode,
  moveNodeUp, moveNodeDown, mergeWithPrevious, applyInlineWrap,
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
