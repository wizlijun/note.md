import { describe, expect, it } from 'vitest'
import { planCity, segmentDistance, type CityPlan } from './city-plan'
import type { ProjectedLot } from './city-projection'
import type { Edge } from './types'

const lot = (id: string, x: number, z: number, style?: string, zone = 'concept') => ({ node: { id, nodeType: 'concept', evidence: [id] }, x, z, style, zone })
const edge = (id: string, a: string, b: string): Edge => ({ id, participants: [{ node: a, role: 'source' }, { node: b, role: 'target' }], edgeType: 'wikilink', status: 'observed', evidence: [id], verifiedFamilies: 1, provisionalFamilies: 0, unresolvedLineage: 0 })
function city(): ProjectedLot[] {
  return Array.from({ length: 81 }, (_, i) => Array.from({ length: 12 }, (_, j) => lot(`node-${i}-${j}`, (i % 9) * 8 + j * .05, Math.floor(i / 9) * 8 + j * .05, undefined, i % 3 ? 'concept' : 'unassigned'))).flat()
}
const skeleton = (plan: CityPlan) => plan.roads.map(({ id, points }) => ({ id, points }))
function assertClearances(plan: CityPlan) {
  for (let i = 0; i < plan.placements.length; i++) {
    const a = plan.placements[i]
    for (const road of plan.roads) for (let j = 1; j < road.points.length; j++) {
      expect(segmentDistance(a, road.points[j - 1], road.points[j]), `building ${a.id} overlaps road ${road.id}`).toBeGreaterThanOrEqual(a.footprint + road.width / 2 + .5)
    }
    for (const b of plan.placements.slice(i + 1)) expect(Math.hypot(a.x - b.x, a.z - b.z), `${a.id} overlaps ${b.id}`).toBeGreaterThanOrEqual(a.footprint + b.footprint + .2)
  }
}

