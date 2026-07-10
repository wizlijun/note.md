// src/lib/outline/store.test.ts
import { describe, it, expect } from 'vitest'
import { companionPathFor, persistIdsFor, isEffectivelyEmpty } from './store.svelte'
import { createTree, addNode } from './model'

describe('companionPathFor', () => {
  it('maps main file to sibling .note.md', () => {
    expect(companionPathFor('/d/foo.md')).toBe('/d/foo.note.md')
    expect(companionPathFor('/d/bar.markdown')).toBe('/d/bar.note.md')
  })
  it('null for companion files themselves (new and legacy suffix) and non-md', () => {
    expect(companionPathFor('/d/foo.note.md')).toBeNull()
    expect(companionPathFor('/d/foo.notes.md')).toBeNull()
    expect(companionPathFor('/d/FOO.NOTE.MD')).toBeNull()
    expect(companionPathFor('/d/x.png')).toBeNull()
  })
})

describe('persistIdsFor', () => {
  it('collects block-ref targets and auto nodes with manual children', () => {
    const t = createTree()
    addNode(t, { id: 'toc1', parentId: null, order: 0, content: 'T', collapsed: false, source: 'toc', anchorLine: 1 })
    addNode(t, { id: 'm1', parentId: 'toc1', order: 0, content: 'child', collapsed: false, source: 'manual' })
    addNode(t, { id: 'm2', parentId: null, order: 100, content: 'see ((m1))', collapsed: false, source: 'manual' })
    const ids = persistIdsFor(t)
    expect(ids.has('toc1')).toBe(true)   // auto 带手写子节点 → 保 id
    expect(ids.has('m1')).toBe(true)     // 被 ((m1)) 引用
    expect(ids.has('m2')).toBe(false)
  })
})

describe('isEffectivelyEmpty', () => {
  it('true when tree has only empty manual nodes', () => {
    const t = createTree()
    addNode(t, { id: 'm1', parentId: null, order: 0, content: '', collapsed: false, source: 'manual' })
    addNode(t, { id: 'm2', parentId: null, order: 100, content: '   ', collapsed: false, source: 'manual' })
    expect(isEffectivelyEmpty(t)).toBe(true)
  })
  it('true for a brand-new empty tree', () => {
    expect(isEffectivelyEmpty(createTree())).toBe(true)
  })
  it('false when any manual node has content', () => {
    const t = createTree()
    addNode(t, { id: 'm1', parentId: null, order: 0, content: 'hi', collapsed: false, source: 'manual' })
    expect(isEffectivelyEmpty(t)).toBe(false)
  })
  it('false when any auto node exists', () => {
    const t = createTree()
    addNode(t, { id: 'toc1', parentId: null, order: 0, content: 'H', collapsed: false, source: 'toc', anchorLine: 1 })
    expect(isEffectivelyEmpty(t)).toBe(false)
  })
})
