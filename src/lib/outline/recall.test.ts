// src/lib/outline/recall.test.ts
import { describe, it, expect } from 'vitest'
import { parseOutline } from './markdown'
import { createIndex, indexFileContent } from './backlinks'
import { recallNodes, recallTree, editNodeInOutline, recallGrouped } from './recall'

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
  it('carrier keeps its subtree nested with root-index paths', () => {
    const text = '- [[X]] 顶\n  - 中\n    - 底\n'
    expect(recallT(text, 'x')).toEqual([
      {
        breadcrumb: [],
        node: {
          text: '[[X]] 顶', path: [0],
          children: [{ text: '中', path: [0, 0], children: [{ text: '底', path: [0, 0, 0], children: [] }] }],
        },
      },
    ])
  })

  it('deep carrier records breadcrumb, paths and nests its own children', () => {
    const text = '- 根\n  - 父\n    - 命中 [[X]]\n      - 子1\n      - 子2\n'
    expect(recallT(text, 'x')).toEqual([
      {
        breadcrumb: ['根', '父'],
        node: {
          text: '命中 [[X]]', path: [0, 0, 0],
          children: [
            { text: '子1', path: [0, 0, 0, 0], children: [] },
            { text: '子2', path: [0, 0, 0, 1], children: [] },
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
        node: { text: '[[X]] 顶', path: [0], children: [{ text: '又 [[X]] 底', path: [0, 0], children: [] }] },
      },
    ])
  })
})

describe('editNodeInOutline', () => {
  it('edits the node at path and reserializes', () => {
    expect(editNodeInOutline('- a\n  - b\n  - c\n', [0, 1], 'c', 'C!')).toBe('- a\n  - b\n  - C!\n')
  })

  it('returns null when old text mismatches (file changed underneath)', () => {
    expect(editNodeInOutline('- a\n  - b\n', [0, 0], 'STALE', 'x')).toBeNull()
  })

  it('returns null when the path is out of range', () => {
    expect(editNodeInOutline('- a\n', [3], 'a', 'x')).toBeNull()
  })

  it('refuses to edit a read-only (auto) node', () => {
    expect(editNodeInOutline('- hi\n  type:: highlight\n', [0], 'hi', 'x')).toBeNull()
  })
})

describe('recallGrouped (from cached index trees)', () => {
  function idxWith(files: Record<string, string>) {
    const idx = createIndex()
    for (const [p, c] of Object.entries(files)) indexFileContent(idx, p, c)
    return idx
  }

  it('groups carriers by file using the index-cached tree (no disk read)', () => {
    const idx = idxWith({
      '/v/a.note.md': '- [[X]]\n  - child A\n',
      '/v/b.note.md': '- 根\n  - 命中 [[X]]\n',
    })
    const groups = recallGrouped(idx, 'x')
    expect(groups.map(g => g.file).sort()).toEqual(['/v/a.note.md', '/v/b.note.md'])
    const a = groups.find(g => g.file === '/v/a.note.md')!
    expect(a.carriers[0].node.text).toBe('[[X]]')
    expect(a.carriers[0].node.children.map(c => c.text)).toEqual(['child A'])
    const b = groups.find(g => g.file === '/v/b.note.md')!
    expect(b.carriers[0].breadcrumb).toEqual(['根'])
  })

  it('excludes the current page file and pages with no carriers', () => {
    const idx = idxWith({ '/v/self.note.md': '- [[X]]\n', '/v/other.note.md': '- [[Y]]\n' })
    expect(recallGrouped(idx, 'x', '/v/self.note.md')).toEqual([])
  })
})
