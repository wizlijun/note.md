// @vitest-environment node
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseIndex } from './parser'

const assets = new URL('../../../../skills/file-index/assets/', import.meta.url)

describe('bundled index templates', () => {
  it.each([
    { view: 'table', groupBy: '', laneBy: '', rows: 4 },
    { view: 'list', groupBy: '', laneBy: '', rows: 4 },
    { view: 'board', groupBy: '状态', laneBy: '项目', rows: 4 },
    { view: 'gallery', groupBy: '阅读状态', laneBy: '', rows: 2 },
  ])('parses $view with real nonempty file and cover targets', ({ view, groupBy, laneBy, rows }) => {
    const source = new URL(`${view}.index.md`, assets)
    const doc = parseIndex(readFileSync(source, 'utf8'), fileURLToPath(source))
    expect(doc).not.toBeNull()
    expect(doc).toMatchObject({ view, groupBy, laneBy })
    expect(doc!.rows).toHaveLength(rows)
    if (view === 'list') expect(new Set(doc!.rows.map(row => row.section))).toEqual(new Set(['工作 / 查看器', '兴趣 / 个人阅读']))
    for (const row of doc!.rows) {
      const targets = [row.href, ...row.cells.flatMap(cell => [...cell.links.filter(link => link.kind !== 'page').map(link => link.href), ...cell.images.map(image => image.href)])]
      for (const target of new Set(targets)) {
        const resolved = new URL(target, source)
        expect(resolved.protocol).toBe('file:')
        expect(resolved.href.startsWith(assets.href)).toBe(true)
        expect(statSync(resolved).isFile()).toBe(true)
        expect(statSync(resolved).size).toBeGreaterThan(0)
      }
      if (view === 'gallery') {
        expect(row.cover).toBeDefined()
        const cover = readFileSync(new URL(row.cover!.href, source))
        expect([...cover.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
      }
    }
  })
})
