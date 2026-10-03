import { Box3, BufferGeometry, Color, Float32BufferAttribute, Vector3 } from 'three'
import type { CityPlan } from './city-plan'

export interface TerrainDecoration { x: number; y: number; z: number; radius: number }
export interface CityTerrain {
  surface: BufferGeometry; water: BufferGeometry; shore: BufferGeometry
  /** Significant landscape only: the continuous ground extends beyond this frame. */
  bounds: Box3
  framingPoints: Vector3[]
  trees: TerrainDecoration[]; rocks: TerrainDecoration[]
  waterLevel: number
  sample(x: number, z: number): { height: number; water: boolean }
  stats: { surfaceTriangles: number; waterTriangles: number; shoreTriangles: number; maxHeight: number; treeCount: number; rockCount: number }
}

const GROUND = .12, WATER = -.16, RESOLUTION = 288
const clamp = (v: number) => Math.max(0, Math.min(1, v))
const smooth = (v: number) => { const t = clamp(v); return t * t * (3 - 2 * t) }
const random = (i: number, salt: number) => {
  let v = Math.imul(i + 1, 374761393) ^ Math.imul(salt, 668265263)
  v = Math.imul(v ^ (v >>> 13), 1274126177)
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296
}
function noise(x: number, z: number) {
  const ix = Math.floor(x), iz = Math.floor(z), u = smooth(x - ix), v = smooth(z - iz)
  const lattice = (a: number, b: number) => random(Math.imul(a, 73856093) ^ Math.imul(b, 19349663), 97) * 2 - 1
  return (lattice(ix, iz) * (1 - u) + lattice(ix + 1, iz) * u) * (1 - v)
    + (lattice(ix, iz + 1) * (1 - u) + lattice(ix + 1, iz + 1) * u) * v
}
interface Vertex { x: number; y: number; z: number; wet?: number }
interface RidgePoint { x: number; z: number; height: number; width: number }
function polygonClip(points: Vertex[], value: (p: Vertex) => number): Vertex[] {
  const result: Vertex[] = []
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], da = value(a), db = value(b)
    if (da <= 0) result.push(a)
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db)
      result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, wet: a.wet === undefined || b.wet === undefined ? undefined : a.wet + (b.wet - a.wet) * t })
    }
  }
  return result
}
function geometry(positions: number[], colors: number[], normals?: number[]) {
  const result = new BufferGeometry()
  result.setAttribute('position', new Float32BufferAttribute(positions, 3))
  result.setAttribute('color', new Float32BufferAttribute(colors, 3))
  if (normals) result.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  else result.computeVertexNormals()
  result.computeBoundingBox()
  return result
}

