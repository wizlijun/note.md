import { isAssertedRelation, isExplicit } from './domain'
import { visualPoint, type ProjectedLot } from './city-projection'
import type { Edge, Membership, Node } from './types'

export interface CityPoint { x: number; z: number }
export interface CityParcel {
  id: string; center: CityPoint; polygon: CityPoint[]; members: ProjectedLot[]
  kind: 'neighborhood' | 'growth' | 'campus' | 'park'
  topicId?: string; name?: string; unassigned?: boolean
}
export interface CityRoad { id: string; points: CityPoint[]; width: number; traffic: number; tier: number; bridge?: boolean }
export interface CityRiver {
  /** River centerline follows the former shared border between the two banks. */
  points: CityPoint[]
  /** Cross-river axis; points increase along the other axis. */
  axis: 'x' | 'z'
  halfWidth: number
  bankWidth: number
  /** Distance each bank moved away from the original centerline. */
  setback: number
}
export interface CityPlacement {
  id: string; parcelId: string; x: number; z: number; rotation: number
  /** Ground-plane bounding-circle radius, including all model accessories. */
  footprint: number; kind: 'house' | 'midrise' | 'construction' | 'campus' | 'camp'
}
export interface CityPlan {
  parcels: CityParcel[]; roads: CityRoad[]; placements: CityPlacement[]; positions: Map<string, CityPoint>
  river?: CityRiver
}

const MAX_ROAD_WIDTH = 1.8
const ROAD_MARGIN = MAX_ROAD_WIDTH / 2 + .5
const hash = (key: string) => {
  let n = 2166136261
  for (const c of key) n = Math.imul(n ^ c.charCodeAt(0), 16777619)
  return (n >>> 0) / 4294967296
}
const distance = (a: CityPoint, b: CityPoint) => Math.hypot(a.x - b.x, a.z - b.z)
const vertexKey = (p: CityPoint) => `${Math.round(p.x * 10000)},${Math.round(p.z * 10000)}`

/** Signed horizontal distance from the same winding water edge used by the terrain. */
export function riverDistance(river: CityRiver, point: CityPoint) {
  const along = river.axis === 'x' ? 'z' : 'x', cross = river.axis
  const points = river.points
  if (points.length < 2) return Infinity
  if (point[along] < points[0][along] || point[along] > points.at(-1)![along]) return Infinity
  let lo = 0, hi = points.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (points[mid][along] <= point[along]) lo = mid
    else hi = mid
  }
  const a = points[lo], b = points[lo + 1]
  const t = (point[along] - a[along]) / (b[along] - a[along])
  return Math.abs(point[cross] - (a[cross] + (b[cross] - a[cross]) * t)) - river.halfWidth
}
const rank = (lot: ProjectedLot) => lot.style ? 0 : lot.node.nodeType === 'project' ? 1 : ['concept', 'entity'].includes(lot.node.nodeType) ? 2 : 3
const compareLots = (a: ProjectedLot, b: ProjectedLot) => rank(a) - rank(b) || (b.node.attentionScore ?? 0) - (a.node.attentionScore ?? 0) || (b.node.evidence?.length ?? 0) - (a.node.evidence?.length ?? 0) || a.node.id.localeCompare(b.node.id)

export function segmentDistance(p: CityPoint, a: CityPoint, b: CityPoint) {
  const dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz
  const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2)) : 0
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t)
}

function clip(polygon: CityPoint[], normal: CityPoint, limit: number): CityPoint[] {
  const result: CityPoint[] = []
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length]
    const da = a.x * normal.x + a.z * normal.z - limit, db = b.x * normal.x + b.z * normal.z - limit
    if (da <= 1e-8) result.push(a)
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db)
      result.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })
    }
  }
  return result
}

function inside(p: CityPoint, polygon: CityPoint[]) {
  let sign = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length]
    const cross = (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x)
    if (Math.abs(cross) < 1e-7) continue
    if (sign && Math.sign(cross) !== sign) return false
    sign = Math.sign(cross)
  }
  return true
}

