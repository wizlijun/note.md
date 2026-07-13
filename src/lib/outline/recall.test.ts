// src/lib/outline/recall.test.ts
import { describe, it, expect } from 'vitest'
import { parseOutline } from './markdown'
import { recallNodes, recallTree } from './recall'

/** parse outline text and recall carrier nodes for `page` */
function recall(text: string, page: string) {
  return recallNodes(parseOutline(text), page)
}

/** parse outline text and recall carriers as nested trees for `page` */
function recallT(text: string, page: string) {
  return recallTree(parseOutline(text), page)
}

describe('recallNodes', () => {
  it('direct hit: node carrying [[Target]], no ancestors or children', () => {
    expect(recall('- see [[Target]] here\n', 'target')).toEqual([
      { text: 'see [[Target]] here', breadcrumb: [], subtree: [] },
    ])
  })

  it('inheritance: parent carries the link, children fold into its subtree (not separate hits)', () => {
    const text = '- [[项目X]]\n  - 今天发现 A\n  - 又想到 B\n'
    expect(recall(text, '项目x')).toEqual([
      { text: '[[项目X]]', breadcrumb: [], subtree: ['今天发现 A', '又想到 B'] },
    ])
  })

  it('breadcrumb: deep carrier records ancestor chain root→parent', () => {
    const text = '- 根\n  - 父\n    - 命中 [[X]]\n'
    expect(recall(text, 'x')).toEqual([
      { text: '命中 [[X]]', breadcrumb: ['根', '父'], subtree: [] },
    ])
  })

  it('dedup: a nested carrier under a carrier is NOT a separate hit (topmost only)', () => {
    const text = '- [[X]] 顶\n  - 中\n    - 又 [[X]] 底\n'
    expect(recall(text, 'x')).toEqual([
      { text: '[[X]] 顶', breadcrumb: [], subtree: ['中', '又 [[X]] 底'] },
    ])
  })

  it('hashtag #X carries the page too', () => {
    expect(recall('- 关于 #Target 的想法\n', 'target')).toEqual([
      { text: '关于 #Target 的想法', breadcrumb: [], subtree: [] },
    ])
  })

  it('multiple independent carriers each become a hit', () => {
    const text = '- a [[X]]\n- b\n  - c [[X]]\n'
    expect(recall(text, 'x')).toEqual([
      { text: 'a [[X]]', breadcrumb: [], subtree: [] },
      { text: 'c [[X]]', breadcrumb: ['b'], subtree: [] },
    ])
  })

  it('no carriers → empty', () => {
    expect(recall('- nothing here\n  - nor here\n', 'x')).toEqual([])
  })
})

describe('recallTree', () => {
  it('carrier keeps its subtree nested (for collapse/expand)', () => {
    const text = '- [[X]] 顶\n  - 中\n    - 底\n'
    expect(recallT(text, 'x')).toEqual([
      {
        breadcrumb: [],
        node: {
          text: '[[X]] 顶',
          children: [{ text: '中', children: [{ text: '底', children: [] }] }],
        },
      },
    ])
  })

  it('deep carrier records breadcrumb and nests its own children', () => {
    const text = '- 根\n  - 父\n    - 命中 [[X]]\n      - 子1\n      - 子2\n'
    expect(recallT(text, 'x')).toEqual([
      {
        breadcrumb: ['根', '父'],
        node: {
          text: '命中 [[X]]',
          children: [
            { text: '子1', children: [] },
            { text: '子2', children: [] },
          ],
        },
      },
    ])
  })

  it('topmost carrier only; nested carrier folds inside its tree', () => {
    const text = '- [[X]] 顶\n  - 又 [[X]] 底\n'
    expect(recallT(text, 'x')).toEqual([
      {
        breadcrumb: [],
        node: { text: '[[X]] 顶', children: [{ text: '又 [[X]] 底', children: [] }] },
      },
    ])
  })
})
