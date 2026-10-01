import { isExplicit } from './domain'
import type { Edge } from './types'

export interface ProjectedLot {
  node: { id: string; nodeType: string; evidence?: string[] }
  x: number
  z: number
  zone?: string
  style?: string
}

export interface OverviewBlock<T extends ProjectedLot> { x: number; z: number; members: T[]; representatives: T[] }

function hash(text: string) {
  let n = 2166136261
  for (const c of text) n = Math.imul(n ^ c.charCodeAt(0), 16777619)
  return (n >>> 0) / 4294967296
}

const cell = (x: number, z: number) => `${Math.floor(x / 8)}:${Math.floor(z / 8)}`
const pair = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`

/** Smooth, stable visual projection: the square spiral remains untouched in the snapshot. */
export function visualPoint(x: number, z: number) {
  return { x: x + 3.1 * Math.sin(z / 17) + 1.4 * Math.sin((x + z) / 29), z: z + 2.8 * Math.sin(x / 19) + 1.1 * Math.sin((x - z) / 25) }
}

/** Visual offsets never change the saved knowledge coordinates or object IDs. */
export function districtCenter(block: { x: number; z: number }) {
  const key = cell(block.x, block.z)
  return { x: block.x + (hash(`${key}:x`) - .5), z: block.z + (hash(`${key}:z`) - .5) }
}

const slots = [[0, 0], [-1.25, -1.15], [1.2, -1.2], [-1.45, .2], [1.45, .15], [-1.1, 1.3], [.25, 1.4], [1.35, 1.25], [.05, -1.45]]

export function overviewBuildings<T extends ProjectedLot>(block: OverviewBlock<T>, largestBlock = block.members.length) {
  const density = Math.log1p(block.members.length) / Math.log1p(Math.max(1, largestBlock))
  const growing = block.members.filter(lot => lot.zone === 'unassigned').length > block.members.length / 2
  const center = districtCenter(block), count = Math.min(block.representatives.length, Math.max(1, Math.min(growing ? 5 : 9, Math.round(1 + 8 * density * density))))
  const turn = (hash(`${cell(block.x, block.z)}:turn`) - .5) * .58
  const cos = Math.cos(turn), sin = Math.sin(turn)
  return block.representatives.slice(0, count).map((lot, i) => {
    const [sx, sz] = slots[i], driftX = (hash(`${lot.node.id}:dx`) - .5) * .24, driftZ = (hash(`${lot.node.id}:dz`) - .5) * .24
    return { lot, x: center.x + sx * cos - sz * sin + driftX, z: center.z + sx * sin + sz * cos + driftZ }
  })
}

export interface StreetSegment { id: string; points: [number, number][]; width: number; traffic: number }

/** Sample the same projected quadratic used by the renderer, including its real footprint. */
export function streetSamples(street: Pick<StreetSegment, 'points'>, steps = 16) {
  const [a, control, b] = street.points.map(([x, z]) => visualPoint(x, z))
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps, s = 1 - t
    return { x: s * s * a.x + 2 * s * t * control.x + t * t * b.x, z: s * s * a.z + 2 * s * t * control.z + t * t * b.z }
  })
}

/** Stable scenic streets; source-backed binary links dominate candidate relations. */
export function streetPlan<T extends ProjectedLot>(blocks: OverviewBlock<T>[], edges: Edge[], lots: T[]): StreetSegment[] {
  const occupied = new Set([...blocks.map(b => cell(b.x, b.z)), ...lots.filter(l => l.style).map(l => cell(l.x, l.z))])
  const byId = new Map(lots.map(l => [l.node.id, cell(l.x, l.z)]))
  const links = new Map<string, number>(), relationPairs = new Map<string, number>()
  for (const edge of edges) {
    if (edge.participants.length !== 2 || edge.status === 'candidate') continue
    const weight = edge.verifiedFamilies > 0 && isExplicit(edge) ? 2
      : edge.status === 'observed' && ['explicit_reference', 'wikilink', 'links_to', 'cites'].includes(edge.edgeType) ? 1
      : edge.status === 'observed' && edge.edgeType === 'tagged_with' ? .35
      : edge.status === 'imported' ? .12 : 0
    if (!weight) continue
    const a = byId.get(edge.participants[0].node), b = byId.get(edge.participants[1].node)
    if (!a || !b || a === b) continue
    const [ax, az] = a.split(':').map(Number), [bx, bz] = b.split(':').map(Number)
    const key = pair(a, b)
    relationPairs.set(key, (relationPairs.get(key) ?? 0) + weight)
    if (Math.abs(ax - bx) + Math.abs(az - bz) === 1) links.set(key, (links.get(key) ?? 0) + weight)
  }
  type Candidate = { a: string; b: string; key: string; links: number; cost: number }
  const candidates = new Map<string, Candidate>()
  const add = (a: string, b: string, adjacent: string, other: string) => {
    const key = pair(a, b)
    if (candidates.has(key)) return
    const score = links.get(pair(adjacent, other)) ?? 0
    candidates.set(key, { a, b, key, links: score, cost: hash(`street:${key}`) + (occupied.has(other) ? 0 : .4) })
  }
  const junction = (key: string): [number, number] => {
    const [i, j] = key.split(':').map(Number)
    return [i * 8 + (hash(`junction:${key}:x`) - .5), j * 8 + (hash(`junction:${key}:z`) - .5)]
  }
  const geometry = (edge: Candidate): StreetSegment => {
    const a = junction(edge.a), b = junction(edge.b), dx = b[0] - a[0], dz = b[1] - a[1], distance = Math.hypot(dx, dz)
    const bend = (hash(`bend:${edge.key}`) - .5) * .8
    const mid: [number, number] = [(a[0] + b[0]) / 2 - dz / distance * bend, (a[1] + b[1]) / 2 + dx / distance * bend]
    return { id: edge.key, points: [a, mid, b], traffic: 0, width: .28 }
  }
  for (const key of occupied) {
    const [i, j] = key.split(':').map(Number)
    add(`${i}:${j}`, `${i + 1}:${j}`, `${i}:${j}`, `${i}:${j - 1}`)
    add(`${i}:${j + 1}`, `${i + 1}:${j + 1}`, `${i}:${j}`, `${i}:${j + 1}`)
    add(`${i}:${j}`, `${i}:${j + 1}`, `${i}:${j}`, `${i - 1}:${j}`)
    add(`${i + 1}:${j}`, `${i + 1}:${j + 1}`, `${i}:${j}`, `${i + 1}:${j}`)
  }
  const heroes = lots.filter(l => l.style).map(l => ({ ...visualPoint(l.x, l.z), rx: l.style === 'camp' ? 8 : 4.7, rz: l.style === 'camp' ? 6.5 : 4.1 }))
  for (const [key, edge] of candidates) {
    if (streetSamples(geometry(edge)).some(p => heroes.some(h => Math.abs(p.x - h.x) < h.rx + .75 && Math.abs(p.z - h.z) < h.rz + .75))) candidates.delete(key)
  }
  const parent = new Map<string, string>()
  const root = (key: string): string => { const p = parent.get(key); if (!p) { parent.set(key, key); return key } if (p === key) return key; const r = root(p); parent.set(key, r); return r }
  const chosen = new Map<string, Candidate>()
  const sorted = [...candidates.values()].sort((a, b) => a.cost - b.cost || a.key.localeCompare(b.key))
  for (const edge of sorted) {
    const ra = root(edge.a), rb = root(edge.b)
    if (ra !== rb || (edge.cost < .12 && occupied.size > 4)) chosen.set(edge.key, edge)
    if (ra !== rb) parent.set(ra, rb)
  }
  const graph = new Map<string, { to: string; id: string }[]>()
  for (const edge of chosen.values()) for (const [from, to] of [[edge.a, edge.b], [edge.b, edge.a]]) {
    if (!graph.has(from)) graph.set(from, [])
    graph.get(from)!.push({ to, id: edge.key })
  }
  for (const neighbors of graph.values()) neighbors.sort((a, b) => a.id.localeCompare(b.id))
  const corners = (key: string, toward: string) => {
    const [i, j] = key.split(':').map(Number), [ti, tj] = toward.split(':').map(Number)
    return [`${i}:${j}`, `${i + 1}:${j}`, `${i}:${j + 1}`, `${i + 1}:${j + 1}`]
      .sort((a, b) => {
        const [ax, az] = a.split(':').map(Number), [bx, bz] = b.split(':').map(Number)
        return Math.hypot(ax - ti - .5, az - tj - .5) - Math.hypot(bx - ti - .5, bz - tj - .5) || a.localeCompare(b)
      })
  }
  const flow = new Map<string, number>()
  for (const [key, weight] of [...relationPairs].sort(([a], [b]) => a.localeCompare(b))) {
    const [a, b] = key.split('|'), [ax, az] = a.split(':').map(Number), [bx, bz] = b.split(':').map(Number)
    if (Math.abs(ax - bx) + Math.abs(az - bz) === 1) {
      const shared = ax !== bx ? pair(`${Math.max(ax, bx)}:${az}`, `${Math.max(ax, bx)}:${az + 1}`) : pair(`${ax}:${Math.max(az, bz)}`, `${ax + 1}:${Math.max(az, bz)}`)
      if (chosen.has(shared)) continue // the shared street already carries this link
    }
    // Even one supported cross-district link should have a visible route.
    const start = corners(a, b).find(c => graph.has(c)), target = corners(b, a).find(c => graph.has(c) && c !== start)
    if (!start || !target) continue
    const queue = [start], previous = new Map<string, { from: string; road: string }>()
    const seen = new Set([start])
    for (let i = 0; i < queue.length && !seen.has(target); i++) for (const next of graph.get(queue[i]) ?? []) {
      if (seen.has(next.to)) continue
      seen.add(next.to); previous.set(next.to, { from: queue[i], road: next.id }); queue.push(next.to)
    }
    if (!seen.has(target)) continue
    for (let at = target; at !== start;) {
      const step = previous.get(at)!
      flow.set(step.road, (flow.get(step.road) ?? 0) + weight)
      at = step.from
    }
  }
  return [...chosen.values()].sort((a, b) => a.key.localeCompare(b.key)).map(edge => {
    const traffic = edge.links + (flow.get(edge.key) ?? 0)
    return { ...geometry(edge), traffic, width: traffic ? Math.min(1.45, .28 + .22 * Math.log1p(traffic)) : .28 }
  })
}

/** Overview blocks are visual containers; their members retain their original identities. */
export function overviewBlocks<T extends ProjectedLot>(lots: T[]): OverviewBlock<T>[] {
  const blocks = new Map<string, OverviewBlock<T>>()
  for (const lot of lots) {
    if (lot.style) continue
    const x = Math.floor(lot.x / 8) * 8 + 4, z = Math.floor(lot.z / 8) * 8 + 4
    const key = `${x}:${z}`
    let block = blocks.get(key)
    if (!block) { block = { x, z, members: [], representatives: [] }; blocks.set(key, block) }
    block.members.push(lot)
  }
  const rank = (lot: T) => lot.node.nodeType === 'project' ? 0 : ['concept', 'entity'].includes(lot.node.nodeType) ? 1 : 2
  for (const block of blocks.values()) {
    block.members.sort((a, b) => rank(a) - rank(b) || (b.node.evidence?.length ?? 0) - (a.node.evidence?.length ?? 0) || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0))
    block.representatives = block.members.slice(0, 9)
  }
  return [...blocks.values()].sort((a, b) => a.x - b.x || a.z - b.z)
}