/** Visual landscape only. Never moves addresses, invents roads or attaches knowledge IDs. */
export function buildTerrain(plan: CityPlan): CityTerrain {
  const core = new Box3()
  for (const parcel of plan.parcels) for (const p of parcel.polygon) core.expandByPoint(new Vector3(p.x, GROUND, p.z))
  for (const road of plan.roads) for (const p of road.points) {
    const radius = road.width / 2 + 1.3 // Includes existing roadside lamps and planters.
    core.expandByPoint(new Vector3(p.x - radius, GROUND, p.z - radius))
    core.expandByPoint(new Vector3(p.x + radius, GROUND, p.z + radius))
  }
  for (const p of plan.placements) {
    core.expandByPoint(new Vector3(p.x - p.footprint, GROUND, p.z - p.footprint))
    core.expandByPoint(new Vector3(p.x + p.footprint, GROUND, p.z + p.footprint))
  }
  if (core.isEmpty()) core.set(new Vector3(-10, GROUND, -10), new Vector3(10, GROUND, 10))
  const center = core.getCenter(new Vector3()), size = core.getSize(new Vector3())
  const scale = Math.max(24, size.x, size.z), hx = size.x / 2, hz = size.z / 2
  const outerX = hx + scale * .95, outerZ = hz + scale * .95
  const stepX = outerX * 2 / RESOLUTION, stepZ = outerZ * 2 / RESOLUTION
  // Every triangle touching the protected city is flat, including its outside vertices.
  const guard = Math.hypot(stepX, stepZ) * 1.1 + 1.5
  const peak = Math.min(35, Math.max(6, scale * .20))
  const bank = Math.max(1.2, scale * .019), riverWidth = Math.max(1.4, scale * .024)
  const lake = { x: hx + scale * .185, z: hz * .02, rx: scale * .125, rz: scale * .23 }
  // Unequal S-bends pass outside the right and front edges of the valley floor.
  const river: { x: number; z: number; radius: number }[] = []
  const curves = [
    [{ x: lake.x, z: lake.z }, { x: hx + scale * .30, z: hz * .8 }, { x: hx + scale * .10, z: hz + scale * .22 }, { x: hx * .30, z: hz + scale * .12 }],
    [{ x: hx * .30, z: hz + scale * .12 }, { x: hx * .06, z: hz + scale * .07 }, { x: -hx * .02, z: hz + scale * .31 }, { x: -hx * .25, z: hz + scale * .24 }],
    [{ x: -hx * .25, z: hz + scale * .24 }, { x: -hx * .65, z: hz + scale * .13 }, { x: -hx - scale * .18, z: hz + scale * .33 }, { x: -hx - scale * .23, z: hz + scale * .15 }],
    [{ x: -hx - scale * .23, z: hz + scale * .15 }, { x: -hx - scale * .43, z: hz - scale * .04 }, { x: -hx - scale * .67, z: hz + scale * .36 }, { x: -hx - scale * .85, z: hz + scale * .18 }],
  ]
  for (const [ci, c] of curves.entries()) for (let i = 0; i <= 24; i++) {
    const t = i / 24, u = 1 - t
    river.push({ x: u ** 3 * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t ** 3 * c[3].x,
      z: u ** 3 * c[0].z + 3 * u * u * t * c[1].z + 3 * u * t * t * c[2].z + t ** 3 * c[3].z,
      radius: Math.max(Math.hypot(stepX, stepZ) * .9, riverWidth * (.93 + .29 * Math.sin((ci + t) * 7) + .12 * Math.cos((ci + t) * 13))) })
  }
  function wetDistance(x: number, z: number) {
    const angle = Math.atan2((z - lake.z) / lake.rz, (x - lake.x) / lake.rx)
    let d = (Math.hypot((x - lake.x) / lake.rx, (z - lake.z) / lake.rz) - (1 + .055 * Math.sin(angle * 3 + .8) + .028 * Math.cos(angle * 7))) * Math.min(lake.rx, lake.rz)
    for (let i = 1; i < river.length; i++) {
      const a = river[i - 1], b = river[i], dx = b.x - a.x, dz = b.z - a.z
      const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1))
      d = Math.min(d, Math.hypot(x - a.x - t * dx, z - a.z - t * dz) - a.radius * (1 - t) - b.radius * t)
    }
    return d
  }
  const ridgePoint = (x: number, z: number, height: number, width: number): RidgePoint => ({ x, z, height, width: width * scale })
  const mainRidge = [
    ridgePoint(-hx - scale * .17, -hz - scale * .11, .15, .15),
    ridgePoint(-hx * .80, -hz - scale * .26, .74, .19),
    ridgePoint(-hx * .36, -hz - scale * .20, .49, .17),
    ridgePoint(hx * .02, -hz - scale * .34, 1.08, .19),
    ridgePoint(hx * .39, -hz - scale * .24, .56, .16),
    ridgePoint(hx * .80, -hz - scale * .18, .81, .18),
    ridgePoint(hx + scale * .17, -hz - scale * .29, .13, .14),
  ]
  // Branches taper down from different parts of the crest. Their gaps are real
  // concave valleys, not noise painted over radially symmetric hill envelopes.
  const ridges = [mainRidge,
    [mainRidge[1], ridgePoint(-hx * .95, -hz - scale * .10, .35, .12), ridgePoint(-hx - scale * .15, -hz * .35, .02, .16)],
    [mainRidge[1], ridgePoint(-hx * .52, -hz - scale * .42, .31, .13)],
    [mainRidge[3], ridgePoint(-hx * .08, -hz - scale * .15, .59, .11), ridgePoint(-hx * .30, -hz - scale * .045, .015, .13)],
    [mainRidge[3], ridgePoint(hx * .30, -hz - scale * .47, .48, .14)],
    [mainRidge[5], ridgePoint(hx * .62, -hz - scale * .075, .26, .11), ridgePoint(hx * .90, -hz * .68, .015, .13)],
    [ridgePoint(-hx - scale * .10, -hz * .40, .22, .18), ridgePoint(-hx - scale * .20, hz * .25, .12, .14), ridgePoint(-hx - scale * .09, hz * .65, .015, .13)],
  ]
  function protectedDistance(x: number, z: number) {
    return Math.hypot(Math.max(0, Math.abs(x) - hx - guard), Math.max(0, Math.abs(z) - hz - guard))
  }
  function field(x: number, z: number, waterDistance: number) {
    const outside = protectedDistance(x, z)
    if (outside === 0) return GROUND
    const transition = smooth(outside / (scale * .095))
    const qx = x + scale * .028 * noise(x / scale * 5 + 17, z / scale * 5)
    const qz = z + scale * .026 * noise(x / scale * 6 - 8, z / scale * 6 + 31)
    let crest = 0, foothill = 0
    for (const ridge of ridges) for (let i = 1; i < ridge.length; i++) {
      const a = ridge[i - 1], b = ridge[i], dx = b.x - a.x, dz = b.z - a.z
      const t = clamp(((qx - a.x) * dx + (qz - a.z) * dz) / (dx * dx + dz * dz))
      const d = Math.hypot(qx - a.x - t * dx, qz - a.z - t * dz)
      const height = a.height * (1 - t) + b.height * t
      const side = dx * (qz - a.z) - dz * (qx - a.x)
      const width = (a.width * (1 - t) + b.width * t) * (side > 0 ? .86 : 1.17)
      crest = Math.max(crest, height * Math.pow(clamp(1 - d / width), 1.65))
      foothill = Math.max(foothill, height * Math.pow(clamp(1 - d / (width * 1.85)), 2.4))
    }
    const detail = .56 * noise(x / scale * 27, z / scale * 27)
      + .29 * noise(x / scale * 59 + 9, z / scale * 59) + .15 * noise(x / scale * 113, z / scale * 113 - 7)
    const relief = Math.max(0, crest + foothill * .14 + detail * Math.min(.075, crest * .20))
    const land = GROUND + transition * (peak * relief + .20 + .11 * noise(x / scale * 9, z / scale * 9))
    const d = waterDistance, waterBlend = 1 - smooth((d + bank * .55) / (bank * 1.8))
    // A shallow bank descends into a real basin. Water is later clipped to this mesh.
    const bed = WATER - .25 - Math.min(scale * .025, 1.7) * smooth(-d / (riverWidth * 1.2))
    const basin = waterBlend * smooth(outside / (scale * .055))
    return land * (1 - basin) + bed * basin
  }
  const grass = new Color('#81966a'), meadow = new Color('#a2ab78'), forest = new Color('#536c50')
  const stone = new Color('#a4adb0'), rockShade = new Color('#53616b'), talus = new Color('#b5a17e'), sand = new Color('#c9be9c')
  const shallow = new Color('#88bab8'), deep = new Color('#3d879a')
  const surface: number[] = [], colors: number[] = [], surfaceNormals: number[] = [], water: number[] = [], waterColors: number[] = [], shore: number[] = [], shoreColors: number[] = []
  const shoreline = new Map<string, Vertex>(), colorCache = new WeakMap<Vertex, Color>()
  const color = new Color()
  function groundColor(p: Vertex) {
    const cached = colorCache.get(p)
    if (cached) return cached
    const x = p.x - center.x, z = p.z - center.z, d = p.wet ?? wetDistance(x, z), gradient = gradientAt(p.x, p.z)
    const slope = Math.hypot(gradient.x, gradient.z), elevation = clamp((p.y - GROUND) / peak)
    const texture = noise(x / scale * 64 + 3, z / scale * 64 - 5), strata = noise(x / scale * 34, z / scale * 16 + p.y / peak * 7)
    const grain = .65 * noise(x / scale * 139, z / scale * 151) + .35 * noise(x / scale * 223 + 7, z / scale * 197)
    const bedding = Math.sin((p.y / peak * 15 + x / scale * 3 + strata * .3) * Math.PI)
    color.copy(grass).lerp(meadow, clamp(.36 + noise(x / scale * 14, z / scale * 14) * .30))
    color.lerp(forest, smooth(elevation * 3) * (1 - smooth(slope / .8)) * .50)
    const exposed = smooth((slope - .35 + texture * .12) / .72) * smooth((p.y - .35) / 1.4)
    color.lerp(talus, smooth((slope - .18) / .5) * (1 - smooth((slope - .65) / .65)) * smooth(elevation * 5) * .60)
    const rock = stone.clone().lerp(rockShade, clamp(.29 + strata * .20 + texture * .20 + grain * .25 + bedding * .065 + smooth((slope - .6) / 1.2) * .19))
    color.lerp(rock, Math.max(exposed, smooth((elevation - .57) / .34) * .84))
    if (d < bank * 1.8 && p.y < .8) color.lerp(sand, 1 - smooth(Math.max(0, d - bank * .35) / (bank * 1.45)))
    const result = color.clone(); colorCache.set(p, result); return result
  }
  function emit(polygon: Vertex[], target: number[], targetColors: number[], kind: 'ground' | 'water' | 'shore') {
    for (let i = 1; i < polygon.length - 1; i++) for (const p of [polygon[0], polygon[i], polygon[i + 1]]) {
      if (kind === 'water' && Math.abs(p.y - WATER) < 1e-7) shoreline.set(`${p.x.toFixed(4)},${p.z.toFixed(4)}`, p)
      target.push(p.x, kind === 'water' ? WATER : p.y + (kind === 'shore' ? .006 : 0), p.z)
      if (kind === 'ground') {
        const gradient = gradientAt(p.x, p.z), length = Math.hypot(gradient.x, 1, gradient.z)
        surfaceNormals.push(-gradient.x / length, 1 / length, -gradient.z / length)
      }
      const c = kind === 'water' ? color.copy(shallow).lerp(deep, smooth((WATER - p.y) / 1.8)) : kind === 'shore' ? color.copy(sand) : groundColor(p)
      targetColors.push(c.r, c.g, c.b)
    }
  }
  const vertices: Vertex[] = []
  let maxHeight = GROUND
  for (let row = 0; row <= RESOLUTION; row++) for (let col = 0; col <= RESOLUTION; col++) {
    const x = -outerX + col * stepX, z = -outerZ + row * stepZ, wet = wetDistance(x, z), y = field(x, z, wet)
    maxHeight = Math.max(maxHeight, y)
    vertices.push({ x: x + center.x, y, z: z + center.z, wet })
  }
  // Two bounded D8 flow-accumulation incision passes. This is a local visual
  // erosion model, not a hydrology simulation; no protected or wet vertex moves.
  const offsets = [-RESOLUTION - 2, -RESOLUTION - 1, -RESOLUTION, -1, 1, RESOLUTION, RESOLUTION + 1, RESOLUTION + 2]
  const lengths = [Math.hypot(stepX, stepZ), stepZ, Math.hypot(stepX, stepZ), stepX, stepX, Math.hypot(stepX, stepZ), stepZ, Math.hypot(stepX, stepZ)]
  for (let pass = 0; pass < 2; pass++) {
    const flow = new Float64Array(vertices.length).fill(1), downstream = new Int32Array(vertices.length).fill(-1), grades = new Float32Array(vertices.length)
    for (let row = 1; row < RESOLUTION; row++) for (let col = 1; col < RESOLUTION; col++) {
      const at = row * (RESOLUTION + 1) + col, p = vertices[at]
      if (p.y < .8 || protectedDistance(p.x - center.x, p.z - center.z) < scale * .035) continue
      for (let j = 0; j < offsets.length; j++) {
        const grade = (p.y - vertices[at + offsets[j]].y) / lengths[j]
        if (grade > grades[at]) { grades[at] = grade; downstream[at] = at + offsets[j] }
      }
    }
    const order = vertices.map((_, i) => i).sort((a, b) => vertices[b].y - vertices[a].y || a - b)
    for (const at of order) if (downstream[at] >= 0) flow[downstream[at]] += flow[at]
    for (let i = 0; i < vertices.length; i++) if (downstream[i] >= 0) {
      const cut = Math.min(peak * .025, peak * .004 * Math.log1p(flow[i]) * Math.min(1.5, grades[i]))
      vertices[i].y = Math.max(GROUND + .5, vertices[i].y - cut)
    }
  }
  maxHeight = vertices.reduce((height, p) => Math.max(height, p.y), GROUND)
  const gradients = vertices.map((_, i) => {
    const row = Math.floor(i / (RESOLUTION + 1)), col = i % (RESOLUTION + 1)
    const left = col ? i - 1 : i, right = col < RESOLUTION ? i + 1 : i
    const back = row ? i - RESOLUTION - 1 : i, front = row < RESOLUTION ? i + RESOLUTION + 1 : i
    return { x: (vertices[right].y - vertices[left].y) / (stepX * (col && col < RESOLUTION ? 2 : 1)),
      z: (vertices[front].y - vertices[back].y) / (stepZ * (row && row < RESOLUTION ? 2 : 1)) }
  })
  function gradientAt(x: number, z: number) {
    const col = Math.round((x - center.x + outerX) / stepX), row = Math.round((z - center.z + outerZ) / stepZ)
    return col < 0 || col > RESOLUTION || row < 0 || row > RESOLUTION ? { x: 0, z: 0 } : gradients[row * (RESOLUTION + 1) + col]
  }
  const sample = (x: number, z: number) => {
    const gx = clamp((x - center.x + outerX) / (outerX * 2)) * RESOLUTION
    const gz = clamp((z - center.z + outerZ) / (outerZ * 2)) * RESOLUTION
    const col = Math.min(RESOLUTION - 1, Math.floor(gx)), row = Math.min(RESOLUTION - 1, Math.floor(gz)), u = gx - col, v = gz - row
    const a = row * (RESOLUTION + 1) + col, b = a + 1, c = a + RESOLUTION + 1, d = c + 1
    // Same diagonal as the rendered triangles: scenery rests on the visible surface.
    const height = u + v <= 1 ? vertices[a].y * (1 - u - v) + vertices[b].y * u + vertices[c].y * v
      : vertices[d].y * (u + v - 1) + vertices[b].y * (1 - v) + vertices[c].y * (1 - u)
    return { height, water: height < WATER }
  }
  for (let row = 0; row < RESOLUTION; row++) for (let col = 0; col < RESOLUTION; col++) {
    const a = row * (RESOLUTION + 1) + col, b = a + 1, c = a + RESOLUTION + 1, d = c + 1
    for (const triangle of [[vertices[a], vertices[c], vertices[b]], [vertices[b], vertices[c], vertices[d]]]) {
      emit(triangle, surface, colors, 'ground')
      if (triangle.some(p => p.y < WATER)) emit(polygonClip(triangle, p => p.y - WATER), water, waterColors, 'water')
      if (triangle.some(p => p.wet! < bank) && triangle.some(p => p.y < .34) && triangle.some(p => p.y >= WATER)) {
        const beach = polygonClip(polygonClip(triangle, p => WATER - p.y), p => p.y - .34)
        emit(polygonClip(beach, p => p.wet! - bank), shore, shoreColors, 'shore')
      }
    }
  }
  // A broad, shallow apron continues beyond the camera, with no vertical skirt.
  const apron = (a: Vertex, b: Vertex) => {
    const far = (p: Vertex): Vertex => ({ x: center.x + (p.x - center.x) * 8, y: GROUND, z: center.z + (p.z - center.z) * 8 })
    const c = far(a), d = far(b)
    for (const triangle of [[a, c, b], [b, c, d]]) {
      const [p, q, r] = triangle
      if ((q.z - p.z) * (r.x - p.x) - (q.x - p.x) * (r.z - p.z) < 0) triangle.reverse()
      emit(triangle, surface, colors, 'ground')
    }
  }
  for (let i = 0; i < RESOLUTION; i++) {
    apron(vertices[i], vertices[i + 1])
    apron(vertices[RESOLUTION * (RESOLUTION + 1) + i], vertices[RESOLUTION * (RESOLUTION + 1) + i + 1])
    apron(vertices[i * (RESOLUTION + 1)], vertices[(i + 1) * (RESOLUTION + 1)])
    apron(vertices[i * (RESOLUTION + 1) + RESOLUTION], vertices[(i + 1) * (RESOLUTION + 1) + RESOLUTION])
  }
  const trees: TerrainDecoration[] = [], rocks: TerrainDecoration[] = []
  for (let i = 0; i < 1100 && (trees.length < 180 || rocks.length < 60); i++) {
    const patches = [
      { x: -hx - scale * .11, z: hz * .1 }, { x: -hx * .6, z: -hz - scale * .09 },
      { x: hx * .55, z: -hz - scale * .10 }, { x: hx + scale * .26, z: hz * .48 },
      { x: hx * .45, z: hz + scale * .06 }, { x: -hx * .7, z: hz + scale * .12 },
    ]
    const patch = patches[i % patches.length], angle = random(i, 7) * Math.PI * 2, spread = Math.sqrt(random(i, 19)) * scale * .18
    const x = patch.x + Math.cos(angle) * spread, z = patch.z + Math.sin(angle) * spread
    const radius = Math.min(2.1, .48 + scale * .006) * .82 * (.65 + random(i, 31) * .65)
    if (Math.abs(x) < hx + guard + radius && Math.abs(z) < hz + guard + radius) continue
    const y = sample(x + center.x, z + center.z).height, delta = Math.max(.6, radius)
    const slope = Math.max(Math.abs(sample(x + center.x + delta, z + center.z).height - sample(x + center.x - delta, z + center.z).height), Math.abs(sample(x + center.x, z + center.z + delta).height - sample(x + center.x, z + center.z - delta).height)) / (2 * delta)
    if (y < WATER + .35 || wetDistance(x, z) < bank + radius || y > peak * .84) continue
    const point = { x: x + center.x, y, z: z + center.z, radius }
    const target = y > peak * .55 || slope > .65 || random(i, 41) > .86 ? rocks : trees
    if (target.length >= (target === rocks ? 60 : 180) || slope > 1.4) continue
    // Broken rock is already part of the mountain mesh. Loose stones belong on
    // the talus foot, not scattered as toy boulders across exposed high cliffs.
    if (target === rocks) {
      if (y > peak * .38 || slope > .9 || random(i, 53) > .45) continue
      point.radius *= .7
    }
    if ([...trees, ...rocks].some(p => Math.hypot(p.x - point.x, p.z - point.z) < (p.radius + radius) * 1.12)) continue
    target.push(point)
  }
  const bounds = new Box3(new Vector3(center.x - hx - scale * .24, WATER, center.z - hz - scale * .34),
    new Vector3(center.x + hx + scale * .30, maxHeight, center.z + hz + scale * .26))
  const framingPoints: Vector3[] = []
  for (const x of [core.min.x, core.max.x]) for (const z of [core.min.z, core.max.z]) framingPoints.push(new Vector3(x, GROUND, z))
  for (let row = 0; row <= RESOLUTION; row += 4) for (let col = 0; col <= RESOLUTION; col += 4) {
    const p = vertices[row * (RESOLUTION + 1) + col], point = new Vector3(p.x, p.y, p.z)
    if (p.y > .8 && bounds.containsPoint(point)) framingPoints.push(point)
  }
  // Frame real banks, not the downstream endpoint or empty rectangle corners.
  for (const p of shoreline.values()) {
    const point = new Vector3(p.x, WATER, p.z)
    if (bounds.containsPoint(point)) framingPoints.push(point)
  }
  const summit = vertices.reduce((best, p) => p.y > best.y ? p : best)
  framingPoints.push(new Vector3(summit.x, summit.y, summit.z))
  return { framingPoints, surface: geometry(surface, colors, surfaceNormals), water: geometry(water, waterColors), shore: geometry(shore, shoreColors), bounds, trees, rocks, sample, waterLevel: WATER,
    stats: { surfaceTriangles: surface.length / 9, waterTriangles: water.length / 9, shoreTriangles: shore.length / 9, maxHeight, treeCount: trees.length, rockCount: rocks.length } }
}
