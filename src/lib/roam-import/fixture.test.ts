// src/lib/roam-import/fixture.test.ts
import { describe, it, expect } from 'vitest'
import { parseRoamJson } from './parse'
import { assignFiles } from './plan'
import { convertPage } from './convert'
import { parseOutline } from '../outline/markdown'

const FIXTURE = JSON.stringify([
  { title: 'July 11th, 2026', uid: '07-11-2026', 'edit-time': 1,
    children: [
      { uid: 'day1', string: 'ref to ((tgt1)) and {{[[embed]]: ((tgt2))}}' },
      { uid: 'day2', string: '{{[[TODO]]}} task with [[Case Page]]' },
    ] },
  { title: 'Case Page', uid: 'w1', children: [
    { uid: 'tgt1', string: 'deep', children: [
      { uid: 'tgt2', string: 'deeper', children: [
        { uid: 'x1', string: 'code:\n```js\n__keep__\n```' },
        { uid: 'x2', string: 'line1\nid:: sneaky' },
      ] },
    ] },
  ] },
  { title: 'case page', uid: 'w2', children: [{ uid: 'y1', string: 'collides' }] },
])

describe('roam-import end-to-end (pure)', () => {
  const graph = parseRoamJson(FIXTURE)
  const assigned = assignFiles(graph.pages, { wikipage: 'wikipage', dailynote: 'dailynote' })

  it('routes daily + wiki files, dedupes collision', () => {
    expect(assigned.files.map((f) => f.relPath)).toEqual([
      'dailynote/2026/2026-07-11.note.md',
      'wikipage/Case Page.note.md',
      'wikipage/case page (2).note.md',
    ])
  })

  it('converted output round-trips through parseOutline with ids preserved', () => {
    const casePage = assigned.files[1]
    const out = convertPage(casePage.page, graph.referencedUids, assigned.renames)
    const tree = parseOutline(out.text)
    const ids = [...tree.nodes.keys()]
    expect(ids).toContain('tgt1')   // 被引用 → id:: 落盘并被解析回来
    expect(ids).toContain('tgt2')
    const contents = [...tree.nodes.values()].map((n) => n.content)
    expect(contents.some((c) => c.includes('```js\n__keep__\n```'))).toBe(true) // 代码块原样
    expect(contents.some((c) => c.includes(' id:: sneaky'))).toBe(true)         // 转义存活为内容
  })

  it('daily page links rewrite to the renamed collision target only when renamed', () => {
    const dailyOut = convertPage(assigned.files[0].page, graph.referencedUids, assigned.renames)
    expect(dailyOut.text).toContain('[[Case Page]]') // 未改名的不动
    expect(dailyOut.text).toContain('((tgt1))')
    expect(dailyOut.text).toContain('((tgt2))')      // embed 已降级
    expect(dailyOut.text).toContain('[ ] task')
  })
})
