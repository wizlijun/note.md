import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// Original procedural architecture. One asset is one complete building; garden
// furniture belongs to the scene and does not introduce another knowledge node.
export const rusticHuts = ['rustic/hut-a', 'rustic/hut-b'] as const
export const rusticCabins = ['rustic/cabin-a', 'rustic/cabin-b'] as const
export type RusticAssetId = typeof rusticHuts[number] | typeof rusticCabins[number]
export interface RusticAsset {
  id: RusticAssetId
  size: THREE.Vector3
  parts: { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }[]
}

export function createRusticAssets(): RusticAsset[] {
  const materials = new Map<string, THREE.MeshStandardMaterial>()
  const material = (color: string) => {
    if (!materials.has(color)) {
      const value = new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0 })
      value.userData.sharedCityAsset = true
      materials.set(color, value)
    }
    return materials.get(color)!
  }
  return [...rusticHuts, ...rusticCabins].map((id, variant) => {
    const hut = variant < 2, alternate = variant % 2 === 1
    const width = hut ? alternate ? 1.26 : 1.42 : alternate ? 1.8 : 1.55
    const depth = hut ? alternate ? 1.5 : 1.18 : alternate ? 1.36 : 1.25
    const wall = hut ? .94 : alternate ? 1.22 : 1.1
    const rise = hut ? alternate ? .82 : .72 : .64
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
    if (hut) {
      box(0, base + wall / 2, 0, width, wall, depth, alternate ? '#d4bd8c' : '#deca9e')
      // Exposed timber frame, with lightly irregular plaster infill.
      for (const x of [-width / 2, width / 2]) for (const z of [-depth / 2, depth / 2]) box(x, base + wall / 2, z, .075, wall + .05, .075, wood)
      for (const y of [base + .04, eave - .025]) box(0, y, depth / 2 + .022, width + .035, .055, .05, wood)
    } else {
      // Interlocking horizontal logs keep the cabin distinct from a plaster hut.
      const rows = Math.floor(wall / .115)
      for (let row = 0; row < rows; row++) {
        const y = base + .07 + row * wall / rows, color = row % 3 === 0 ? '#a47a50' : wood
        for (const z of [-depth / 2, depth / 2]) {
          beam([-width / 2 - .065, y, z], [width / 2 + .065, y, z], .067, color)
          for (const side of [-1, 1]) beam([side * (width / 2 + .066), y, z], [side * (width / 2 + .073), y, z], .05, '#ba9566')
        }
        for (const x of [-width / 2, width / 2]) beam([x, y + .035, -depth / 2 - .08], [x, y + .035, depth / 2 + .08], .063, color)
      }
    }
    gable(depth / 2 - .015, hut ? '#c9b083' : wood)
    gable(-depth / 2 - .025, hut ? '#c9b083' : wood)
    // Layered roof courses are actual geometry, so their edges catch shadows at
    // every camera angle. Both sides are one continuous gabled roof.
    const run = width / 2 + .19, slope = Math.atan2(rise, run), roofDepth = depth + .36
    const courses = hut ? 7 : 6
    for (const side of [-1, 1]) {
      box(side * run / 2, ridge - rise / 2, 0, Math.hypot(run, rise) + .06, hut ? .095 : .065, roofDepth, hut ? '#9e7b40' : '#536761', -side * slope)
      for (let row = 0; row < courses; row++) {
        // Overlapping courses step out from the slope; coplanar faces flicker when zoomed.
        const lift = .008 * (courses - row)
        const t = (row + .5) / courses, x = side * run * t, y = ridge - rise * t + .052 + lift
        const color = hut ? ['#c3a15e', '#b79250', '#d0b173'][row % 3] : ['#60776f', '#50675f'][row % 2]
        box(x, y, 0, Math.hypot(run, rise) / courses + .048, hut ? .066 : .033, roofDepth + (row % 2 ? .025 : 0), color, -side * slope)
        if (hut) for (let reed = 0; reed < 17; reed++) {
          const z = -roofDepth / 2 + .035 + reed * (roofDepth - .07) / 16
          const half = .55 / courses
          beam([side * run * (t - half), ridge - rise * (t - half) + .091 + lift, z], [side * run * (t + half), ridge - rise * (t + half) + .091 + lift, z + (reed % 2 ? .012 : -.012)], .011, reed % 3 ? '#dbc087' : '#a98645', 4)
        }
      }
    }
    beam([0, ridge + .04, -roofDepth / 2 - .015], [0, ridge + .04, roofDepth / 2 + .015], hut ? .095 : .065, hut ? '#b48d4d' : '#45594f', 8)
    if (hut) for (let i = 0; i < 6; i++) {
      const z = -roofDepth * .42 + i * roofDepth * .168
      beam([-.105, ridge + .04, z], [0, ridge + .145, z], .016, trim, 4)
      beam([0, ridge + .145, z], [.105, ridge + .04, z], .016, trim, 4)
    }
    // Front door: inset darkness, separate planks, lintel, knob and two steps.
    const front = depth / 2 + (hut ? .044 : .075), doorX = alternate ? -.23 : -.2
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
    window(width / 2 + (hut ? .024 : .065), base + .57, -.06, true)
    if (!hut) {
      // A single chimney attaches to the existing house; it is never a second body.
      box(-width * .27, ridge - .11, -depth * .2, .18, .54, .19, '#a4927d')
      box(-width * .27, ridge + .165, -depth * .2, .23, .065, .24, '#817867')
    }
    const parts = [...groups].map(([color, geometries]) => {
      const geometry = mergeGeometries(geometries, false)!
      for (const original of geometries) original.dispose()
      geometry.computeBoundingBox(); return { geometry, material: material(color) }
    })
    const bounds = parts.reduce((box, part) => box.union(part.geometry.boundingBox!), new THREE.Box3())
    const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3())
    for (const part of parts) {
      part.geometry.translate(-center.x, -bounds.min.y, -center.z)
      part.geometry.computeBoundingBox(); part.geometry.computeBoundingSphere()
      part.geometry.userData.sharedCityAsset = true
    }
    return { id, size, parts }
  })
}
