import { describe, it, expect } from 'vitest'
import { parseBase } from './parse'

describe('parseBase', () => {
  it('extracts views with order and groupBy', () => {
    const cfg = parseBase(`
views:
  - type: table
    name: All
    order: [file.name, note.status]
    groupBy:
      property: note.status
      direction: DESC
`)
    expect(cfg.error).toBeUndefined()
    expect(cfg.views).toHaveLength(1)
    expect(cfg.views[0]).toMatchObject({
      type: 'table',
      name: 'All',
      order: ['file.name', 'note.status'],
      groupBy: { property: 'note.status', direction: 'DESC' },
    })
  })

  it('reads global filters and property displayNames', () => {
    const cfg = parseBase(`
filters:
  and:
    - file.hasTag("book")
properties:
  note.status:
    displayName: Status
views:
  - type: table
    name: T
`)
    expect(cfg.filters).toEqual({ and: ['file.hasTag("book")'] })
    expect(cfg.properties['note.status']).toEqual({ displayName: 'Status' })
  })

  it('defaults to one empty table view when views missing', () => {
    const cfg = parseBase('filters:\n  and: []\n')
    expect(cfg.error).toBeUndefined()
    expect(cfg.views).toHaveLength(1)
    expect(cfg.views[0].type).toBe('table')
  })

  it('returns an error for malformed YAML', () => {
    const cfg = parseBase('views: [unclosed')
    expect(cfg.error).toBeTruthy()
    expect(cfg.views).toHaveLength(1) // 仍给一个空表视图,UI 可渲染错误态
  })

  it('parses view.sort as a list of {property,direction}', () => {
    const cfg = parseBase(`
views:
  - type: table
    name: T
    sort:
      - property: note.rating
        direction: DESC
`)
    expect(cfg.views[0].sort).toEqual([{ property: 'note.rating', direction: 'DESC' }])
  })

  it('leaves view.sort undefined when absent', () => {
    const cfg = parseBase('views:\n  - type: table\n    name: T\n')
    expect(cfg.views[0].sort).toBeUndefined()
  })
})
