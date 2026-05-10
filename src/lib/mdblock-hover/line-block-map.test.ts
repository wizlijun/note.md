import { describe, it, expect } from 'vitest'
import { buildLineBlockMap, type LineBlockEntry } from './line-block-map'
import type { ActiveBlock } from '../blockio/yaml-schema'

function ab(id: string, line: number): ActiveBlock {
  return {
    id, src_line: line, src_pos: 0,
    fingerprint: { hash: '', length: 0, minhash: '' },
    parents: [], created_gen: 1,
  }
}

describe('buildLineBlockMap', () => {
  it('maps each line to the active block that covers it', () => {
    const blocks = [ab('b-aaaaaa', 1), ab('b-bbbbbb', 5), ab('b-cccccc', 10)]
    const map = buildLineBlockMap(blocks, 12)
    expect(map.get(1)).toEqual({ blockid: 'b-aaaaaa', isStart: true })
    expect(map.get(2)).toEqual({ blockid: 'b-aaaaaa', isStart: false })
    expect(map.get(4)).toEqual({ blockid: 'b-aaaaaa', isStart: false })
    expect(map.get(5)).toEqual({ blockid: 'b-bbbbbb', isStart: true })
    expect(map.get(9)).toEqual({ blockid: 'b-bbbbbb', isStart: false })
    expect(map.get(10)).toEqual({ blockid: 'b-cccccc', isStart: true })
    expect(map.get(12)).toEqual({ blockid: 'b-cccccc', isStart: false })
  })

  it('returns empty map for empty active', () => {
    expect(buildLineBlockMap([], 5).size).toBe(0)
  })

  it('handles a single block covering all lines', () => {
    const map = buildLineBlockMap([ab('b-aaaaaa', 1)], 100)
    for (let i = 1; i <= 100; i++) {
      expect(map.get(i)?.blockid).toBe('b-aaaaaa')
    }
    expect(map.get(1)?.isStart).toBe(true)
    expect(map.get(50)?.isStart).toBe(false)
  })
})
