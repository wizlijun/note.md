import { contours as d3Contours } from 'd3-contour'
import { seeded, stableHash, WORLD_SIZE } from './atlas'
import type { Atlas, AtlasNode, PeakAnchor, TerrainBounds, TerrainContour, TerrainGrid, TerrainRenderOptions, TerrainResult, TerrainSelection } from './types-terrain'

export const TERRAIN_VERSION = 'strata-terrain/2'
export const KERNEL_INTEGRAL = 2 * Math.PI * (48 / WORLD_SIZE) ** 2
// Keep the prototype's first 140 levels; extend the same fixed scale for dense production atlases.
export const CONTOUR_LEVELS = Array.from({ length: 384 }, (_, i) => .012 * Math.expm1((i + 1) * .011 / .24))
export const elevation = (height: number): number => .24 * Math.log1p(Math.max(0, height) / .012)
const TEMPLATE_SIZE = 64, REGION_GRID = 256, LOCAL_SHARE = .4, TOPIC_FOOT_SHARE = .75
const CACHE_LIMIT = 24 * 1024 * 1024, MAX_VERTICES = 220_000
const MAX_CACHED_PATCHES = 40_000

function noise(x: number, y: number, salt: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), u = x - ix, v = y - iy
  const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
  const lattice = (a: number, b: number) => {
    let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ salt
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1
  }
  const a = lattice(ix, iy), b = lattice(ix + 1, iy), c = lattice(ix, iy + 1), d = lattice(ix + 1, iy + 1)
  return (a + (b - a) * smooth(u)) * (1 - smooth(v)) + (c + (d - c) * smooth(u)) * smooth(v)
}

function fractal(x: number, y: number, salt: number, octaves = 5, ridged = false): number {
  let sum = 0, amplitude = 1, total = 0, feedback = 1
  for (let octave = 0; octave < octaves; octave++) {
    let signal = noise(x, y, salt + octave * 7919)
    if (ridged) { signal = (1 - Math.abs(signal)) ** 2 * feedback; feedback = Math.min(1, signal * 2.2) }
    sum += signal * amplitude; total += amplitude; amplitude *= ridged ? .55 : .52
    const nextX = (x * .8 - y * .6) * 2.03 + 17.7
    y = (x * .6 + y * .8) * 2.03 + 9.2; x = nextX
  }
  return sum / total
}

interface Template {
  prefix: Float64Array
  rows: Float64Array
  columns: Float64Array
  values: Float64Array
  size: number
}
const templates = new Map<string, Template>()

/** Analytic integration tables for a continuous bilinear density, including partial cells. */
function integrateTemplate(values: Float64Array, size: number): Template {
  const stride = size + 1, prefix = new Float64Array(stride * stride)
  const rows = new Float64Array(prefix.length), columns = new Float64Array(prefix.length)
  for (let y = 0; y <= size; y++) for (let x = 0; x < size; x++) {
    const at = y * stride + x
    rows[at + 1] = rows[at] + (values[at] + values[at + 1]) / 2
  }
  for (let y = 0; y < size; y++) for (let x = 0; x <= size; x++) {
    const at = y * stride + x
    columns[at + stride] = columns[at] + (values[at] + values[at + stride]) / 2
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const at = (y + 1) * stride + x + 1, before = y * stride + x
    prefix[at] = (values[before] + values[before + 1] + values[before + stride] + values[before + stride + 1]) / 4 +
      prefix[at - 1] + prefix[at - stride] - prefix[at - stride - 1]
  }
  return { values, prefix, rows, columns, size }
}

