import { describe, expect, it } from 'vitest'
import { Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three'
import { buildTerrain, type CityTerrain } from './city-terrain'
import { planCity, type CityPlan } from './city-plan'
import type { ProjectedLot } from './city-projection'

function fixture(count = 15): CityPlan {
  const placements = Array.from({ length: count }, (_, i) => ({ id: String(i), parcelId: 'p', x: (i % 32) * 3.8, z: Math.floor(i / 32) * 3.8, footprint: 1.45, rotation: 0, kind: 'house' as const }))
  const right = Math.max(...placements.map(p => p.x)) + 3, front = Math.max(...placements.map(p => p.z)) + 3
  return { placements, positions: new Map(), parcels: [{ id: 'p', kind: 'neighborhood', members: [], center: { x: right / 2, z: front / 2 }, polygon: [{ x: -3, z: -3 }, { x: right, z: -3 }, { x: right, z: front }, { x: -3, z: front }] }],
    roads: [{ id: 'r', width: 1.8, tier: 1, traffic: 0, points: [{ x: -3, z: -3 }, { x: right + 4, z: -7 }, { x: right, z: front }] }] }
}
function dispose(terrain: CityTerrain) { terrain.surface.dispose(); terrain.water.dispose(); terrain.shore.dispose() }

describe('continuous valley terrain', () => {
  it('keeps actual triangles flat under complete parcels, roads, shoulders and building footprints', () => {
    const plan = fixture(), terrain = buildTerrain(plan), material = new MeshBasicMaterial(), ground = new Mesh(terrain.surface, material)
    const ray = new Raycaster(), points = plan.parcels.flatMap(p => p.polygon)
    for (const p of plan.placements) for (let i = 0; i < 8; i++) points.push({ x: p.x + Math.cos(i * Math.PI / 4) * p.footprint, z: p.z + Math.sin(i * Math.PI / 4) * p.footprint })
    for (const road of plan.roads) for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1], b = road.points[i], length = Math.hypot(b.x - a.x, b.z - a.z)
      for (let j = 0; j <= 8; j++) for (const side of [-1, 1]) points.push({ x: a.x + (b.x - a.x) * j / 8 + (b.z - a.z) / length * (road.width / 2 + .2) * side,
        z: a.z + (b.z - a.z) * j / 8 - (b.x - a.x) / length * (road.width / 2 + .2) * side })
    }
    for (const p of points) {
      ray.set(new Vector3(p.x, 100, p.z), new Vector3(0, -1, 0))
      const hits = ray.intersectObject(ground)
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0].point.y).toBeCloseTo(.12, 5)
    }
    for (const p of [...terrain.trees, ...terrain.rocks]) {
      ray.set(new Vector3(p.x, 100, p.z), new Vector3(0, -1, 0))
      expect(ray.intersectObject(ground)[0].point.y).toBeCloseTo(p.y, 4)
    }
    material.dispose(); dispose(terrain)
  })

  it('has a bounded lake and river cut into the actual ground, a broad ridge and no vertical island skirt', () => {
    const terrain = buildTerrain(fixture()), material = new MeshBasicMaterial(), ground = new Mesh(terrain.surface, material), ray = new Raycaster()
    expect(terrain.stats.maxHeight).toBeGreaterThan(5)
    expect(terrain.stats.waterTriangles).toBeGreaterThan(50)
    expect(terrain.stats.shoreTriangles).toBeGreaterThan(30)
    const normals = terrain.surface.getAttribute('normal'), water = terrain.water.getAttribute('position')
    const parents = new Map<string, string>()
    const find = (key: string): string => { const parent = parents.get(key)!; if (parent === key) return key; const root = find(parent); parents.set(key, root); return root }
    for (let i = 0; i < water.count; i += 3) {
      const keys = [i, i + 1, i + 2].map(j => `${water.getX(j).toFixed(3)},${water.getZ(j).toFixed(3)}`)
      for (const key of keys) if (!parents.has(key)) parents.set(key, key)
      for (const key of keys.slice(1)) parents.set(find(key), find(keys[0]))
    }
    expect(new Set([...parents.keys()].map(find)).size, 'lake and river remain one connected rendered water body').toBe(1)
    for (let i = 0; i < normals.count; i += 3) expect(normals.getY(i)).toBeGreaterThan(0)
    // Check a distributed sample of rendered water triangles against rendered terrain,
    // not only the analytic height function (which would miss interpolation errors).
    const stride = Math.max(3, Math.floor(water.count / 60 / 3) * 3)
    for (let i = 0; i < water.count; i += stride) {
      const x = (water.getX(i) + water.getX(i + 1) + water.getX(i + 2)) / 3, z = (water.getZ(i) + water.getZ(i + 1) + water.getZ(i + 2)) / 3
      ray.set(new Vector3(x, 100, z), new Vector3(0, -1, 0))
      expect(ray.intersectObject(ground)[0].point.y).toBeLessThanOrEqual(terrain.waterLevel + .00002)
    }
    expect(terrain.surface.boundingBox!.min.x).toBeLessThan(terrain.bounds.min.x)
    expect(terrain.surface.boundingBox!.max.z).toBeGreaterThan(terrain.bounds.max.z)
    material.dispose(); dispose(terrain)
  })

  it('uses continuous height-gradient normals and has concave upland gullies', () => {
    const terrain = buildTerrain(fixture()), positions = terrain.surface.getAttribute('position'), normals = terrain.surface.getAttribute('normal')
    const shared = new Map<string, number[]>(); let repeats = 0, steep = 0
    for (let i = 0; i < positions.count; i++) {
      if (positions.getY(i) < terrain.stats.maxHeight * .2) continue
      const key = `${positions.getX(i)},${positions.getZ(i)}`, normal = [normals.getX(i), normals.getY(i), normals.getZ(i)]
      const previous = shared.get(key)
      if (previous) { expect(normal).toEqual(previous); repeats++ } else shared.set(key, normal)
      if (normal[1] < .75) steep++
    }
    expect(repeats).toBeGreaterThan(200)
    expect(steep).toBeGreaterThan(40)
    const span = terrain.bounds.max.x - terrain.bounds.min.x, delta = span * .015
    let gullies = 0
    for (let row = 0; row < 45; row++) for (let col = 0; col < 45; col++) {
      const x = terrain.bounds.min.x + span * col / 44, z = terrain.bounds.min.z + (terrain.bounds.max.z - terrain.bounds.min.z) * row / 44
      const h = terrain.sample(x, z).height
      if (h < terrain.stats.maxHeight * .22) continue
      const across = terrain.sample(x - delta, z).height + terrain.sample(x + delta, z).height - h * 2
      const along = terrain.sample(x, z - delta).height + terrain.sample(x, z + delta).height - h * 2
      if (Math.max(across, along) > terrain.stats.maxHeight * .022) gullies++
    }
    expect(gullies, 'upland profile includes concave cuts between subsidiary ridges').toBeGreaterThan(4)
    dispose(terrain)
  })

  it('connects through-city water below bridges and keeps both banks dry at 1/3/15/197/1003 addresses', () => {
    for (const count of [1, 3, 15, 197, 1003]) {
      const lots = Array.from({ length: count }, (_, i) => ({ node: { id: String(i), nodeType: 'concept', evidence: [String(i)] }, x: (i % Math.ceil(Math.sqrt(count))) * 9, z: Math.floor(i / Math.ceil(Math.sqrt(count))) * 9, zone: 'concept' })) as ProjectedLot[]
      const plan = planCity(lots, []), terrain = buildTerrain(plan)
      expect(terrain.stats.surfaceTriangles, `count ${count} bounded conforming mesh`).toBeLessThan(220000)
      for (const road of plan.roads.filter(r => !r.bridge)) for (let i = 1; i < road.points.length; i++) {
        const a = road.points[i - 1], b = road.points[i], length = Math.hypot(b.x - a.x, b.z - a.z)
        for (const t of [0, .5, 1]) for (const side of [-1, 1]) {
          const x = a.x + (b.x - a.x) * t + (b.z - a.z) / length * (road.width / 2 + .2) * side
          const z = a.z + (b.z - a.z) * t - (b.x - a.x) / length * (road.width / 2 + .2) * side
          expect(terrain.sample(x, z).height, `count ${count} road shoulder ${JSON.stringify({x,z,road,t,side})}`).toBeCloseTo(.12, 5)
        }
      }
      if (plan.river) {
        const p = plan.river.points[Math.floor(plan.river.points.length / 2)], material = new MeshBasicMaterial()
        const ground = new Mesh(terrain.surface, material), ray = new Raycaster(new Vector3(p.x, 100, p.z), new Vector3(0, -1, 0))
        expect(ray.intersectObject(ground)[0].point.y).toBeCloseTo(terrain.sample(p.x, p.z).height, 4)
        expect(ray.intersectObject(ground)[0].point.y).toBeLessThan(terrain.waterLevel)
        material.dispose()
      }
      for (const parcel of plan.parcels) for (const p of parcel.polygon) expect(terrain.sample(p.x, p.z).height, `count ${count} parcel edge ${JSON.stringify(p)}`).toBeCloseTo(.12, 5)
      for (const p of plan.placements) for (let i = 0; i < 8; i++) expect(terrain.sample(p.x + Math.cos(i * Math.PI / 4) * p.footprint, p.z + Math.sin(i * Math.PI / 4) * p.footprint).height, `count ${count} footprint`).toBeCloseTo(.12, 5)
      if (plan.river) for (let i = 1; i < plan.river.points.length; i++) {
        const a = plan.river.points[i - 1], b = plan.river.points[i]
        for (let j = 0; j <= 20; j++) for (const side of [-.35, 0, .35]) {
          const p = { x: a.x + (b.x - a.x) * j / 20, z: a.z + (b.z - a.z) * j / 20 }
          p[plan.river.axis] += side * plan.river.halfWidth
          expect(terrain.sample(p.x, p.z).height, `count ${count} river ${i}/${j}/${side}`).toBeLessThan(terrain.waterLevel - .01)
        }
      }
      const water = terrain.water.getAttribute('position'), parents = new Map<string, string>()
      const find = (key: string): string => { const p = parents.get(key)!; if (p === key) return key; const r = find(p); parents.set(key, r); return r }
      for (let i = 0; i < water.count; i += 3) {
        const keys = [i, i + 1, i + 2].map(j => `${water.getX(j).toFixed(3)},${water.getZ(j).toFixed(3)}`)
        for (const key of keys) if (!parents.has(key)) parents.set(key, key)
        for (const key of keys.slice(1)) parents.set(find(key), find(keys[0]))
      }
      expect(new Set([...parents.keys()].map(find)).size, `count ${count} actual water components`).toBe(1)
      dispose(terrain)
    }
    const vertical = planCity([{ node: { id: 'a', nodeType: 'concept' }, x: 0, z: -24, zone: 'concept' }, { node: { id: 'b', nodeType: 'concept' }, x: 0, z: 24, zone: 'concept' }] as ProjectedLot[], [])
    expect(vertical.river!.axis).toBe('z')
    const terrain = buildTerrain(vertical)
    for (const p of vertical.river!.points) expect(terrain.sample(p.x, p.z).water, JSON.stringify({p,sample:terrain.sample(p.x,p.z)})).toBe(true)
    dispose(terrain)
  }, 30000)

  it('is deterministic under reordered input and keeps empty and 1007-address geometry bounded', () => {
    const plan = fixture(), a = buildTerrain(plan), b = buildTerrain({ ...plan, placements: [...plan.placements].reverse(), roads: [...plan.roads].reverse(), parcels: [...plan.parcels].reverse() })
    expect(b.surface.getAttribute('position').array).toEqual(a.surface.getAttribute('position').array)
    expect(b.water.getAttribute('position').array).toEqual(a.water.getAttribute('position').array)
    expect(b.trees).toEqual(a.trees); expect(b.rocks).toEqual(a.rocks)
    dispose(a); dispose(b)
    for (const input of [{ parcels: [], roads: [], placements: [], positions: new Map() }, fixture(1007)] as CityPlan[]) {
      const terrain = buildTerrain(input)
      expect(terrain.stats.surfaceTriangles).toBeLessThan(180000)
      expect(terrain.trees.length).toBeLessThanOrEqual(180)
      expect(terrain.rocks.length).toBeLessThanOrEqual(60)
      expect(terrain.bounds.isEmpty()).toBe(false)
      for (const p of input.placements) { expect(terrain.sample(p.x, p.z).height).toBeCloseTo(.12, 8); expect(terrain.sample(p.x, p.z).water).toBe(false) }
      for (const name of ['surface', 'water', 'shore'] as const) expect([...terrain[name].getAttribute('position').array].every(Number.isFinite)).toBe(true)
      dispose(terrain)
    }
  }, 15000)
})