describe('deterministic game city plan', () => {
  it('covers every original object and preserves identity through aggregation', () => {
    const lots = city(), plan = planCity(lots, [])
    expect(plan.parcels.flatMap(p => p.members)).toHaveLength(lots.length)
    expect(new Set(plan.parcels.flatMap(p => p.members))).toEqual(new Set(lots))
    expect([...plan.positions.keys()].sort()).toEqual(lots.map(l => l.node.id).sort())
    expect(plan.placements.length).toBeGreaterThan(120)
    expect(plan.placements.length).toBeLessThanOrEqual(650)
    for (const placement of plan.placements) expect(plan.positions.get(placement.id)).toEqual({ x: placement.x, z: placement.z })
  })

  it('produces the same geometry and routes after reordering its inputs', () => {
    const lots = city(), links = [edge('ab', 'node-0-0', 'node-80-0'), edge('bc', 'node-20-0', 'node-40-0')]
    const expected = planCity(lots, links)
    expect(planCity([...lots].reverse(), [...links].reverse())).toEqual(expected)
    expect(lots[0].node.id).toBe('node-0-0')
    expect(expected.roads.filter(r => Math.abs(r.points[0].x - r.points[1].x) > .5 && Math.abs(r.points[0].z - r.points[1].z) > .5).length).toBeGreaterThan(expected.roads.length / 2)
  })

  it('adds traffic along existing roads without moving buildings or narrowing any path', () => {
    const lots = city(), first = [edge('a', 'node-0-0', 'node-80-0')]
    const base = planCity(lots, []), linked = planCity(lots, first), more = planCity(lots, [...first, edge('b', 'node-0-0', 'node-80-0'), edge('c', 'node-7-0', 'node-19-0')])
    expect(skeleton(linked)).toEqual(skeleton(base))
    expect(skeleton(more)).toEqual(skeleton(base))
    expect(more.placements).toEqual(base.placements)
    expect(linked.roads.some(r => r.traffic > 0)).toBe(true)
    for (let i = 0; i < linked.roads.length; i++) expect(more.roads[i].width).toBeGreaterThanOrEqual(linked.roads[i].width)
  })

  it('retains the supported relation weights and does not turn hyperedges into binary links', () => {
    const lots = [lot('a', 0, 0), lot('b', 16, 0), lot('c', 32, 0)]
    const baseline = planCity(lots, [])
    const hyper = { ...edge('hyper', 'a', 'b'), participants: [...edge('hyper', 'a', 'b').participants, { node: 'c', role: 'subject' }] }
    expect(planCity(lots, [hyper, { ...edge('candidate', 'a', 'b'), status: 'candidate' }])).toEqual(baseline)
    const direct = { ...edge('link', 'a', 'b'), verifiedFamilies: 0 }
    const observed = planCity(lots, [direct]), verified = planCity(lots, [edge('verified', 'a', 'b')])
    const tagged = planCity(lots, [{ ...direct, edgeType: 'tagged_with' }]), imported = planCity(lots, [{ ...direct, status: 'imported' }])
    expect(observed.roads.some(r => r.traffic === 1)).toBe(true)
    expect(verified.roads.some(r => r.traffic === 2)).toBe(true)
    expect(tagged.roads.some(r => r.traffic === .35)).toBe(true)
    expect(imported.roads.some(r => r.traffic === .12)).toBe(true)
  })

  it('joins the whole street network at identical vertices and routes distant parcels', () => {
    const plan = planCity(city(), []), graph = new Map<string, string[]>()
    for (const road of plan.roads) {
      const [a, b] = road.points.map(p => JSON.stringify(p))
      for (const [from, to] of [[a, b], [b, a]]) graph.set(from, [...(graph.get(from) ?? []), to])
    }
    const queue = [graph.keys().next().value!], seen = new Set<string>()
    for (const at of queue) {
      if (seen.has(at)) continue
      seen.add(at); queue.push(...graph.get(at)!)
    }
    expect(seen.size).toBe(graph.size)
    for (const target of ['node-8-0', 'node-40-0', 'node-72-0', 'node-80-0']) {
      expect(planCity(city(), [edge('route', 'node-0-0', target)]).roads.some(r => r.traffic > 0)).toBe(true)
    }
  })

  it('uses a settlement-shaped perimeter and fills long street frontages with unique representatives', () => {
    const lots = Array.from({ length: 36 }, (_, i) => lot(`n${i}`, (i % 6) * 8, Math.floor(i / 6) * 8))
      .flatMap(l => Array.from({ length: 20 }, (_, j) => ({ ...l, node: { ...l.node, id: `${l.node.id}-${j}` } })))
    const plan = planCity(lots, [])
    const ownership = new Map<string, number>()
    for (const p of plan.parcels) for (let i = 0; i < p.polygon.length; i++) {
      const key = [JSON.stringify(p.polygon[i]), JSON.stringify(p.polygon[(i + 1) % p.polygon.length])].sort().join('|')
      ownership.set(key, (ownership.get(key) ?? 0) + 1)
    }
    const boundary = [...ownership].filter(([, count]) => count === 1)
    expect(boundary.length).toBeGreaterThan(12)
    expect(new Set(plan.placements.map(p => p.id)).size).toBe(plan.placements.length)
    expect(plan.placements.filter(p => p.footprint >= 1.2).length).toBeGreaterThan(plan.placements.length / 2)
    expect(Math.max(...plan.parcels.map(p => plan.placements.filter(b => b.parcelId === p.id).length))).toBeGreaterThanOrEqual(5)
    assertClearances(plan)
  })

  it('keeps actual building footprints clear of every road and building, including large landmarks', () => {
    const lots = [...city(), lot('campus', 24, 24, 'campus'), lot('camp', 48, 48, 'camp')]
    const links = Array.from({ length: 200 }, (_, i) => edge(`e${i}`, 'node-0-0', 'node-80-0'))
    const plan = planCity(lots, links)
    expect(plan.positions.size).toBe(lots.length)
    expect(plan.placements.find(p => p.id === 'campus')?.footprint).toBeGreaterThanOrEqual(5.5)
    expect(plan.placements.find(p => p.id === 'camp')?.footprint).toBeGreaterThanOrEqual(6)
    assertClearances(plan)
  })

  it('handles no data, one object, and coincident landmarks without invalid geometry', () => {
    expect(planCity([], [])).toEqual({ parcels: [], roads: [], placements: [], positions: new Map() })
    const single = planCity([lot('one', 0, 0)], [])
    expect(single.positions.size).toBe(1)
    expect(single.placements).toHaveLength(1)
    const coincident = planCity([lot('a', 0, 0, 'campus'), lot('b', 0, 0, 'camp')], [])
    expect(coincident.placements).toHaveLength(2)
    assertClearances(coincident)
  })
})