/** A bounded bank of positive natural kernels, integrated once, not a world grid per node. */
function template(variant: number, foot: boolean): Template {
  const key = (foot ? 'foot:' : 'local:') + variant
  const cached = templates.get(key); if (cached) return cached
  const n = TEMPLATE_SIZE, stride = n + 1, values = new Float64Array(stride * stride)
  const seed = stableHash(key), angle = seeded(key, 11) * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle)
  const aspect = .8 + seeded(key, 13) * .45
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
    const nx = x / n * 2 - 1, ny = y / n * 2 - 1
    const wx = nx + .065 * fractal(nx * 1.8, ny * 1.8, seed)
    const wy = ny + .065 * fractal(nx * 1.8, ny * 1.8, seed + 137)
    const u = wx * c + wy * s, v = -wx * s + wy * c
    const texture = .7 + .5 * fractal(nx * 4, ny * 4, seed + 557, 4, true) + .27 * fractal(nx * 2, ny * 2, seed + 1237)
    const taper = Math.max(0, 1 - nx * nx) ** 2 * Math.max(0, 1 - ny * ny) ** 2
    let value: number
    if (foot) {
      value = Math.exp(-.5 * ((u / .62) ** 2 + (v / .43) ** 2)) *
        (.65 + 1.2 * fractal(nx * 2, ny * 2, seed + 8819, 4, true) + .3 * fractal(nx, ny, seed + 9151, 4))
    } else {
      const bend = v - .07 * Math.sin(u * 5 + seeded(key, 43) * 6)
      const crest = .57 * Math.exp(-.5 * ((u / .31) ** 2 + (bend / .12) ** 2)) / (.31 * .12)
      const shoulder = .28 * Math.exp(-.5 * (((u + .19) / .47) ** 2 + ((v - .13) / .23) ** 2)) / (.47 * .23)
      const slope = .15 * Math.exp(-.5 * ((u / .62) ** 2 + (v / .39) ** 2)) / (.62 * .39)
      // The summit is centered exactly at the node; domain warp affects its surrounding slopes.
      const detail = 1 + .55 * fractal(nx * 8, ny * 8, seed + 5741, 3)
      const su = nx * c + ny * s, sv = -nx * s + ny * c
      const core = Math.exp(-.5 * ((su / (.09 * aspect)) ** 2 + (sv / (.09 / aspect)) ** 2) * detail) / .09 ** 2
      value = (.7 * (crest + shoulder + slope) + .3 * core) * texture
    }
    values[y * stride + x] = value * taper
  }
  const result = integrateTemplate(values, n); templates.set(key, result); return result
}

/** Exact biquadratic cumulative integral of the fixed continuous density. */
function cumulative(t: Template, x: number, y: number): number {
  const n = t.size, stride = n + 1
  x = Math.max(0, Math.min(n, x)); y = Math.max(0, Math.min(n, y))
  const ix = Math.min(n - 1, Math.floor(x)), iy = Math.min(n - 1, Math.floor(y)), fx = x - ix, fy = y - iy
  const at = iy * stride + ix, a = t.values[at], b = t.values[at + 1], c = t.values[at + stride], d = t.values[at + stride + 1]
  const column = t.columns[at] * fx + (t.columns[at + 1] - t.columns[at]) * fx * fx / 2
  const row = t.rows[at] * fy + (t.rows[at + stride] - t.rows[at]) * fy * fy / 2
  const corner = a * fx * fy + (b - a) * fx * fx * fy / 2 + (c - a) * fx * fy * fy / 2 + (d - b - c + a) * fx * fx * fy * fy / 4
  return t.prefix[at] + column + row + corner
}

function integral(t: Template, x0: number, y0: number, x1: number, y1: number): number {
  return Math.max(0, cumulative(t, x1, y1) - cumulative(t, x0, y1) - cumulative(t, x1, y0) + cumulative(t, x0, y0))
}

interface Kernel { key: string; x: number; y: number; radius: number; template: Template; normalization: number }
interface Patch { x: number; y: number; width: number; height: number; values: Float32Array }

function kernel(key: string, x: number, y: number, radius: number, variant: number, foot: boolean): Kernel {
  const t = template(variant, foot), scale = TEMPLATE_SIZE / (2 * radius)
  const normalization = integral(t, (-x + radius) * scale, (-y + radius) * scale, (1 - x + radius) * scale, (1 - y + radius) * scale)
  return { key, x, y, radius, template: t, normalization }
}

