import { expect, it } from 'vitest'
import { overviewBlocks } from './city-projection'

function lot(id: string, x: number, z: number, nodeType = 'concept', evidence = 0, style?: string) {
  return { node: { id, nodeType, evidence: Array.from({ length: evidence }, (_, i) => `e${i}`) }, x, z, style }
}

it('covers every ordinary object once while retaining original object references', () => {
  const lots = Array.from({ length: 100 }, (_, i) => lot(`n${i}`, i % 20, Math.floor(i / 20) * 4))
  const blocks = overviewBlocks(lots), members = blocks.flatMap(b => b.members)
  expect(members).toHaveLength(lots.length)
  expect(new Set(members.map(l => l.node.id)).size).toBe(lots.length)
  expect(new Set(members)).toEqual(new Set(lots))
  for (const block of blocks) {
    expect(block.representatives.length).toBeLessThanOrEqual(9)
    for (const representative of block.representatives) expect(block.members).toContain(representative)
  }
})

it('ranks bounded representatives by type, support, then stable identity', () => {
  const lots = [
    lot('project-b', 1, 1, 'project'), lot('project-a', 1, 1, 'project'),
    lot('entity-high', 1, 1, 'entity', 3), lot('concept-high', 1, 1, 'concept', 3),
    lot('concept-low', 1, 1, 'concept', 1), lot('document', 1, 1, 'document', 100),
    ...Array.from({ length: 10 }, (_, i) => lot(`topic-${i}`, 1, 1, 'topic')),
  ]
  const [block] = overviewBlocks(lots)
  expect(block.representatives.map(l => l.node.id)).toEqual(['project-a', 'project-b', 'concept-high', 'entity-high', 'concept-low', 'document', 'topic-0', 'topic-1', 'topic-2'])
  expect(block.members).toHaveLength(16)
})

it('returns identical blocks for reordered input without mutating the input', () => {
  const lots = [lot('b', 17, 1), lot('c', -1, 9), lot('a', 17, 1)]
  const before = [...lots]
  expect(overviewBlocks(lots)).toEqual(overviewBlocks([...lots].reverse()))
  expect(lots).toEqual(before)
})

it('uses floor-based eight-unit cells across negative coordinates and boundaries', () => {
  const blocks = overviewBlocks([lot('negative', -.1, -8), lot('next-negative', -8.1, 0), lot('origin', 0, 0), lot('boundary', 8, 8)])
  expect(blocks.map(b => [b.x, b.z, b.members[0].node.id])).toEqual([
    [-12, 4, 'next-negative'], [-4, -4, 'negative'], [4, 4, 'origin'], [12, 12, 'boundary'],
  ])
})

it('leaves named landmarks outside overview blocks', () => {
  const plain = lot('plain', 1, 1)
  const blocks = overviewBlocks([lot('campus', 1, 1, 'concept', 2, 'campus'), plain, lot('camp', 20, 20, 'concept', 2, 'camp')])
  expect(blocks).toHaveLength(1)
  expect(blocks[0].members).toEqual([plain])
  expect(overviewBlocks([])).toEqual([])
})
