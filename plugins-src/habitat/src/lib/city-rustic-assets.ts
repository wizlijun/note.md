import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// Original procedural architecture. One asset is one complete building; garden
// furniture belongs to the scene and does not introduce another knowledge node.
export const rusticHuts = ['rustic/hut-a', 'rustic/hut-b'] as const
export const rusticCabins = ['rustic/cabin-a', 'rustic/cabin-b', 'rustic/cabin-c', 'rustic/cabin-d', 'rustic/cabin-e', 'rustic/cabin-f'] as const
export type RusticAssetId = typeof rusticHuts[number] | typeof rusticCabins[number]
export interface RusticAsset {
  id: RusticAssetId
  size: THREE.Vector3
  /** Front threshold after the same centering transform as the complete model. */
  entrance?: { x: number; z: number }
  parts: { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }[]
}

export function createRusticAssets(): RusticAsset[] {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: true })
  material.userData.sharedCityAsset = true
  const huts = rusticHuts.map<RusticAsset>((id, variant) => {
    const alternate = variant % 2 === 1
    const width = alternate ? 1.26 : 1.42
    const depth = alternate ? 1.5 : 1.18
    const wall = .94
    const rise = alternate ? .82 : .72
    const base = .12, eave = wall + base, ridge = eave + rise
    const wood = alternate ? '#78523a' : '#936b47', trim = '#573e2d'
    const groups = new Map<string, THREE.BufferGeometry[]>()
    const add = (geometry: THREE.BufferGeometry, color: string) => {
      if (geometry.index) {
        const source = geometry; geometry = source.toNonIndexed(); source.dispose()
      }
      if (!groups.has(color)) groups.set(color, [])
      groups.get(color)!.push(geometry)
    }
    const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: string, rz = 0) => {
      const geometry = new THREE.BoxGeometry(w, h, d)
      geometry.rotateZ(rz); geometry.translate(x, y, z); add(geometry, color)
    }
    const beam = (a: number[], b: number[], radius: number, color: string, sides = 6) => {
      const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), direction = to.clone().sub(from)
      const geometry = new THREE.CylinderGeometry(radius, radius * 1.04, direction.length(), sides)
      geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize()))
      geometry.translate(...from.add(to).multiplyScalar(.5).toArray()); add(geometry, color)
    }
    const gable = (z: number, color: string) => {
      const shape = new THREE.Shape().moveTo(-width / 2, eave).lineTo(width / 2, eave).lineTo(0, ridge - .035).closePath()
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: .04, bevelEnabled: false, steps: 1, curveSegments: 1 })
      geometry.translate(0, 0, z); add(geometry, color)
    }
    // A visible stone plinth and separate threshold ground the house.
    box(0, base / 2, 0, width + .1, base, depth + .08, '#999585')
    for (let i = 0; i < 7; i++) {
      box(-width * .44 + i * width * .145, .064, depth / 2 + .047, width * .13, .072, .035, i % 2 ? '#aaa18e' : '#8a8a7b')
    }
    box(0, base + wall / 2, 0, width, wall, depth, alternate ? '#d4bd8c' : '#deca9e')
    // Exposed timber frame, with lightly irregular plaster infill.
    for (const x of [-width / 2, width / 2]) for (const z of [-depth / 2, depth / 2]) box(x, base + wall / 2, z, .075, wall + .05, .075, wood)
    for (const y of [base + .04, eave - .025]) box(0, y, depth / 2 + .022, width + .035, .055, .05, wood)
    gable(depth / 2 - .015, '#c9b083')
    gable(-depth / 2 - .025, '#c9b083')
    // Layered roof courses are actual geometry, so their edges catch shadows at
    // every camera angle. Both sides are one continuous gabled roof.
    const run = width / 2 + .19, slope = Math.atan2(rise, run), roofDepth = depth + .36
    const courses = 7
    for (const side of [-1, 1]) {
      box(side * run / 2, ridge - rise / 2, 0, Math.hypot(run, rise) + .06, .095, roofDepth, '#9e7b40', -side * slope)
      for (let row = 0; row < courses; row++) {
        // Overlapping courses step out from the slope; coplanar faces flicker when zoomed.
        const lift = .008 * (courses - row)
        const t = (row + .5) / courses, x = side * run * t, y = ridge - rise * t + .052 + lift
        const color = ['#c3a15e', '#b79250', '#d0b173'][row % 3]
        box(x, y, 0, Math.hypot(run, rise) / courses + .048, .066, roofDepth + (row % 2 ? .025 : 0), color, -side * slope)
        for (let reed = 0; reed < 17; reed++) {
          const z = -roofDepth / 2 + .035 + reed * (roofDepth - .07) / 16
          const half = .55 / courses
          beam([side * run * (t - half), ridge - rise * (t - half) + .091 + lift, z], [side * run * (t + half), ridge - rise * (t + half) + .091 + lift, z + (reed % 2 ? .012 : -.012)], .011, reed % 3 ? '#dbc087' : '#a98645', 4)
        }
      }
    }
    beam([0, ridge + .04, -roofDepth / 2 - .015], [0, ridge + .04, roofDepth / 2 + .015], .095, '#b48d4d', 8)
    for (let i = 0; i < 6; i++) {
      const z = -roofDepth * .42 + i * roofDepth * .168
      beam([-.105, ridge + .04, z], [0, ridge + .145, z], .016, trim, 4)
      beam([0, ridge + .145, z], [.105, ridge + .04, z], .016, trim, 4)
    }
    // Front door: inset darkness, separate planks, lintel, knob and two steps.
    const front = depth / 2 + .044, doorX = alternate ? -.23 : -.2
    box(doorX, base + .37, front, .35, .74, .034, '#3e3026')
    for (let i = 0; i < 4; i++) box(doorX - .126 + i * .084, base + .356, front + .023, .075, .66, .032, i % 2 ? wood : '#aa8354')
    for (const side of [-1, 1]) box(doorX + side * .198, base + .38, front + .035, .052, .78, .075, trim)
    box(doorX, base + .77, front + .035, .45, .065, .075, trim)
    box(doorX + .105, base + .36, front + .052, .03, .045, .035, '#ceb36e')
    box(doorX, .065, front + .19, .52, .13, .32, '#aaa08b')
    box(doorX, .028, front + .36, .6, .056, .17, '#aaa08b')
    const window = (x: number, y: number, z: number, side = false) => {
      const panel = (dx: number, dy: number, w: number, h: number, d: number, color: string) => {
        if (side) box(x + d / 2, y + dy, z + dx, d, h, w, color)
        else box(x + dx, y + dy, z + d / 2, w, h, d, color)
      }
      panel(0, 0, .37, .34, .035, '#425c58')
      for (const dx of [-.205, .205]) panel(dx, 0, .046, .41, .07, trim)
      for (const dy of [-.188, .188]) panel(0, dy, .455, .048, .085, wood)
      panel(0, 0, .025, .34, .07, '#c6ab7b'); panel(0, 0, .37, .025, .07, '#c6ab7b')
      panel(0, -.23, .49, .045, .13, wood)
    }
    window(width * .29, base + .57, front + .02)
    window(width / 2 + .024, base + .57, -.06, true)
    const colored = [...groups].flatMap(([color, geometries]) => geometries.map(geometry => vertexColor(geometry, color)))
    const merged = mergeGeometries(colored, false)!
    for (const original of colored) original.dispose()
    merged.computeBoundingBox()
    const parts = [{ geometry: merged, material }]
    const bounds = parts.reduce((box, part) => box.union(part.geometry.boundingBox!), new THREE.Box3())
    const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3())
    for (const part of parts) {
      part.geometry.translate(-center.x, -bounds.min.y, -center.z)
      part.geometry.computeBoundingBox(); part.geometry.computeBoundingSphere()
      part.geometry.userData.sharedCityAsset = true
    }
    return { id, size, parts, entrance: { x: doorX - center.x, z: front + .445 - center.z } }
  })
  return [...huts, ...rusticCabins.map((id, index) => cottage(id, index, material))]
}