describe('keyword community districts', () => {
  const topic = (id: string, x: number, z: number) => ({ id, key: id, label: `${id} · 主题`, nodeType: 'topic', status: 'candidate', x, z })
  const membership = (node: string, topic: string, role = 'primary', score = 1) => ({ id: `${node}:${topic}`, node, topic, role, score })
  it('uses primary communities even when unrelated keywords have identical coordinates', () => {
    const lots = [lot('a', 0, 0), lot('b', 0, 0), lot('c', 0, 0), lot('isolated', 0, 0)]
    const communities = { topics: [topic('one', 0, 0), topic('two', 0, 0)], memberships: [membership('a', 'one'), membership('b', 'one'), membership('c', 'two'), membership('c', 'one', 'secondary')] }
    const plan = planCity(lots, [], communities)
    expect(plan.parcels).toHaveLength(3)
    expect(plan.parcels.find(p => p.topicId === 'one')?.members.map(m => m.node.id).sort()).toEqual(['a', 'b'])
    expect(plan.parcels.find(p => p.topicId === 'two')?.members.map(m => m.node.id)).toEqual(['c'])
    expect(plan.parcels.find(p => p.kind === 'growth')?.members[0].node.id).toBe('isolated')
    expect(plan.parcels.find(p => p.topicId === 'one')?.name).toBe('one · 主题')
    expect(planCity([...lots].reverse(), [], { topics: [...communities.topics].reverse(), memberships: [...communities.memberships].reverse() })).toEqual(plan)
    expect(plan.roads.every(r => r.traffic === 0)).toBe(true)
    assertClearances(plan)
  })
  it('keeps distinct landmark campuses without absorbing a neighbouring community', () => {
    const lots = [lot('hemory', 0, 0, 'campus'), lot('notemd', 0, 0, 'campus'), lot('member', 0, 0), lot('other', 0, 0)]
    const plan = planCity(lots, [], { topics: [topic('projects', 0, 0), topic('other-topic', 1, 1)], memberships: [membership('hemory', 'projects'), membership('notemd', 'projects'), membership('member', 'projects'), membership('other', 'other-topic')] })
    expect(plan.parcels.filter(p => p.kind === 'campus')).toHaveLength(2)
    expect(plan.placements.filter(p => p.kind === 'campus').map(p => p.id).sort()).toEqual(['hemory', 'notemd'])
    expect(plan.parcels.filter(p => p.kind === 'campus').every(p => p.members.every(m => m.node.id !== 'other'))).toBe(true)
    expect(plan.positions.size).toBe(lots.length)
    assertClearances(plan)
  })
  it('routes supported statistical links on local streets without asserting them as explicit facts', () => {
    const lots = [lot('a', 0, 0), lot('b', 1, 1)]
    const communities = { topics: [topic('one', 0, 0)], memberships: [membership('a', 'one'), membership('b', 'one')] }
    const baseline = planCity(lots, [], communities)
    const link = { ...edge('statistical', 'a', 'b'), edgeType: 'co_occurs', status: 'statistical', verifiedFamilies: 3 }
    const statistical = planCity(lots, [link], communities)
    const explicit = planCity(lots, [edge('explicit', 'a', 'b')], communities)
    expect(skeleton(statistical)).toEqual(skeleton(baseline))
    expect(statistical.placements).toEqual(baseline.placements)
    expect(statistical.roads.some(r => r.traffic > 0)).toBe(true)
    expect(Math.max(...statistical.roads.map(r => r.traffic))).toBeLessThan(Math.max(...explicit.roads.map(r => r.traffic)))
    expect(planCity(lots, [{ ...link, verifiedFamilies: 0 }], communities)).toEqual(baseline)
  })
})

it('packs isolated keywords into stable exploration plots without fabricating communities or relationships', () => {
  const lots = Array.from({ length: 180 }, (_, i) => lot(`isolated-${i}`, (i % 18) * 2, Math.floor(i / 18) * 2))
  const communities = { topics: [], memberships: [] }
  const plan = planCity(lots, [], communities)
  expect(plan.parcels.length).toBeLessThan(10)
  expect(plan.parcels.every(p => p.unassigned && !p.topicId && p.kind === 'growth' && p.name === '待连接关键词')).toBe(true)
  expect(plan.roads.every(r => r.traffic === 0)).toBe(true)
  expect(plan.positions.size).toBe(lots.length)
  expect(planCity([...lots].reverse(), [], communities)).toEqual(plan)
  assertClearances(plan)
})

it('fits a sparse attention foreground without replacing its real community memberships', () => {
  const lots = [lot('a', -1000, 0), lot('b', 1000, 0), lot('c', 0, 1000)]
  const communities = { topics: lots.map(l => ({ ...l.node, id: `topic-${l.node.id}`, label: l.node.id, key: l.node.id, status: 'candidate', x: l.x, z: l.z })), memberships: lots.map(l => ({ id: `m-${l.node.id}`, node: l.node.id, topic: `topic-${l.node.id}`, role: 'primary', score: 1 })) }
  const historical = planCity(lots, [], communities), foreground = planCity(lots, [], { ...communities, focus: true })
  const identities = (plan: CityPlan) => plan.parcels.map(p => [p.id, p.topicId, p.members.map(l => l.node.id)])
  expect(identities(foreground)).toEqual(identities(historical))
  const span = (plan: CityPlan) => Math.max(...plan.parcels.map(p => p.center.x)) - Math.min(...plan.parcels.map(p => p.center.x))
  expect(span(foreground)).toBeLessThan(span(historical) / 5)
  expect(planCity([...lots].reverse(), [], { ...communities, focus: true })).toEqual(foreground)
  assertClearances(foreground)
})
