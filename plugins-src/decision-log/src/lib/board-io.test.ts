import { describe, it, expect } from 'vitest'
import { serializeBoard, parseBoard, serializeArchive, parseArchive } from './board-io'
import type { OpenDecision, ArchivedDecision } from './model'

const dec: OpenDecision = {
  id: '2026-07-21-01', title: '先做 MVP', prediction: '两周内发出 MVP',
  confidence: 'medium', 'check-date': '2026-08-04', created: '2026-07-21',
  origin: 'manual', strikes: 0,
}

describe('board-io', () => {
  it('board round-trips through .note.md', () => {
    const md = serializeBoard([dec])
    expect(md).toMatch(/^---\n/)                 // front-matter first
    expect(md).toContain('type: decision-board')
    expect(md).toContain('# 未决决策')            // human-readable mirror body
    expect(md).toContain('先做 MVP')
    const back = parseBoard(md)
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ id: '2026-07-21-01', prediction: '两周内发出 MVP', strikes: 0 })
  })
  it('parseBoard on empty/missing returns []', () => {
    expect(parseBoard('')).toEqual([])
    expect(parseBoard('# no frontmatter')).toEqual([])
  })
  it('archive round-trips', () => {
    const a: ArchivedDecision = { ...dec, status: 'closed', outcome: 'hit', 'still-endorse': true } as any
    const md = serializeArchive('2026-08-04', [a])
    expect(md).toContain('type: decision-archive')
    expect(md).toContain('resolved: 2026-08-04')
    const back = parseArchive(md)
    expect(back[0]).toMatchObject({ id: '2026-07-21-01', outcome: 'hit', 'still-endorse': true })
  })
})