/** All original geometry is colored before merging: one shared material/draw per house. */
function vertexColor(geometry: THREE.BufferGeometry, value: string) {
  geometry.deleteAttribute('uv')
  const color = new THREE.Color(value), count = geometry.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b], i * 3)
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
}

function cottage(id: typeof rusticCabins[number], kind: number, material: THREE.MeshStandardMaterial): RusticAsset {
  const pieces: THREE.BufferGeometry[] = []
  const add = (source: THREE.BufferGeometry, color: string) => {
    const geometry = source.index ? source.toNonIndexed() : source
    if (geometry !== source) source.dispose()
    pieces.push(vertexColor(geometry, color))
  }
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: string, rz = 0, rx = 0) => {
    const geometry = new THREE.BoxGeometry(w, h, d)
    geometry.rotateZ(rz); geometry.rotateX(rx); geometry.translate(x, y, z); add(geometry, color)
  }
  const beam = (a: number[], b: number[], radius: number, color: string, sides = 6) => {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), delta = to.clone().sub(from)
    const geometry = new THREE.CylinderGeometry(radius, radius, delta.length(), sides)
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()))
    geometry.translate(...from.add(to).multiplyScalar(.5).toArray()); add(geometry, color)
  }
  const face = (points: number[][], color: string) => {
    const position: number[] = []
    for (let i = 1; i < points.length - 1; i++) position.push(...points[0], ...points[i], ...points[i + 1])
    const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
    geometry.computeVertexNormals(); add(geometry, color)
  }
  const prism = (points: number[][], depth: number, z: number, color: string) => {
    const shape = new THREE.Shape().moveTo(points[0][0], points[0][1])
    for (const [x, y] of points.slice(1)) shape.lineTo(x, y)
    shape.closePath()
    const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1, curveSegments: 1 })
    geometry.translate(0, 0, z); add(geometry, color)
  }
  const wood = '#946d49', trim = '#4e4033', stone = '#b5b5a6', glass = '#526e73'
  const base = .12
  const width = [1.66, 1.88, 1.46, 1.54, 1.15, 1.78][kind]
  const depth = [1.44, 1.48, 1.70, 1.44, 1.58, 1.48][kind]
  const wall = [1.10, 1.06, 1.25, 1.16, 1.27, 1.10][kind]
  const rise = [.65, .53, .80, .92, .62, .34][kind]
  const cx = kind === 4 ? -.30 : 0, eave = base + wall, ridge = eave + rise
  const plaster = kind === 3 ? '#ddd3b4' : kind === 2 ? '#e1d7b9' : '#c3b39b'
  const roof = kind === 1 ? ['#697780', '#53636d'] : kind === 2 ? ['#af7357', '#8d5e49'] : kind === 5 ? ['#526066', '#414d52'] : ['#65766a', '#4d6054']
  box(cx, base / 2, 0, width + .12, base, depth + .10, '#96988a')
  if (kind === 0) {
    // Round interlocking beams, including visible end grain, on all four walls.
    for (let row = 0; row < 10; row++) {
      const y = base + .06 + row * wall / 10, color = row % 3 ? wood : '#ac8257'
      for (const z of [-depth / 2, depth / 2]) {
        beam([-width / 2 - .06, y, z], [width / 2 + .06, y, z], .065, color)
        for (const side of [-1, 1]) beam([side * (width / 2 + .061), y, z], [side * (width / 2 + .075), y, z], .051, '#c5a173')
      }
      for (const x of [-width / 2, width / 2]) beam([x, y + .032, -depth / 2 - .06], [x, y + .032, depth / 2 + .06], .065, color)
    }
  } else if (kind === 1) {
    // Low ashlar walls have staggered joints rather than a log-house silhouette.
    box(0, base + wall / 2, 0, width, wall, depth, '#90968e')
    for (let row = 0; row < 7; row++) for (const side of [-1, 1]) {
      for (let col = 0; col < 7; col++) {
        const x = -width / 2 + (col + .5) * width / 7, color = (row + col) % 3 ? stone : '#c6c3b2'
        box(x + (row % 2 ? .025 : -.025), base + (row + .5) * wall / 7, side * (depth / 2 + .013), width / 7 - .022, wall / 7 - .018, .038, color)
      }
      for (let col = 0; col < 6; col++) box(side * (width / 2 + .016), base + (row + .5) * wall / 7, -depth / 2 + (col + .5) * depth / 6, .042, wall / 7 - .018, depth / 6 - .024, (col + row) % 2 ? stone : '#c6c3b2')
    }
  } else {
    box(cx, base + wall / 2, 0, width, wall, depth, kind === 5 ? '#957b5a' : plaster)
    if (kind === 3) {
      for (const side of [-1, 1]) {
        for (const x of [-width / 2, 0, width / 2]) box(x, base + wall / 2, side * (depth / 2 + .025), .065, wall + .02, .065, trim)
        for (const z of [-depth / 2, 0, depth / 2]) box(side * (width / 2 + .025), base + wall / 2, z, .065, wall + .02, .065, trim)
        for (const y of [base + .04, eave - .04]) {
          box(0, y, side * (depth / 2 + .025), width + .06, .07, .07, trim)
          box(side * (width / 2 + .025), y, 0, .07, .07, depth + .06, trim)
        }
      }
    }
    if (kind === 5) for (let i = 0; i < 16; i++) {
      const x = -width / 2 + (i + .5) * width / 16, top = eave + rise * (1 - (x + width / 2) / width)
      for (const side of [-1, 1]) box(x, (base + top) / 2, side * (depth / 2 + .018), width / 16 - .015, top - base, .034, i % 3 ? '#b1956f' : '#9d815e')
    }
    if (kind === 5) for (let i = 0; i < 13; i++) for (const side of [-1, 1]) {
      const top = eave + (side < 0 ? rise : 0)
      box(side * (width / 2 + .018), (base + top) / 2, -depth / 2 + (i + .5) * depth / 13, .034, top - base, depth / 13 - .015, i % 3 ? '#b1956f' : '#9d815e')
    }
  }
  const gabledRoof = (x: number, z: number, w: number, d: number, y: number, height: number, color: string) => {
    for (const side of [-1, 1]) prism([[x - w / 2, y], [x + w / 2, y], [x, y + height]], .035, z + side * d / 2 - .018, color)
    const run = w / 2 + .12, roofRise = height * run / (w / 2), slope = Math.atan2(roofRise, run)
    for (const side of [-1, 1]) {
      box(x + side * run / 2, y + height - roofRise / 2, z, Math.hypot(run, roofRise) + .025, .07, d + .27, roof[1], -side * slope)
      for (let course = 0; course < 7; course++) {
        const t = (course + .5) / 7
        box(x + side * run * t, y + height - roofRise * t + .051 + .005 * (7 - course), z, Math.hypot(run, roofRise) / 7 + .023, .028, d + .28, roof[course % 2], -side * slope)
      }
      for (const end of [-1, 1]) beam([x + side * run, y + height - roofRise, z + end * (d / 2 + .14)], [x, y + height + .03, z + end * (d / 2 + .14)], .023, trim, 4)
    }
    beam([x, y + height + .065, z - d / 2 - .15], [x, y + height + .065, z + d / 2 + .15], .045, roof[1])
  }
  if (kind === 1) {
    // Hipped stone cottage: a short crest and four sloping roof faces.
    box(0, eave + .034, 0, width + .26, .076, depth + .26, roof[1])
    for (let course = 0; course < 6; course++) {
      const t = course / 6, next = (course + 1) / 6, w = (width / 2 + .13) * (1 - t), nw = (width / 2 + .13) * (1 - next)
      const d = depth / 2 + .13 - t * depth * .31, nd = depth / 2 + .13 - next * depth * .31
      const y = eave + rise * t + .012 * (6 - course), ny = eave + rise * next + .012 * (5 - course)
      for (const side of [-1, 1]) {
        const sideFace = [[side * w, y, -d], [side * w, y, d], [side * nw, ny, nd], [side * nw, ny, -nd]]
        const endFace = [[-w, y, side * d], [w, y, side * d], [nw, ny, side * nd], [-nw, ny, side * nd]]
        if (side > 0) sideFace.reverse()
        if (side < 0) endFace.reverse()
        face(sideFace, roof[course % 2]); face(endFace, roof[course % 2])
      }
    }
    beam([0, ridge + .022, -depth * .19 - .13], [0, ridge + .022, depth * .19 + .13], .04, roof[1])
  } else if (kind === 5) {
    prism([[-width / 2, eave], [width / 2, eave], [-width / 2, ridge]], depth, -depth / 2, '#957b5a')
    const slope = Math.atan2(rise, width)
    box(0, eave + rise / 2 + .035, 0, Math.hypot(width + .26, rise), .10, depth + .28, roof[1], -slope)
    for (let i = 0; i < 8; i++) box(0, eave + rise / 2 + .09, -depth / 2 + i * depth / 7, Math.hypot(width + .26, rise), .018, .025, roof[0], -slope)
  } else gabledRoof(cx, 0, width, depth, eave, rise, kind === 0 ? wood : plaster)
  if (kind === 3) for (const side of [-1, 1]) {
    const z = side * (depth / 2 + .027)
    beam([-width / 2 + .07, eave + .02, z], [0, ridge - .035, z], .027, trim, 4)
    beam([width / 2 - .07, eave + .02, z], [0, ridge - .035, z], .027, trim, 4)
    beam([0, eave, z], [0, ridge - .02, z], .026, trim, 4)
  }
  if (kind === 4) {
    // The wing overlaps the main wall by .10: one continuous, attached floor plan.
    const wx = .55, ww = .70, wd = depth - .12, wy = .93
    box(wx, base / 2, -.06, ww + .08, base, wd + .08, '#96988a')
    box(wx, (base + wy) / 2, -.06, ww, wy - base, wd, '#b2a38a')
    prism([[wx - ww / 2, wy], [wx + ww / 2, wy], [wx - ww / 2, eave - .12]], wd, -.06 - wd / 2, '#b2a38a')
    const run = ww + .22, roofRise = (eave - .12 - wy) * run / ww, slope = Math.atan2(roofRise, run)
    box(wx, (eave - .12 + wy) / 2 + .025, -.06, Math.hypot(run, roofRise), .075, wd + .22, roof[1], -slope)
    for (let i = 0; i < 6; i++) box(wx, (eave - .12 + wy) / 2 + .069, -.06 - wd / 2 + i * wd / 5, Math.hypot(run, roofRise), .02, .027, roof[0], -slope)
  }
  // Facing-aware windows give every visible elevation an actual glazed opening.
  const window = (x: number, y: number, z: number, facing: 'front' | 'back' | 'left' | 'right', w = .40, h = .38) => {
    const panel = (dx: number, dy: number, width: number, height: number, thick: number, color: string) => {
      if (facing === 'front' || facing === 'back') box(x + dx, y + dy, z + (facing === 'front' ? 1 : -1) * thick / 2, width, height, thick, color)
      else box(x + (facing === 'right' ? 1 : -1) * thick / 2, y + dy, z + dx, thick, height, width, color)
    }
    panel(0, 0, w, h, .035, glass)
    for (const dx of [-(w + .04) / 2, (w + .04) / 2]) panel(dx, 0, .044, h + .09, .065, trim)
    for (const dy of [-(h + .04) / 2, (h + .04) / 2]) panel(0, dy, w + .09, .044, .075, kind === 1 || kind === 2 ? '#d5ccb5' : wood)
    panel(0, 0, .026, h, .07, '#c5b28e')
    if (kind !== 5) panel(0, 0, w, .024, .07, '#c5b28e')
    panel(0, -h / 2 - .075, w + .13, .045, .11, kind === 1 ? stone : wood)
  }
  const front = depth / 2 + (kind === 0 ? .071 : .036)
  const doorX = cx - width * .22
  box(doorX, base + .385, front + .018, .36, .77, .045, '#443a31')
  for (let i = 0; i < 5; i++) box(doorX - .136 + i * .068, base + .365, front + .048, .058, .71, .025, kind === 2 ? '#708275' : wood)
  for (const side of [-1, 1]) box(doorX + side * .205, base + .39, front + .051, .048, .82, .075, kind === 1 ? '#d5ccb5' : trim)
  box(doorX, base + .805, front + .051, .46, .062, .075, kind === 1 ? '#d5ccb5' : trim)
  box(doorX + .11, base + .39, front + .071, .03, .038, .024, '#cbb275')
  box(doorX, .065, front + .16, .55, .13, .26, '#aaa18d')
  window(cx + width * .27, base + .61, front + .015, 'front', kind === 5 ? .64 : .38, kind === 1 ? .33 : .40)
  window(cx, base + .63, -front - .015, 'back', kind === 5 ? .76 : .48, .40)
  window(cx - width / 2 - (kind === 0 ? .071 : .032), base + .64, 0, 'left', .51, .39)
  if (kind !== 4) window(cx + width / 2 + (kind === 0 ? .071 : .032), base + .64, 0, 'right', .51, .39)
  else {
    window(.55, base + .46, depth / 2 - .09, 'front', .35, .31)
    window(.55, base + .46, -depth / 2 -.075, 'back', .35, .31)
    window(.932, base + .46, -.06, 'right', .42, .31)
  }
  if (kind === 3) for (const side of [-1, 1]) window(0, eave + .32, side * (depth / 2 + .041), side > 0 ? 'front' : 'back', .24, .26)
  if (kind === 2) {
    // A compact tiled eyebrow over the entrance, without an outsized porch.
    box(doorX, base + .94, front + .11, .62, .055, .30, roof[0], 0, .15)
    for (const side of [-1, 1]) beam([doorX + side * .25, base + .77, front + .025], [doorX + side * .25, base + .92, front + .21], .023, trim, 4)
  }
  if (kind !== 5) {
    const chimneyBottom = ridge - Math.max(.45, rise * .65), chimneyTop = ridge + .145
    box(cx - width * .28, (chimneyBottom + chimneyTop) / 2, -depth * .20, .18, chimneyTop - chimneyBottom, .19, kind === 1 ? stone : '#a49a87')
    box(cx - width * .28, ridge + .155, -depth * .20, .23, .06, .24, '#78786e')
  }
  const geometry = mergeGeometries(pieces, false)!
  for (const piece of pieces) piece.dispose()
  geometry.computeBoundingBox()
  const bounds = geometry.boundingBox!, center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3())
  geometry.translate(-center.x, -bounds.min.y, -center.z)
  geometry.computeBoundingBox(); geometry.computeBoundingSphere(); geometry.userData.sharedCityAsset = true
  return { id, size, parts: [{ geometry, material }], entrance: { x: doorX - center.x, z: front + .29 - center.z } }
}
