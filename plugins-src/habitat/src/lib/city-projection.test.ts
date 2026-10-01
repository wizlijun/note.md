import { expect, it } from 'vitest'
import { districtCenter, overviewBlocks, overviewBuildings, streetPlan, streetSamples, visualPoint } from './city-projection'
import type { Edge } from './types'

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

function link(id: string, a: string, b: string, status = 'observed'): Edge {
  return { id, edgeType: 'wikilink', status, participants: [{ node: a, role: 'source' }, { node: b, role: 'target' }], evidence: [id], verifiedFamilies: 1, provisionalFamilies: 0, unresolvedLineage: 0 }
}

it('keeps visual districts and winding streets stable across input order', () => {
  const lots = [lot('a', 1, 1), lot('b', 9, 1), lot('c', 17, 1), lot('d', 1, 9)]
  const edges = [link('ab', 'a', 'b'), link('ac', 'a', 'c')]
  const blocks = overviewBlocks(lots)
  expect(streetPlan(blocks, edges, lots)).toEqual(streetPlan(overviewBlocks([...lots].reverse()), [...edges].reverse(), [...lots].reverse()))
  expect(overviewBuildings(blocks[0])).toEqual(overviewBuildings(overviewBlocks([...lots].reverse())[0]))
  expect(districtCenter(blocks[0])).toEqual(districtCenter(overviewBlocks([...lots].reverse())[0]))
  expect(streetPlan(blocks, edges, lots).some(road => {
    const [a, mid, b] = road.points
    return Math.abs((a[0] + b[0]) / 2 - mid[0]) + Math.abs((a[1] + b[1]) / 2 - mid[1]) > .01
  })).toBe(true)
})

it('widens shared and routed streets for explicit links, leaving candidates off the road', () => {
  const lots = [lot('a', 1, 1), lot('b', 9, 1), lot('c', 17, 1)]
  const blocks = overviewBlocks(lots), base = streetPlan(blocks, [], lots)
  const candidate = streetPlan(blocks, [link('ab-candidate', 'a', 'b', 'candidate')], lots)
  expect(candidate).toEqual(base)
  const adjacent = streetPlan(blocks, [link('ab', 'a', 'b')], lots)
  expect(adjacent.some(road => road.traffic >= 2 && road.width > .28)).toBe(true)
  const distant = streetPlan(blocks, [link('ac', 'a', 'c')], lots)
  expect(distant.some(road => road.traffic > 0)).toBe(true)
  expect(distant.every(road => road.points.length === 3)).toBe(true)
})

it('keeps road grades absolute and maps only binary, attributable links', () => {
  const lots = [lot('a', 1, 1), lot('b', 9, 1), lot('c', 17, 1)]
  const blocks = overviewBlocks(lots)
  const ab = streetPlan(blocks, [link('ab', 'a', 'b')], lots)
  const baseline = ab.find(road => road.traffic > 0)!
  const strongElsewhere = Array.from({ length: 15 }, (_, i) => link(`bc-${i}`, 'b', 'c'))
  expect(streetPlan(blocks, [link('ab', 'a', 'b'), ...strongElsewhere], lots).find(road => road.id === baseline.id)!.width).toBeGreaterThanOrEqual(baseline.width)
  expect(streetPlan(blocks, [link('ab', 'a', 'b'), link('ab-more', 'a', 'b')], lots).find(road => road.id === baseline.id)!.width).toBeGreaterThan(baseline.width)
  const unverified = { ...link('zero', 'a', 'b'), verifiedFamilies: 0 }
  const hyperedge = { ...link('three', 'a', 'b'), participants: [...link('three', 'a', 'b').participants, { node: 'c', role: 'target' }] }
  expect(streetPlan(blocks, [unverified], lots).find(road => road.id === baseline.id)!.width).toBeLessThan(baseline.width)
  expect(streetPlan(blocks, [hyperedge], lots)).toEqual(streetPlan(blocks, [], lots))
})

it('routes landmark links around the actual campus platform', () => {
  const lots = [lot('a', 1, 1), lot('hero', 9, 1, 'project', 2, 'campus'), lot('c', 17, 1)]
  const roads = streetPlan(overviewBlocks(lots), [link('a-hero', 'a', 'hero')], lots)
  expect(roads.some(road => road.traffic > 0)).toBe(true)
  const center = visualPoint(9, 1)
  for (const road of roads) for (const point of streetSamples(road)) {
    expect(Math.abs(point.x - center.x) >= 4.7 + .75 || Math.abs(point.z - center.z) >= 4.1 + .75).toBe(true)
  }
})

it('uses actual block occupancy to vary building density without moving saved positions', () => {
  const sparse = overviewBlocks([lot('s', 1, 1)])[0]
  const dense = overviewBlocks(Array.from({ length: 80 }, (_, i) => lot(`d${i}`, 9, 1)))[0]
  expect(overviewBuildings(sparse, 80)).toHaveLength(1)
  expect(overviewBuildings(dense, 80)).toHaveLength(9)
  expect([sparse.x, sparse.z, dense.x, dense.z]).toEqual([4, 4, 12, 4])
})

it('keeps the street surface clear of representative building centers', () => {
  const lots = Array.from({ length: 9 }, (_, block) => Array.from({ length: 12 }, (_, i) => {
    const bx = block % 3, bz = Math.floor(block / 3)
    return lot(`b${block}-${i}`, bx * 8 + 1 + i * .01, bz * 8 + 1)
  })).flat()
  const blocks = overviewBlocks(lots), roads = streetPlan(blocks, [link('a', 'b0-0', 'b1-0')], lots)
  const buildings = blocks.flatMap(block => overviewBuildings(block, 12).map(({ x, z }) => visualPoint(x, z)))
  let clearance = Infinity
  for (const road of roads) {
    const [a, control, b] = road.points
    for (let i = 0; i <= 12; i++) {
      const t = i / 12, s = 1 - t
      const point = visualPoint(s*s*a[0]+2*s*t*control[0]+t*t*b[0], s*s*a[1]+2*s*t*control[1]+t*t*b[1])
      for (const building of buildings) clearance = Math.min(clearance, Math.hypot(point.x-building.x, point.z-building.z)-road.width/2-.45)
    }
  }
  expect(clearance).toBeGreaterThan(0)
})

it('keeps wide street shoulders outside ordinary plot pads', () => {
  const lots = Array.from({ length: 25 }, (_, i) => lot(`p${i}`, i % 5 * 8 + 1, Math.floor(i / 5) * 8 + 1))
  const blocks = overviewBlocks(lots)
  const edges = Array.from({ length: 15 }, (_, i) => link(`crowded-${i}`, 'p0', 'p1'))
  const roads = streetPlan(blocks, edges, lots)
  let clearance = Infinity
  for (const block of blocks) {
    const center = districtCenter(block), p = visualPoint(center.x, center.z)
    for (const road of roads) for (const sample of streetSamples(road)) {
      clearance = Math.min(clearance, Math.hypot(sample.x - p.x, sample.z - p.z) - 1.95 - (road.width + .23) / 2)
    }
  }
  expect(clearance).toBeGreaterThan(0)
})
