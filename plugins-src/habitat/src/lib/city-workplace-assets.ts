import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

export const workplaceStudios = ['architecture/studio-a', 'architecture/studio-b', 'architecture/studio-c'] as const
export type WorkplaceAssetId = typeof workplaceStudios[number]
export interface WorkplaceAsset {
  id: WorkplaceAssetId
  size: THREE.Vector3
  entrance?: { x: number; z: number }
  parts: { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }[]
}

/** Original attached workshop volumes; each complete asset is one knowledge address. */
export function createWorkplaceAssets(): WorkplaceAsset[] {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .94, metalness: 0, flatShading: true })
  material.userData.sharedCityAsset = true
  return workplaceStudios.map((id, variant) => {
    const pieces: THREE.BufferGeometry[] = []
    let entrance = { x: 0, z: 0 }
    const c = { stone: '#a8a396', dark: '#3d4947', glass: '#526f77', light: '#819e9e', frame: '#d5d3be', wood: '#9d7650', roof: '#526964' }
    const add = (input: THREE.BufferGeometry, color: string) => {
      const geometry = input.index ? input.toNonIndexed() : input
      if (geometry !== input) input.dispose()
      const rgb = new THREE.Color(color), count = geometry.getAttribute('position').count, values = new Float32Array(count * 3)
      for (let i = 0; i < count; i++) rgb.toArray(values, i * 3)
      geometry.setAttribute('color', new THREE.BufferAttribute(values, 3)); pieces.push(geometry)
    }
    const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: string, rz = 0, rx = 0) => {
      const g = new THREE.BoxGeometry(w, h, d); g.rotateZ(rz); g.rotateX(rx); g.translate(x, y, z); add(g, color)
    }
    const beam = (a: number[], b: number[], radius: number, color: string) => {
      const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), delta = to.clone().sub(from)
      const g = new THREE.CylinderGeometry(radius, radius, delta.length(), 6)
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()))
      g.translate(...from.add(to).multiplyScalar(.5).toArray()); add(g, color)
    }
    // Four complete facades: glazing sits behind raised frames and a projecting sill.
    const window = (u: number, y: number, face: number, w: number, h: number, orientation: 'front' | 'back' | 'left' | 'right', columns = 2, rows = 2) => {
      const side = orientation === 'left' || orientation === 'right', direction = orientation === 'back' || orientation === 'left' ? -1 : 1
      const panel = (du: number, dy: number, width: number, height: number, depth: number, color: string, outward = 0) => {
        if (side) box(face + direction * (outward + depth / 2), y + dy, u + du, depth, height, width, color)
        else box(u + du, y + dy, face + direction * (outward + depth / 2), width, height, depth, color)
      }
      panel(0, 0, w + .09, h + .09, .023, c.dark)
      panel(0, 0, w, h, .035, c.glass, .018)
      panel(-w * .23, h * .20, w * .43, h * .34, .008, c.light, .054)
      for (const dx of [-w / 2, w / 2]) panel(dx, 0, .045, h + .10, .07, c.frame, .022)
      for (const dy of [-h / 2, h / 2]) panel(0, dy, w + .10, .048, .07, c.frame, .022)
      for (let i = 1; i < columns; i++) panel(-w / 2 + w * i / columns, 0, .025, h, .045, c.frame, .04)
      for (let i = 1; i < rows; i++) panel(0, -h / 2 + h * i / rows, w, .025, .045, c.frame, .04)
      panel(0, -h / 2 - .055, w + .16, .055, .13, c.stone, .012)
    }
    const door = (x: number, z: number, top: number, width = .48) => {
      const bottom = .14, height = top - bottom
      box(x, bottom + height / 2, z + .035, width, height, .065, c.dark)
      window(x, bottom + height * .67, z + .07, width - .14, height * .48, 'front', 1, 1)
      box(x, bottom + height * .21, z + .08, width - .10, height * .27, .04, c.wood)
      for (const side of [-1, 1]) box(x + side * (width / 2 + .035), bottom + height / 2, z + .065, .065, height + .09, .10, c.frame)
      box(x, top + .025, z + .065, width + .14, .08, .10, c.frame)
      box(x + width * .29, bottom + height * .44, z + .103, .025, .12, .035, '#c2b17c')
      box(x, .065, z + .20, width + .28, .13, .30, c.stone)
      box(x, .025, z + .40, width + .40, .05, .18, '#b5afa0')
      entrance = { x, z: z + .49 }
    }
    const gable = (x: number, z: number, width: number, eave: number, rise: number, color: string) => {
      const shape = new THREE.Shape().moveTo(x - width / 2, eave).lineTo(x + width / 2, eave).lineTo(x, eave + rise).closePath()
      const g = new THREE.ExtrudeGeometry(shape, { depth: .06, bevelEnabled: false, steps: 1, curveSegments: 1 }); g.translate(0, 0, z); add(g, color)
    }
    const rail = (a: number[], b: number[], base: number, height: number) => {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]), count = Math.ceil(length / .25)
      for (let i = 0; i <= count; i++) {
        const t = i / count
        box(a[0] + (b[0] - a[0]) * t, base + height / 2, a[1] + (b[1] - a[1]) * t, .033, height, .033, c.dark)
      }
      for (const y of [base + height * .34, base + height]) beam([a[0], y, a[1]], [b[0], y, b[1]], .022, c.dark)
    }

    if (variant === 0) {
      // Brick hall with three asymmetrical north-light bays, all sharing one body.
      const width = 2.85, depth = 2.18, eave = 1.72, bay = width / 3
      box(0, .08, 0, width + .12, .16, depth + .12, c.stone)
      box(0, .94, 0, width, 1.56, depth, '#aa6951')
      for (let row = 0; row < 11; row++) {
        const y = .22 + row * .132
        for (const side of [-1, 1]) {
          for (let col = 0; col < 10; col++) {
            const x = -width / 2 + .145 + col * .28 + (row % 2 ? .12 : 0)
            if (x + .13 < width / 2) box(x, y, side * (depth / 2 + .008), .26, .115, .024, (row + col) % 5 ? '#ad7059' : '#bb8368')
          }
          for (let col = 0; col < 7; col++) {
            const z = -depth / 2 + .15 + col * .285 + (row % 2 ? .12 : 0)
            if (z + .13 < depth / 2) box(side * (width / 2 + .008), y, z, .024, .115, .265, (row + col) % 4 ? '#a46751' : '#bc8369')
          }
        }
      }
      for (const side of [-1, 1]) box(0, eave - .015, side * (depth / 2 + .02), width + .12, .09, .13, c.stone)
      for (let i = 0; i < 3; i++) {
        const left = -width / 2 + i * bay - .035, right = left + bay + .04, high = left + bay * .75, top = eave + .54
        for (const z of [-depth / 2 - .035, depth / 2 - .025]) {
          const shape = new THREE.Shape().moveTo(left, eave).lineTo(right, eave).lineTo(high, top).closePath()
          const g = new THREE.ExtrudeGeometry(shape, { depth: .06, bevelEnabled: false, curveSegments: 1, steps: 1 }); g.translate(0, 0, z); add(g, '#9f6650')
        }
        const longRun = high - left, shortRun = right - high
        box((left + high) / 2, eave + .27, 0, Math.hypot(longRun, .54) + .07, .055, depth + .24, c.roof, Math.atan2(.54, longRun))
        box((right + high) / 2, eave + .27, 0, Math.hypot(shortRun, .54) + .04, .035, depth + .16, '#7c999d', -Math.atan2(.54, shortRun))
        for (let j = 0; j < 7; j++) beam([high, top + .035, -depth / 2 + j * depth / 6], [right, eave + .025, -depth / 2 + j * depth / 6], .014, c.frame)
        beam([high, top + .035, -depth / 2 - .13], [high, top + .035, depth / 2 + .13], .033, c.dark)
        beam([left, eave + .015, -depth / 2 - .13], [left, eave + .015, depth / 2 + .13], .025, c.dark)
      }
      door(0, depth / 2 + .045, 1.15, .52)
      for (const x of [-.98, .98]) window(x, .99, depth / 2 + .035, .55, .91, 'front', 2, 3)
      for (const x of [-.92, 0, .92]) window(x, .99, -depth / 2 - .035, .57, .91, 'back', 2, 3)
      for (const side of [-1, 1]) for (const z of [-.62, .52]) window(z, .99, side * (width / 2 + .035), .65, .91, side < 0 ? 'left' : 'right', 2, 3)
      box(0, 1.35, depth / 2 + .22, .90, .09, .45, c.dark)
      for (const x of [-.39, .39]) beam([x, 1.10, depth / 2 + .06], [x, 1.31, depth / 2 + .40], .025, c.dark)
      for (const x of [-width / 2, width / 2]) beam([x, .16, -depth / 2 - .055], [x, eave, -depth / 2 - .055], .024, c.dark)
    } else if (variant === 1) {
      // Daylight atelier: steep longitudinal gable, four roof lights, attached entrance vestibule.
      const width = 2.35, depth = 2.25, eave = 1.48, rise = .84, run = width / 2 + .13, ridge = eave + rise
      box(0, .08, 0, width + .12, .16, depth + .12, c.stone)
      box(0, .82, 0, width, 1.32, depth, '#dfd7be')
      for (const x of [-width / 2, width / 2]) for (let i = 0; i < 14; i++) box(x, .80, -depth / 2 + .075 + i * .16, .028, 1.23, .025, '#b29e7d')
      for (const z of [-depth / 2 - .02, depth / 2 - .02]) gable(0, z, width, eave - .02, rise, '#c4b493')
      const slope = Math.atan2(rise, run), roofLength = Math.hypot(run, rise)
      for (const side of [-1, 1]) {
        box(side * run / 2, ridge - rise / 2, 0, roofLength + .03, .065, depth + .34, c.roof, -side * slope)
        for (let i = 0; i < 8; i++) {
          const z = -depth / 2 - .14 + i * (depth + .28) / 7
          beam([0, ridge + .04, z], [side * run, eave + .035, z], .013, '#7f9284')
        }
        for (const z of [-.60, .44]) {
          box(side * run * .48, ridge - rise * .48 + .061, z, roofLength * .58, .033, .72, c.dark, -side * slope)
          box(side * run * .48, ridge - rise * .48 + .084, z, roofLength * .52, .035, .63, '#8ba8a9', -side * slope)
          for (const zz of [z - .32, z + .32]) box(side * run * .48, ridge - rise * .48 + .105, zz, roofLength * .55, .025, .028, c.frame, -side * slope)
          box(side * run * .48, ridge - rise * .48 + .109, z, .035, .025, .66, c.frame, -side * slope)
        }
      }
      beam([0, ridge + .045, -depth / 2 - .19], [0, ridge + .045, depth / 2 + .19], .035, c.dark)
      for (const x of [-.76, .76]) window(x, .83, depth / 2 + .025, .55, .62, 'front', 2, 2)
      for (const side of [-1, 1]) window(-.04, .83, side * (width / 2 + .028), 1.64, .63, side < 0 ? 'left' : 'right', 5, 2)
      window(0, .87, -depth / 2 - .03, 1.65, .78, 'back', 5, 2)
      window(0, 1.74, -depth / 2 - .065, .38, .34, 'back', 2, 1)
      box(0, .67, depth / 2 + .19, .78, 1.08, .48, '#bba47d')
      box(0, 1.24, depth / 2 + .23, .92, .10, .65, c.roof, 0, -.06)
      door(0, depth / 2 + .45, 1.10, .44)
      for (const x of [-.4, .4]) box(x, .66, depth / 2 + .25, .065, 1.14, .54, '#78694f')
      for (const x of [-width / 2, width / 2]) beam([x, .17, -depth / 2 - .08], [x, eave - .02, -depth / 2 - .08], .021, c.dark)
    } else {
      // One connected L-shaped upper floor opens onto its own lower-wing terrace.
      const width = 2.65, depth = 2.22, terrace = 1.39, top = 2.55
      box(0, .08, 0, width + .12, .16, depth + .12, c.stone)
      box(0, .75, 0, width, 1.18, depth, '#d7d3c1')
      box(0, terrace - .04, 0, width + .14, .12, depth + .14, '#a5a498')
      box(-.69, 1.95, 0, 1.27, 1.13, depth, '#b87e62')
      box(.635, 1.95, -.73, 1.38, 1.13, .76, '#b87e62')
      box(-.69, top, 0, 1.40, .12, depth + .14, c.roof)
      box(.635, top, -.73, 1.41, .12, .90, c.roof)
      for (const z of [-depth / 2 - .04, depth / 2 + .04]) box(-.69, top + .06, z, 1.43, .10, .055, '#89938a')
      box(-1.37, top + .06, 0, .055, .10, depth + .14, '#89938a')
      box(.025, top + .06, .37, .055, .10, 1.52, '#89938a')
      box(.68, top + .06, -.28, 1.33, .10, .055, '#89938a')
      box(1.35, top + .06, -.73, .055, .10, .91, '#89938a')
      box(.68, top + .06, -1.15, 1.34, .10, .055, '#89938a')
      door(-.03, depth / 2 + .022, 1.14, .5)
      for (const x of [-.88, .89]) window(x, .76, depth / 2 + .025, .53, .66, 'front', 2, 2)
      for (const side of [-1, 1]) for (const z of [-.62, .48]) window(z, .77, side * (width / 2 + .028), .72, .66, side < 0 ? 'left' : 'right', 2, 2)
      for (const x of [-.78, .75]) window(x, .78, -depth / 2 - .03, .88, .70, 'back', 3, 2)
      window(-.69, 1.95, depth / 2 + .022, .88, .72, 'front', 3, 2)
      window(.64, 1.99, -.335, .93, .68, 'front', 3, 2)
      for (const x of [-.68, .70]) window(x, 1.97, -depth / 2 - .025, .83, .68, 'back', 3, 2)
      window(-.06, 1.99, -1.345, 1.67, .69, 'left', 5, 2)
      window(-.71, 1.99, 1.345, .45, .69, 'right', 2, 2)
      window(.41, 1.89, -.052, .55, .93, 'right', 1, 2)
      for (let i = 0; i < 8; i++) box(.67, terrace + .025, -.22 + i * .17, 1.21, .024, .15, i % 2 ? '#b5aa8b' : '#c2b69a')
      rail([.06, 1.145], [1.35, 1.145], terrace + .025, .43)
      rail([1.35, 1.145], [1.35, -.30], terrace + .025, .43)
      box(-.03, 1.27, depth / 2 + .24, 1.02, .095, .52, c.dark)
      for (const x of [-.45, .40]) beam([x, 1.02, depth / 2 + .03], [x, 1.24, depth / 2 + .42], .022, c.dark)
    }
    const geometry = mergeGeometries(pieces, false)!
    for (const piece of pieces) piece.dispose()
    geometry.computeBoundingBox()
    const bounds = geometry.boundingBox!, center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3())
    geometry.translate(-center.x, -bounds.min.y, -center.z)
    geometry.computeBoundingBox(); geometry.computeBoundingSphere(); geometry.userData.sharedCityAsset = true
    return { id, size, entrance: { x: entrance.x - center.x, z: entrance.z - center.z }, parts: [{ geometry, material }] }
  })
}
