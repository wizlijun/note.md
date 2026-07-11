// src/lib/roam-import/convert.test.ts
import { describe, it, expect } from 'vitest'
import { convertPage, maxEditTime } from './convert'
import type { RoamPage } from './types'

const page: RoamPage = {
  title: 'My Page', uid: 'pg1',
  'create-time': 1600000000000, 'edit-time': 1600000001000,
  children: [
    { uid: 'aaa111', string: 'parent {{[[TODO]]}} item', 'create-time': 1600000002000, 'edit-time': 1600000003000,
      children: [{ uid: 'bbb222', string: 'child', heading: 2 }] },
  ],
}

describe('convertPage', () => {
  it('produces front-matter with original title and serialized outline', () => {
    const out = convertPage(page, new Set(), new Map())
    expect(out.text).toMatch(/^---\ntitle: My Page\n/)
    expect(out.text).toContain('- parent [ ] item')
    expect(out.text).toContain('  - ## child')
    expect(out.text).toContain('created:: 2020-09-13T12:26:42.000Z')
    expect(out.text).toContain('updated:: 2020-09-13T12:26:43.000Z')
  })

  it('writes id:: only for referenced uids', () => {
    const out = convertPage(page, new Set(['bbb222']), new Map())
    expect(out.text).toContain('id:: bbb222')
    expect(out.text).not.toContain('id:: aaa111')
  })

  it('rewrites renamed links and escapes reserved props', () => {
    const p: RoamPage = { title: 'X', children: [
      { uid: 'u1', string: 'see [[a/b]]' },
      { uid: 'u2', string: 'multi\nid:: not-a-prop' },
    ] }
    const out = convertPage(p, new Set(), new Map([['a/b', 'a-b']]))
    expect(out.text).toContain('[[a-b]]')
    expect(out.text).toContain('\n   id:: not-a-prop') // 续行缩进 2 + 转义空格 1
  })

  it('empty page still yields one empty node', () => {
    const out = convertPage({ title: 'Empty' }, new Set(), new Map())
    expect(out.text).toMatch(/---\n- \n$/)
  })

  it('daily note title becomes the yyyy-MM-dd date (native convention)', () => {
    const daily: RoamPage = { title: 'August 15th, 2022', uid: '08-15-2022',
      children: [{ uid: 'd1', string: 'note' }] }
    const out = convertPage(daily, new Set(), new Map())
    expect(out.title).toBe('2022-08-15')
    expect(out.text).toMatch(/^---\ntitle: 2022-08-15\n/)
  })

  it('normalizes English date links to yyyy-MM-dd even without a matching page', () => {
    const p: RoamPage = { title: 'X', children: [
      { uid: 'u1', string: 'went out on [[August 15th, 2022]] and #[[July 1st, 2026]]' },
    ] }
    const out = convertPage(p, new Set(), new Map())
    expect(out.text).toContain('[[2022-08-15]]')
    expect(out.text).toContain('[[2026-07-01]]')
    expect(out.text).not.toContain('August 15th')
  })
})

describe('maxEditTime', () => {
  it('takes the max across page and all blocks', () => {
    expect(maxEditTime(page)).toBe(1600000003000)
    expect(maxEditTime({ title: 'x' })).toBe(0)
  })
})