function makePatch(k: Kernel, grid: TerrainGrid): Patch {
  const { bounds: b, width: w, height: h } = grid, pixelW = b.width / w, pixelH = b.height / h
  const x0 = Math.max(0, Math.floor((k.x - k.radius - b.x) / pixelW)), x1 = Math.min(w, Math.ceil((k.x + k.radius - b.x) / pixelW))
  const y0 = Math.max(0, Math.floor((k.y - k.radius - b.y) / pixelH)), y1 = Math.min(h, Math.ceil((k.y + k.radius - b.y) / pixelH))
  const width = Math.max(0, x1 - x0), height = Math.max(0, y1 - y0), values = new Float32Array(width * height)
  const scale = TEMPLATE_SIZE / (2 * k.radius), factor = KERNEL_INTEGRAL / (k.normalization * pixelW * pixelH)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const ax = (b.x + x * pixelW - k.x + k.radius) * scale, ay = (b.y + y * pixelH - k.y + k.radius) * scale
    values[(y - y0) * width + x - x0] = integral(k.template, ax, ay, ax + pixelW * scale, ay + pixelH * scale) * factor
  }
  return { x: x0, y: y0, width, height, values }
}

export function calculateMasses(atlas: Atlas, selection: TerrainSelection): Float32Array {
  const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date
  if (!validDate(selection.from) || !validDate(selection.to) || selection.from > selection.to) throw new Error('请选择有效的日期范围')
  const groups = new Map<string, { priority: number; members: Set<string> }>()
  for (const node of atlas.nodes) for (const support of node.sourceGroups) {
    const key = JSON.stringify([support.groupId, support.groupVersion]), g = groups.get(key) || { priority: 0, members: new Set<string>() }
    g.priority = Math.max(g.priority, Number.isFinite(support.priority) ? Math.max(0, support.priority) : 0)
    for (const id of support.canonicalIds?.length ? support.canonicalIds : [node.id]) g.members.add(id)
    groups.set(key, g)
  }
  const scope = selection.nodeIds ? new Set(selection.nodeIds) : null
  return Float32Array.from(atlas.nodes, node => {
    if (scope && !scope.has(node.id)) return 0
    if (selection.includePublic === false && node.confidentiality === 'explicitly_public') return 0
    const visible = new Set<string>()
    for (const support of node.sourceGroups) if (support.dates.some(date => date >= selection.from && date <= selection.to)) visible.add(JSON.stringify([support.groupId, support.groupVersion]))
    let mass = 0
    for (const key of visible) { const g = groups.get(key)!; if (g.members.has(node.id)) mass += 2 * -Math.expm1(-g.priority / 2) / g.members.size }
    return mass
  })
}

function matchesSelection(node: AtlasNode, selection: TerrainSelection, scope: Set<string> | null): boolean {
  return (!scope || scope.has(node.id)) && !(selection.includePublic === false && node.confidentiality === 'explicitly_public') &&
    node.sourceGroups.some(support => support.dates.some(date => date >= selection.from && date <= selection.to))
}