function convexHull(points: CityPoint[]) {
  const ordered = [...points].sort((a, b) => a.x - b.x || a.z - b.z)
  const cross = (a: CityPoint, b: CityPoint, c: CityPoint) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
  const half = (input: CityPoint[]) => {
    const result: CityPoint[] = []
    for (const p of input) {
      while (result.length > 1 && cross(result[result.length - 2], result[result.length - 1], p) <= 0) result.pop()
      result.push(p)
    }
    return result
  }
  return [...half(ordered).slice(0, -1), ...half(ordered.reverse()).slice(0, -1)]
}

/** Reserve a dry corridor without deforming a parcel or changing its members. */
function reserveRiver(parcels: CityParcel[]): { river: CityRiver; bridges: [CityPoint, CityPoint][] } | undefined {
  if (parcels.length < 2) return undefined
  const extentX = Math.max(...parcels.map(p => p.center.x)) - Math.min(...parcels.map(p => p.center.x))
  const extentZ = Math.max(...parcels.map(p => p.center.z)) - Math.min(...parcels.map(p => p.center.z))
  const sides = new Map<string, { a: CityPoint; b: CityPoint; owners: string[] }>()
  for (const parcel of parcels) for (let i = 0; i < parcel.polygon.length; i++) {
    const a = parcel.polygon[i], b = parcel.polygon[(i + 1) % parcel.polygon.length]
    if (distance(a, b) < .001) continue
    const ak = vertexKey(a), bk = vertexKey(b), id = ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`
    const side = sides.get(id)
    if (side) side.owners.push(parcel.id)
    else sides.set(id, { a, b, owners: [parcel.id] })
  }
  type Candidate = { axis: 'x' | 'z'; left: Set<string>; chain: CityPoint[]; stretch: number; balance: number }
  const candidates: Candidate[] = []
  for (const axis of ['x', 'z'] as const) {
    const along: 'x' | 'z' = axis === 'x' ? 'z' : 'x'
    const sorted = [...parcels].sort((a, b) => a.center[axis] - b.center[axis] || a.id.localeCompare(b.id))
    const minBank = Math.max(1, Math.ceil(parcels.length * .25)), maxBank = Math.min(parcels.length - 1, Math.floor(parcels.length * .75))
    for (let split = minBank; split <= maxBank; split++) {
      if (sorted[split - 1].center[axis] >= sorted[split].center[axis]) continue
      const left = new Set(sorted.slice(0, split).map(p => p.id))
      const seam = [...sides.values()].filter(s => s.owners.length === 2 && left.has(s.owners[0]) !== left.has(s.owners[1]))
      if (!seam.length) continue
      const vertices = new Map<string, CityPoint>(), neighbors = new Map<string, string[]>()
      for (const side of seam) {
        const a = vertexKey(side.a), b = vertexKey(side.b)
        vertices.set(a, side.a); vertices.set(b, side.b)
        neighbors.set(a, [...(neighbors.get(a) ?? []), b]); neighbors.set(b, [...(neighbors.get(b) ?? []), a])
      }
      const ends = [...neighbors].filter(([, adjacent]) => adjacent.length === 1).map(([id]) => id)
      if (ends.length !== 2 || [...neighbors.values()].some(adjacent => adjacent.length > 2)) continue
      ends.sort((a, b) => vertices.get(a)![along] - vertices.get(b)![along] || a.localeCompare(b))
      const chain: CityPoint[] = [], visited = new Set<string>()
      for (let at = ends[0], from = ''; at && !visited.has(at);) {
        chain.push(vertices.get(at)!); visited.add(at)
        const next: string | undefined = neighbors.get(at)!.find(id => id !== from)
        from = at; at = next ?? ''
      }
      if (chain.length !== vertices.size || vertexKey(chain.at(-1)!) !== ends[1]) continue
      if (chain.some((p, i) => i > 0 && p[along] <= chain[i - 1][along] + 1e-4)) continue
      const stretch = Math.max(...chain.slice(1).map((p, i) => Math.hypot(1, (p[axis] - chain[i][axis]) / (p[along] - chain[i][along]))))
      candidates.push({ axis, left, chain, stretch, balance: Math.abs(parcels.length - 2 * split) })
    }
  }
  candidates.sort((a, b) => a.stretch - b.stretch || a.balance - b.balance || a.axis.localeCompare(b.axis)
    || a.chain.map(vertexKey).join('|').localeCompare(b.chain.map(vertexKey).join('|')))
  const choice = candidates[0]
  if (!choice) return undefined
  const { axis, left, chain, stretch } = choice
  // A two-parcel city has only the two edge endpoints; add a central road
  // vertex so its sole bridge crosses the city rather than hugging the rim.
  if (chain.length === 2) {
    const [a, b] = chain, midpoint = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
    const seamKey = [vertexKey(a), vertexKey(b)].sort().join('|')
    for (const parcel of parcels) for (let i = parcel.polygon.length - 1; i >= 0; i--) {
      const p = parcel.polygon[i], q = parcel.polygon[(i + 1) % parcel.polygon.length]
      if ([vertexKey(p), vertexKey(q)].sort().join('|') === seamKey) parcel.polygon.splice(i + 1, 0, midpoint)
    }
    chain.splice(1, 0, midpoint)
  }
  const span = Math.max(extentX, extentZ, 24), halfWidth = Math.max(1.5, Math.min(8, span * .024))
  const bankWidth = Math.max(1.2, Math.min(3, span * .012))
  const setback = halfWidth + bankWidth + (MAX_ROAD_WIDTH / 2 + .21) * stretch + .35
  const move = (p: CityPoint, direction: number): CityPoint => ({ ...p, [axis]: p[axis] + direction * setback })
  for (const parcel of parcels) {
    const direction = left.has(parcel.id) ? -1 : 1
    parcel.center = move(parcel.center, direction)
    parcel.polygon = parcel.polygon.map(p => move(p, direction))
  }
  const bridgeCount = Math.min(5, Math.max(1, Math.floor(chain.length / 3)))
  const bridgePoints = Array.from({ length: bridgeCount }, (_, i) => chain[Math.round((i + .5) / bridgeCount * (chain.length - 1))])
  return { river: { points: chain, axis, halfWidth, bankWidth, setback }, bridges: [...new Map(bridgePoints.map(p => [vertexKey(p), [move(p, -1), move(p, 1)] as [CityPoint, CityPoint]])).values()] }
}

/** Statistical support affects capacity, but never becomes an asserted semantic fact. */
export function relationWeight(edge: Edge) {
  if (edge.participants.length === 2 && ['co_occurs', 'co_discussed'].includes(edge.edgeType) && edge.status === 'statistical') {
    const support = edge.verifiedFamilies + edge.provisionalFamilies * .5 + edge.unresolvedLineage * .15
    return Math.min(.8, .15 * Math.log1p(support))
  }
  if (edge.participants.length !== 2 || edge.status === 'candidate') return 0
  if (isAssertedRelation(edge) && edge.evidence.length > 0) return 1
  return edge.verifiedFamilies > 0 && isExplicit(edge) ? 2
    : edge.status === 'observed' && ['explicit_reference', 'wikilink', 'links_to', 'cites'].includes(edge.edgeType) ? 1
    : edge.status === 'observed' && edge.edgeType === 'tagged_with' ? .35
    : edge.status === 'imported' ? .12 : 0
}

export interface CommunityPlan { focus?: boolean; memberships: Membership[]; topics: (Node & { x: number; z: number })[] }

const SEMANTIC_BLOCK_CAPACITY = 12
const semanticFootprint = (focus?: boolean) => focus ? 2.2 : 1.45

/** A disk of this radius fits every address, including the widest future street. */
function semanticRadius(members: ProjectedLot[], focus?: boolean) {
  const hero = members.find(l => l.style)
  if (hero) return 5
  const footprint = semanticFootprint(focus), positions = semanticSlots(members.length, footprint * 2 + .24)
  const occupied = Math.max(...positions.map(p => Math.hypot(p.x, p.z))) + footprint + ROAD_MARGIN + .02
  // The city's perimeter uses a regular dodecagon: reserve its smaller inradius.
  return Math.max(focus ? 3.9 : 3.1, occupied / Math.cos(Math.PI / 12))
}

/** Fixed addresses depend on membership, never attention or building strength. */
function semanticSlots(count: number, spacing: number): CityPoint[] {
  if (count === 1) return [{ x: 0, z: 0 }]
  if (count <= 6) {
    const radius = spacing / (2 * Math.sin(Math.PI / count))
    return Array.from({ length: count }, (_, i) => ({ x: Math.cos(i / count * Math.PI * 2) * radius, z: Math.sin(i / count * Math.PI * 2) * radius }))
  }
  const columns = Math.ceil(Math.sqrt(count)), rows = Math.ceil(count / columns)
  return Array.from({ length: count }, (_, i) => {
    const row = Math.floor(i / columns), rowSize = Math.min(columns, count - row * columns)
    return { x: (i % columns - (rowSize - 1) / 2) * spacing, z: (row - (rows - 1) / 2) * spacing }
  })
}

/** Membership owns the district; coordinates only choose its place in the city. */
function semanticParcels(lots: ProjectedLot[], communities: CommunityPlan): CityParcel[] {
  const topics = new Map(communities.topics.map(t => [t.id, t]))
  const primary = new Map([...communities.memberships].filter(m => m.role === 'primary' && topics.has(m.topic))
    .sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic)).reverse().map(m => [m.node, m.topic]))
  const groups = new Map<string, ProjectedLot[]>()
  for (const lot of lots) {
    // Unconnected words share explicitly non-semantic exploration plots, never a fabricated community.
    const key = primary.get(lot.node.id) ?? `exploration:${Math.floor(lot.x / 12)}:${Math.floor(lot.z / 12)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(lot)
  }
  const parcels: CityParcel[] = []
  // Physical blocks preserve the original topic; they do not assert new communities.
  // Each landmark owns one address, while neighbouring concepts get their own houses.
  const entries = [...groups].flatMap(([topicId, members]) => {
    const heroes = members.filter(l => l.style).sort((a, b) => a.node.id.localeCompare(b.node.id))
    const ordinary = members.filter(l => !l.style).sort((a, b) => a.node.id.localeCompare(b.node.id))
    const blocks = []
    for (const hero of heroes) blocks.push({ id: heroes.length === 1 && !ordinary.length ? topicId : `${topicId}:${hero.node.id}`, topicId, members: [hero] })
    for (let start = 0; start < ordinary.length; start += SEMANTIC_BLOCK_CAPACITY) {
      blocks.push({ id: !heroes.length && ordinary.length <= SEMANTIC_BLOCK_CAPACITY ? topicId : `${topicId}:block:${ordinary[start].node.id}`, topicId, members: ordinary.slice(start, start + SEMANTIC_BLOCK_CAPACITY) })
    }
    return blocks
  }).sort((a, b) => Number(b.members.some(l => l.style)) - Number(a.members.some(l => l.style)) || a.id.localeCompare(b.id))
  const originFor = (topicId: string, members: ProjectedLot[]) => {
    const topic = topics.get(topicId), cell = !topic && topicId.startsWith('exploration:') ? topicId.split(':').slice(1).map(Number) : null
    return topic ?? (cell ? { x: cell[0] * 12 + 6, z: cell[1] * 12 + 6 } : members[0])
  }
  const origins = entries.map(entry => originFor(entry.topicId, entry.members))
  const extent = Math.max(1, Math.max(...origins.map(p => p.x)) - Math.min(...origins.map(p => p.x)), Math.max(...origins.map(p => p.z)) - Math.min(...origins.map(p => p.z)))
  // Focus frames only its visible districts; archived empty space is not carried into the foreground.
  const scale = communities.focus ? Math.min(.5, Math.sqrt(entries.reduce((sum, entry) => sum + semanticRadius(entry.members, communities.focus) ** 2, 0)) * 1.1 / extent) : .5
  const radii = new Map<string, number>()
  for (const { id, topicId, members } of entries) {
    members.sort((a, b) => a.node.id.localeCompare(b.node.id))
    const topic = topics.get(topicId), hero = members.find(l => l.style)
    const origin = originFor(topicId, members)
    // Semantic layout reserves generous analytical spacing; use a compact city-scale projection.
    const original = visualPoint(origin.x * scale, origin.z * scale)
    let center = original
    const radius = semanticRadius(members, communities.focus)
    for (let step = 0; parcels.some(p => distance(p.center, center) < radius + radii.get(p.id)!); step++) {
      const angle = hash(id) * Math.PI * 2 + step * 2.399963
      const span = communities.focus ? radius * 2 + Math.sqrt(step) * 3 : 12 + Math.sqrt(step) * 6
      center = { x: original.x + Math.cos(angle) * span, z: original.z + Math.sin(angle) * span }
    }
    radii.set(`community:${id}`, radius)
    parcels.push({ id: `community:${id}`, center, polygon: [], members,
      kind: hero?.style === 'camp' ? 'park' : hero ? 'campus' : topic ? 'neighborhood' : 'growth',
      topicId: topic?.id, name: topic?.label ?? '待连接关键词', unassigned: !topic })
  }
  return parcels
}

/** Semantic snapshots use communities; legacy snapshots retain their original spatial containers. */
export function planCity(lots: ProjectedLot[], edges: Edge[], communities?: CommunityPlan): CityPlan {
  const plan: CityPlan = { parcels: [], roads: [], placements: [], positions: new Map() }
  const valid = lots.filter(l => Number.isFinite(l.x) && Number.isFinite(l.z)).sort(compareLots)
  if (!valid.length) return plan
  const semantic = communities ? semanticParcels(valid, communities) : null
  const heroes: CityParcel[] = semantic?.filter(p => p.kind === 'campus' || p.kind === 'park') ?? []
  for (const lot of (semantic ? [] : valid.filter(l => l.style))) {
    const original = visualPoint(lot.x, lot.z)
    let center = original
    // Coincident named landmarks retain separate addresses and enough room for their campuses.
    for (let step = 0; heroes.some(h => distance(h.center, center) < 21); step++) {
      const angle = hash(lot.node.id) * Math.PI * 2 + step * 2.399963
      const radius = 21 + Math.sqrt(step) * 5
      center = { x: original.x + Math.cos(angle) * radius, z: original.z + Math.sin(angle) * radius }
    }
    heroes.push({ id: `landmark:${lot.node.id}`, center, polygon: [], members: [lot], kind: lot.style === 'camp' ? 'park' : 'campus' })
  }
  const cells = new Map<string, CityParcel>()
  for (const lot of (semantic ? [] : valid.filter(l => !l.style))) {
    const ix = Math.floor(lot.x / 8), iz = Math.floor(lot.z / 8), id = `district:${ix}:${iz}`
    let parcel = cells.get(id)
    if (!parcel) {
      // A substantial stable displacement changes street topology, rather than merely bending a grid.
      const center = visualPoint(ix * 8 + 4 + (hash(`${id}:x`) - .5) * 4.4, iz * 8 + 4 + (hash(`${id}:z`) - .5) * 4.4)
      parcel = { id, center, polygon: [], members: [], kind: 'neighborhood' }
      cells.set(id, parcel)
    }
    parcel.members.push(lot)
  }
  const ordinary: CityParcel[] = semantic?.filter(p => p.kind !== 'campus' && p.kind !== 'park') ?? []
  for (const parcel of [...cells.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const hero = heroes.filter(h => distance(h.center, parcel.center) < 18).sort((a, b) => distance(a.center, parcel.center) - distance(b.center, parcel.center) || a.id.localeCompare(b.id))[0]
    if (hero) hero.members.push(...parcel.members)
    else {
      if (parcel.members.filter(l => l.zone === 'unassigned').length > parcel.members.length / 2) parcel.kind = 'growth'
      ordinary.push(parcel)
    }
  }
  plan.parcels = [...heroes, ...ordinary].sort((a, b) => a.id.localeCompare(b.id))
  for (const parcel of plan.parcels) parcel.members.sort(communities ? (a, b) => a.node.id.localeCompare(b.node.id) : compareLots)
  // Follow the settlement's convex outline, instead of adding empty rectangular outer districts.
  const extent = convexHull(plan.parcels.flatMap(parcel => Array.from({ length: 12 }, (_, i) => {
    const angle = i / 12 * Math.PI * 2, margin = communities ? semanticRadius(parcel.members, communities.focus) : parcel.kind === 'campus' || parcel.kind === 'park' ? 9.5 : 6
    return { x: parcel.center.x + Math.cos(angle) * margin, z: parcel.center.z + Math.sin(angle) * margin }
  })))
  for (const parcel of plan.parcels) {
    let polygon = extent
    for (const other of plan.parcels) {
      if (parcel === other) continue
      const normal = { x: other.center.x - parcel.center.x, z: other.center.z - parcel.center.z }
      const areaWeight = communities ? semanticRadius(parcel.members, communities.focus) ** 2 - semanticRadius(other.members, communities.focus) ** 2 : 0
      const limit = (other.center.x ** 2 + other.center.z ** 2 - parcel.center.x ** 2 - parcel.center.z ** 2 + areaWeight) / 2
      polygon = clip(polygon, normal, limit)
    }
    parcel.polygon = polygon.map(p => ({ x: Math.round(p.x * 10000) / 10000, z: Math.round(p.z * 10000) / 10000 }))
  }
  const crossing = reserveRiver(plan.parcels)
  if (crossing) plan.river = crossing.river
  const roads = new Map<string, CityRoad>(), parcelRoads = new Map<string, string[]>()
  for (const parcel of plan.parcels) {
    const ids: string[] = []
    for (let i = 0; i < parcel.polygon.length; i++) {
      const a = parcel.polygon[i], b = parcel.polygon[(i + 1) % parcel.polygon.length]
      if (distance(a, b) < .001) continue
      const ak = vertexKey(a), bk = vertexKey(b), id = ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`
      if (!roads.has(id)) roads.set(id, { id, points: ak < bk ? [a, b] : [b, a], width: .42, traffic: 0, tier: 0 })
      ids.push(id)
    }
    parcelRoads.set(parcel.id, ids.sort())
  }
  for (const [a, b] of crossing?.bridges ?? []) {
    const id = `bridge:${vertexKey(a)}|${vertexKey(b)}`
    roads.set(id, { id, points: [a, b], width: .42, traffic: 0, tier: 0, bridge: true })
  }
  plan.roads = [...roads.values()].sort((a, b) => a.id.localeCompare(b.id))

  // Route aggregated relations over the existing road graph. A shared border is the local street.
  const nodeParcels = new Map(plan.parcels.flatMap(p => p.members.map(l => [l.node.id, p.id] as const)))
  const pairWeights = new Map<string, number>()
  const localRelations: { edge: Edge; parcel: string; weight: number }[] = []
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    const weight = relationWeight(edge)
    if (!weight) continue
    const a = nodeParcels.get(edge.participants[0].node), b = nodeParcels.get(edge.participants[1].node)
    if (!a || !b) continue
    if (a === b) {
      if (communities) localRelations.push({ edge, parcel: a, weight })
      continue
    }
    const key = JSON.stringify(a < b ? [a, b] : [b, a])
    pairWeights.set(key, (pairWeights.get(key) ?? 0) + weight)
  }
  const graph = new Map<string, { to: string; road: string }[]>()
  for (const road of plan.roads) {
    const a = vertexKey(road.points[0]), b = vertexKey(road.points[1])
    for (const [from, to] of [[a, b], [b, a]]) {
      if (!graph.has(from)) graph.set(from, [])
      graph.get(from)!.push({ to, road: road.id })
    }
  }
  for (const neighbors of graph.values()) neighbors.sort((a, b) => a.road.localeCompare(b.road))
  const entrance = (parcelId: string) => {
    const road = roads.get(parcelRoads.get(parcelId)![0])!
    return vertexKey(road.points[0])
  }
  const route = (start: string, target: string, weight: number) => {
    const queue = [start]
    const visited = new Set([start]), previous = new Map<string, { from: string; road: string }>()
    for (let i = 0; i < queue.length && !visited.has(target); i++) {
      for (const next of graph.get(queue[i]) ?? []) {
        if (visited.has(next.to)) continue
        visited.add(next.to); previous.set(next.to, { from: queue[i], road: next.road }); queue.push(next.to)
      }
    }
    if (!visited.has(target)) return
    for (let at = target; at !== start;) {
      const step = previous.get(at)!
      roads.get(step.road)!.traffic += weight; at = step.from
    }
  }
  for (const [key, weight] of [...pairWeights].sort(([a], [b]) => a.localeCompare(b))) {
    const [a, b] = JSON.parse(key) as [string, string], aRoads = parcelRoads.get(a)!, bRoads = parcelRoads.get(b)!
    const shared = aRoads.find(id => bRoads.includes(id))
    if (shared) { roads.get(shared)!.traffic += weight; continue }
    const start = entrance(a)
    let target = entrance(b)
    if (target === start) target = bRoads.flatMap(id => roads.get(id)!.points.map(vertexKey)).find(id => id !== start)!
    route(start, target, weight)
  }


  const clearance = (p: CityPoint) => Math.min(...plan.roads.map(r => segmentDistance(p, r.points[0], r.points[1])))
  // Placements reserve the maximum street width so additional evidence never pushes buildings aside.
  if (communities) {
    for (const parcel of plan.parcels) {
      const hero = parcel.kind === 'campus' || parcel.kind === 'park'
      const radius = semanticFootprint(communities.focus)
      const sides = parcel.polygon.map((a, i) => ({ a, b: parcel.polygon[(i + 1) % parcel.polygon.length] }))
      const axis = [...sides].sort((a, b) => distance(b.a, b.b) - distance(a.a, a.b) || vertexKey(a.a).localeCompare(vertexKey(b.a)))[0]
      const angle = Math.atan2(axis.b.z - axis.a.z, axis.b.x - axis.a.x)
      const slots = semanticSlots(parcel.members.length, radius * 2 + .24)
      for (let i = 0; i < parcel.members.length; i++) {
        const lot = parcel.members[i], slot = slots[i]
        const point = { x: parcel.center.x + slot.x * Math.cos(angle) - slot.z * Math.sin(angle), z: parcel.center.z + slot.x * Math.sin(angle) + slot.z * Math.cos(angle) }
        const nearest = [...sides].sort((a, b) => segmentDistance(point, a.a, a.b) - segmentDistance(point, b.a, b.b))[0]
        const dx = nearest.b.x - nearest.a.x, dz = nearest.b.z - nearest.a.z
        const t = Math.max(0, Math.min(1, ((point.x - nearest.a.x) * dx + (point.z - nearest.a.z) * dz) / (dx * dx + dz * dz)))
        const rotation = Math.atan2(nearest.a.x + dx * t - point.x, nearest.a.z + dz * t - point.z)
        const footprint = hero ? 3.2 : radius
        const kind = hero ? parcel.kind === 'park' ? 'camp' : 'campus' : 'house'
        plan.placements.push({ id: lot.node.id, parcelId: parcel.id, ...point, rotation, footprint, kind })
        plan.positions.set(lot.node.id, point)
      }
    }
  }
  for (const parcel of (communities ? [] : [...heroes, ...ordinary])) {
    const local: CityPlacement[] = []
    const candidates: { point: CityPoint; rotation: number }[] = []
    const area = Math.abs(parcel.polygon.reduce((sum, a, i) => { const b = parcel.polygon[(i + 1) % parcel.polygon.length]; return sum + a.x * b.z - b.x * a.z }, 0)) / 2
    const target = parcel.kind === 'campus' || parcel.kind === 'park' ? 1 : Math.min(14, parcel.members.length, Math.max(3, Math.ceil(area / 12)))
    if (parcel.kind === 'campus' || parcel.kind === 'park') candidates.push({ point: parcel.center, rotation: hash(parcel.id) * .5 - .25 })
    else {
      const frontage = 2.9, spacing = 2.85
      const sides = parcel.polygon.map((a, i) => ({ a, b: parcel.polygon[(i + 1) % parcel.polygon.length] }))
        .sort((a, b) => distance(b.a, b.b) - distance(a.a, a.b) || vertexKey(a.a).localeCompare(vertexKey(b.a)))
      for (const { a, b } of sides) {
        const length = distance(a, b), dx = (b.x - a.x) / length, dz = (b.z - a.z) / length
        const slots = Math.max(1, Math.floor(length / spacing))
        for (let slot = 0; slot < slots; slot++) {
          const t = (slot + .5) / slots
          const road = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }
          const sign = (parcel.center.x - road.x) * -dz + (parcel.center.z - road.z) * dx > 0 ? 1 : -1
          const inward = { x: -dz * sign, z: dx * sign }
          candidates.push({ point: { x: road.x + inward.x * frontage, z: road.z + inward.z * frontage }, rotation: Math.atan2(-inward.x, -inward.z) })
        }
      }
      // A second aligned row fills deep blocks while the first row establishes the street frontage.
      const axis = sides[0], dx = axis.b.x - axis.a.x, dz = axis.b.z - axis.a.z, length = Math.hypot(dx, dz)
      const ux = dx / length, uz = dz / length, span = Math.sqrt(area) + 6
      for (let row = -Math.ceil(span / spacing); row <= Math.ceil(span / spacing); row++) {
        for (let col = -Math.ceil(span / spacing); col <= Math.ceil(span / spacing); col++) {
          const across = (col + (Math.abs(row) % 2) * .5) * spacing, inward = row * 2.55
          const point = { x: parcel.center.x + across * ux - inward * uz, z: parcel.center.z + across * uz + inward * ux }
          if (!inside(point, parcel.polygon)) continue
          const nearest = [...sides].sort((a, b) => segmentDistance(point, a.a, a.b) - segmentDistance(point, b.a, b.b))[0]
          const dx = nearest.b.x - nearest.a.x, dz = nearest.b.z - nearest.a.z
          const t = Math.max(0, Math.min(1, ((point.x - nearest.a.x) * dx + (point.z - nearest.a.z) * dz) / (dx * dx + dz * dz)))
          const rx = nearest.a.x + dx * t - point.x, rz = nearest.a.z + dz * t - point.z
          candidates.push({ point, rotation: Math.atan2(rx, rz) })
        }
      }
      candidates.push({ point: parcel.center, rotation: hash(parcel.id) * Math.PI })
    }
    for (const { point, rotation } of candidates) {
      if (local.length >= target || plan.placements.length >= 650) break
      const lot = parcel.members[local.length]
      if (!lot) break
      const hero = parcel.kind === 'campus' || parcel.kind === 'park'
      const roadSpace = clearance(point) - ROAD_MARGIN - .001
      const neighborSpace = Math.min(...plan.placements.map(p => distance(p, point) - p.footprint - .22))
      const desired = hero ? parcel.kind === 'park' ? 7 : 6.5 : 1.2 + hash(`${lot.node.id}:size`) * .25
      const footprint = Math.min(desired, roadSpace, neighborSpace)
      if (footprint < (hero ? .4 : 1) || !inside(point, parcel.polygon)) continue
      const status = (lot.node as ProjectedLot['node'] & { status?: string }).status
      const kind = hero ? parcel.kind === 'park' ? 'camp' : 'campus' : parcel.kind === 'growth' ? 'construction'
        : (lot.node.nodeType === 'project' && ['anchor', 'observed', 'confirmed', 'user-confirmed'].includes(status ?? ''))
          ? 'midrise' : 'house'
      const placement: CityPlacement = { id: lot.node.id, parcelId: parcel.id, ...point, rotation, footprint, kind }
      local.push(placement); plan.placements.push(placement)
    }
    for (const member of parcel.members) {
      const represented = local.find(p => p.id === member.node.id)
      const address = represented ?? local[Math.floor(hash(member.node.id) * local.length)] ?? parcel.center
      plan.positions.set(member.node.id, { x: address.x, z: address.z })
    }
  }
  for (const { edge, parcel, weight } of localRelations) {
    const addresses = edge.participants.map(p => plan.positions.get(p.node))
    if (!addresses[0] || !addresses[1]) continue
    const frontage = addresses.map(point => (parcelRoads.get(parcel) ?? []).map(id => roads.get(id)!)
      .sort((a, b) => segmentDistance(point!, a.points[0], a.points[1]) - segmentDistance(point!, b.points[0], b.points[1]) || a.id.localeCompare(b.id))[0])
    if (!frontage[0] || !frontage[1]) continue
    frontage[0].traffic += weight
    if (frontage[0] === frontage[1]) continue
    frontage[1].traffic += weight
    const entrance = (index: number) => vertexKey([...frontage[index].points].sort((a, b) => distance(a, addresses[index]!) - distance(b, addresses[index]!))[0])
    route(entrance(0), entrance(1), weight)
  }
  for (const road of plan.roads) {
    road.width = road.traffic ? Math.min(MAX_ROAD_WIDTH, .6 + .18 * Math.log1p(road.traffic)) : .42
    road.tier = road.traffic >= 30 ? 3 : road.traffic >= 5 ? 2 : road.traffic > 0 ? 1 : 0
  }
  plan.placements.sort((a, b) => a.id.localeCompare(b.id))
  plan.positions = new Map([...plan.positions].sort(([a], [b]) => a.localeCompare(b)))
  return plan
}