export class TerrainEngine {
  readonly atlas: Atlas
  private readonly local: Kernel[]
  private readonly regions: Kernel[]
  private readonly regionGrid: TerrainGrid = { width: REGION_GRID, height: REGION_GRID, bounds: { x: 0, y: 0, width: 1, height: 1 } }
  private readonly topicIndex: Uint32Array
  private readonly domainIndex: Uint32Array
  private readonly cache = new Map<string, Patch>()
  private cacheBytes = 0
  constructor(atlas: Atlas) {
    this.atlas = atlas
    this.local = atlas.nodes.map(node => kernel(node.id, node.x, node.y, Math.max(1 / 32768, Math.min(.28, node.radius * 12)), stableHash(atlas.epoch + node.id) % 32, false))
    // The selected source mass forms shared shoulders at its actual frozen topic/domain.
    // Kernel supports and integrals depend on the complete atlas, never the date mask.
    this.regions = [
      ...atlas.topics.map(cluster => kernel('topic:' + cluster.id, cluster.x, cluster.y, Math.max(.04, Math.min(.8, cluster.radius * 2.4)), stableHash(atlas.epoch + cluster.id) % 8, true)),
      ...atlas.domains.map(cluster => kernel('domain:' + cluster.id, cluster.x, cluster.y, Math.max(.085, Math.min(.9, cluster.radius * 2)), stableHash(atlas.epoch + cluster.id) % 8, true)),
    ]
    const topics = new Map(atlas.topics.map((cluster, i) => [cluster.id, i]))
    const domains = new Map(atlas.domains.map((cluster, i) => [cluster.id, atlas.topics.length + i]))
    this.topicIndex = Uint32Array.from(atlas.nodes, node => topics.get(node.parentTopic)!)
    this.domainIndex = Uint32Array.from(atlas.nodes, node => domains.get(node.parentDomain)!)
  }

  private patch(k: Kernel, grid: TerrainGrid, gridKey: string): Patch {
    const key = gridKey + ':' + k.key, found = this.cache.get(key)
    if (found) return found
    const patch = makePatch(k, grid), bytes = patch.values.byteLength
    if (bytes > 0 && bytes <= CACHE_LIMIT) {
      while ((this.cacheBytes + bytes > CACHE_LIMIT || this.cache.size >= MAX_CACHED_PATCHES) && this.cache.size) {
        const oldest = this.cache.keys().next().value!
        this.cacheBytes -= this.cache.get(oldest)!.values.byteLength; this.cache.delete(oldest)
      }
      this.cache.set(key, patch); this.cacheBytes += bytes
    }
    return patch
  }

  render(selection: TerrainSelection, options: TerrainRenderOptions = {}): TerrainResult {
    const start = performance.now(), b = options.bounds || { x: 0, y: 0, width: 1, height: 1 }
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0 || b.x < 0 || b.y < 0 || b.x + b.width > 1.000001 || b.y + b.height > 1.000001) throw new Error('地形视口超出固定世界范围')
    const grid: TerrainGrid = { width: Math.max(32, Math.min(1024, Math.floor(options.width || 512))), height: Math.max(32, Math.min(1024, Math.floor(options.height || 512))), bounds: b }
    const gridKey = JSON.stringify(grid), masses = calculateMasses(this.atlas, selection), field = new Float32Array(grid.width * grid.height)
    const regionMasses = new Float64Array(this.regions.length), visibleIds: string[] = []
    const scope = selection.nodeIds ? new Set(selection.nodeIds) : null
    let totalMass = 0
    const splat = (patch: Patch, mass: number) => {
      for (let y = 0; y < patch.height; y++) {
        let target = (patch.y + y) * grid.width + patch.x, source = y * patch.width
        for (let x = 0; x < patch.width; x++) field[target++] += patch.values[source++] * mass
      }
    }
    for (let i = 0; i < masses.length; i++) {
      if (matchesSelection(this.atlas.nodes[i], selection, scope)) visibleIds.push(this.atlas.nodes[i].id)
      if (!masses[i]) continue
      totalMass += masses[i]
      // A fixed world-area budget prevents 1/r² needles in dense clusters. The remaining
      // source mass stays in its own hierarchy; dates and zoom never change this split.
      const local = this.local[i], localShare = LOCAL_SHARE * Math.min(1, (local.radius / .035) ** 2)
      if (local.x + local.radius > b.x && local.x - local.radius < b.x + b.width && local.y + local.radius > b.y && local.y - local.radius < b.y + b.height) {
        splat(this.patch(local, grid, gridKey), masses[i] * localShare)
      }
      regionMasses[this.topicIndex[i]] += masses[i] * (1 - localShare) * TOPIC_FOOT_SHARE
      regionMasses[this.domainIndex[i]] += masses[i] * (1 - localShare) * (1 - TOPIC_FOOT_SHARE)
    }
    // Regional kernels use a fixed world grid, then a continuous mass-preserving surface.
    // This bounds thousands of overlapping wide slopes without a world grid per source.
    const broad = new Float64Array(REGION_GRID * REGION_GRID)
    regionMasses.forEach((mass, i) => {
      if (!mass) return
      const patch = this.patch(this.regions[i], this.regionGrid, 'regions')
      for (let y = 0; y < patch.height; y++) for (let x = 0; x < patch.width; x++) {
        broad[(patch.y + y) * REGION_GRID + patch.x + x] += patch.values[y * patch.width + x] * mass
      }
    })
    const stride = REGION_GRID + 1, broadVertices = new Float64Array(stride * stride)
    // Clamped averages preserve total mass under trapezoidal integration in both axes.
    for (let y = 0; y <= REGION_GRID; y++) for (let x = 0; x <= REGION_GRID; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(REGION_GRID - 1, x), y0 = Math.max(0, y - 1), y1 = Math.min(REGION_GRID - 1, y)
      broadVertices[y * stride + x] = (broad[y0 * REGION_GRID + x0] + broad[y0 * REGION_GRID + x1] + broad[y1 * REGION_GRID + x0] + broad[y1 * REGION_GRID + x1]) / 4
    }
    const broadTemplate = integrateTemplate(broadVertices, REGION_GRID), pw = b.width * REGION_GRID / grid.width, ph = b.height * REGION_GRID / grid.height
    if (totalMass) for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
      const ax = b.x * REGION_GRID + x * pw, ay = b.y * REGION_GRID + y * ph
      field[y * grid.width + x] += integral(broadTemplate, ax, ay, ax + pw, ay + ph) / (pw * ph)
    }
    const peakAnchors = findPeaks(field, grid, this.atlas.nodes, masses)
    let contourVertices = 0, contoursTruncated = false
    // Overview cannot resolve thousands of child peaks: choose a subset of the fixed levels.
    // Focused tiles retain the requested fine spacing. The field and height scale never change.
    const densityStride = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(peakAnchors.length / 2000))))
    const step = Math.max(1, Math.min(48, Math.floor(options.contourStep || 3) * densityStride))
    let minimum = Infinity, maximum = 0
    for (const value of field) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value) }
    const candidates = CONTOUR_LEVELS.filter((value, i) => i % step === 0 && value > minimum && value <= maximum)
    const contours: TerrainContour[] = []
    const generator = d3Contours().size([grid.width, grid.height])
    // One level at a time bounds transient geometry; never retain a huge full contour set.
    for (const level of candidates) {
      if (!visibleIds.length) break
      // d3-contour accepts indexed numeric arrays; DefinitelyTyped still declares number[].
      const contour = generator.contour(field as unknown as number[], level) as TerrainContour
      contour.coordinates = contour.coordinates.map(polygon => polygon.map(simplifyRing))
      const count = contour.coordinates.reduce((sum, polygon) => sum + polygon.reduce((n, ring) => n + ring.length, 0), 0)
      if (contourVertices + count > MAX_VERTICES) { contoursTruncated = true; break }
      contourVertices += count; contours.push(contour)
    }
    const fieldIntegral = field.reduce((sum, value) => sum + value, 0) * b.width * b.height / field.length
    return { field, grid, contours, levels: contours.map(contour => contour.value), peakAnchors, layout: this.atlas, visibleIds, masses,
      stats: { elapsedMs: performance.now() - start, selectedNodes: visibleIds.length, totalMass, fieldIntegral,
        kernelBytes: this.cacheBytes + [...templates.values()].reduce((sum, t) => sum + t.prefix.byteLength * 4, 0),
        contourVertices, contoursTruncated, unresolvedPeaks: peakAnchors.filter(peak => !peak.resolved).length } }
  }
}

/** Subpixel Douglas–Peucker simplification limits structured-clone/renderer memory. */
function simplifyRing(points: number[][]): number[][] {
  if (points.length < 12) return points
  const last = points.length - 1, keep = new Uint8Array(points.length), stack = [0, last]
  keep[0] = keep[last] = 1
  let comparisons = 0
  while (stack.length) {
    const to = stack.pop()!, from = stack.pop()!, a = points[from], b = points[to]
    const vx = b[0] - a[0], vy = b[1] - a[1], length2 = vx * vx + vy * vy
    let greatest = .2 ** 2, selected = -1
    for (let i = from + 1; i < to; i++) {
      // A pathological contour cannot turn simplification into unbounded quadratic work.
      if (++comparisons > points.length * 32) return points
      const p = points[i], t = length2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / length2)) : 0
      const distance = (p[0] - a[0] - t * vx) ** 2 + (p[1] - a[1] - t * vy) ** 2
      if (distance > greatest) { greatest = distance; selected = i }
    }
    if (selected >= 0) { keep[selected] = 1; stack.push(from, selected, selected, to) }
  }
  const result = points.filter((_, i) => keep[i])
  return result.length >= 4 ? result : points
}

function findPeaks(field: Float32Array, grid: TerrainGrid, nodes: AtlasNode[], masses: Float32Array): PeakAnchor[] {
  const { width: w, height: h, bounds: b } = grid, anchors: PeakAnchor[] = [], used = new Set<number>()
  nodes.forEach((node, i) => {
    if (!masses[i] || node.x < b.x || node.y < b.y || node.x >= b.x + b.width || node.y >= b.y + b.height) return
    const x = Math.min(w - 1, Math.max(0, Math.floor((node.x - b.x) / b.width * w))), y = Math.min(h - 1, Math.max(0, Math.floor((node.y - b.y) / b.height * h)))
    let at = y * w + x
    const radius = Math.max(1, Math.min(16, Math.ceil(node.radius * 2 / Math.max(b.width / w, b.height / h))))
    for (let step = 0; step < 32; step++) {
      let next = at
      const px = at % w, py = Math.floor(at / w)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy
        if (nx < 0 || nx >= w || ny < 0 || ny >= h || Math.abs(nx - x) > radius || Math.abs(ny - y) > radius) continue
        const ni = ny * w + nx; if (field[ni] > field[next]) next = ni
      }
      if (next === at) break; at = next
    }
    let strict = field[at] > 0
    const px = at % w, py = Math.floor(at / w)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const nx = px + dx, ny = py + dy
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && field[ny * w + nx] >= field[at]) strict = false
    }
    const resolved = strict && !used.has(at)
    if (resolved) used.add(at)
    anchors.push({ id: node.id, x: resolved ? b.x + (px + .5) / w * b.width : node.x,
      y: resolved ? b.y + (py + .5) / h * b.height : node.y, height: field[at], resolved })
  })
  return anchors
}

/** Canvas and THREE can use this identical raw-height sampler. */
export function sampleHeight(field: Float32Array, grid: TerrainGrid, x: number, y: number): number {
  const nx = Math.max(0, Math.min(grid.width - 1, (x - grid.bounds.x) / grid.bounds.width * grid.width - .5))
  const ny = Math.max(0, Math.min(grid.height - 1, (y - grid.bounds.y) / grid.bounds.height * grid.height - .5))
  const x0 = Math.floor(nx), y0 = Math.floor(ny), x1 = Math.min(grid.width - 1, x0 + 1), y1 = Math.min(grid.height - 1, y0 + 1)
  const fx = nx - x0, fy = ny - y0
  return (field[y0 * grid.width + x0] * (1 - fx) + field[y0 * grid.width + x1] * fx) * (1 - fy) +
    (field[y1 * grid.width + x0] * (1 - fx) + field[y1 * grid.width + x1] * fx) * fy
}
