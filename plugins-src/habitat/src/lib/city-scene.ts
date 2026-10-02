import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CityAssets, houses, commercial, trees, tents, type CityAssetId, type CityAssetPlacement } from './city-assets'
import { focusDistrictLabel } from './domain'
import { planCity, segmentDistance, type CityPlan, type CityPoint, type CityPlacement } from './city-plan'
import type { Attention, Edge, Layout, Membership, Node } from './types'

const SCALE = .052
const known = new Map([['hemory', 'campus'], ['note.md', 'campus'], ['bushcraft', 'camp']])
export function landmarkStyle(node: Node) { return ['anchor', 'observed', 'user-confirmed', 'confirmed'].includes(node.status) ? known.get(node.label.toLowerCase()) : undefined }
function seed(text: string) {
  let n = 2166136261
  for (const c of text) n = Math.imul(n ^ c.charCodeAt(0), 16777619)
  // Avalanche suffix differences: x/z samples must not form diagonal bands.
  n = Math.imul(n ^ n >>> 16, 0x85ebca6b); n = Math.imul(n ^ n >>> 13, 0xc2b2ae35)
  return ((n ^ n >>> 16) >>> 0) / 4294967296
}
interface VisualLot { node: Node; x: number; z: number; h: number; w: number; style?: string; parcelId: string; district?: { name: string; count: number; kind: string; topicId?: string; unassigned?: boolean; contextName?: string; attentionCategory?: string } }
export interface CityData { nodes: Node[]; layout: Layout[]; edges: Edge[]; memberships?: Membership[]; topics?: Node[]; keywordGraph?: boolean; attention?: Attention[] }
export interface Label { id: string; nodeId?: string; attentionCategory?: string; name: string; x: number; y: number; kind: string; selected: boolean; district?: { name: string; count: number; kind: string; topicId?: string; unassigned?: boolean; contextName?: string; attentionCategory?: string }; compact?: boolean; width?: number }
export interface SceneStatus { labels: Label[]; count: number; rendered?: number; aggregated?: boolean; zoom?: number; loading?: boolean; error?: string; hover?: { name: string; kind: string; x: number; y: number } }
type Primitive = { p: number[]; s: number[]; ry?: number; color?: string }

function polygonGeometry(points: CityPoint[], y: number) {
  const shape = new THREE.Shape(points.map(p => new THREE.Vector2(p.x, -p.z)))
  const geometry = new THREE.ShapeGeometry(shape)
  geometry.rotateX(-Math.PI / 2); geometry.translate(0, y, 0)
  const pos = geometry.getAttribute('position'), uv = geometry.getAttribute('uv')
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) * .1, pos.getZ(i) * .1)
  return geometry
}
function ribbon(points: CityPoint[], width: number, y: number) {
  const vertices: number[] = [], indices: number[] = []
  points.forEach((p, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)]
    const length = Math.hypot(b.x - a.x, b.z - a.z) || 1, x = -(b.z - a.z) / length * width / 2, z = (b.x - a.x) / length * width / 2
    vertices.push(p.x + x, y, p.z + z, p.x - x, y, p.z - z)
    if (i) { const n = i * 2; indices.push(n - 2, n, n - 1, n - 1, n, n + 1) }
  })
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); g.setIndex(indices); g.computeVertexNormals(); return g
}
function hull(points: CityPoint[]) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z)
  const cross = (a: CityPoint, b: CityPoint, c: CityPoint) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
  const lower: CityPoint[] = [], upper: CityPoint[] = []
  for (const p of sorted) { while (lower.length > 1 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 0) lower.pop(); lower.push(p) }
  for (const p of [...sorted].reverse()) { while (upper.length > 1 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 0) upper.pop(); upper.push(p) }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}
function inPolygon(point: CityPoint, polygon: CityPoint[]) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j]
    if ((a.z > point.z) !== (b.z > point.z) && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

export class CityScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-60, 60, 45, -45, .1, 700)
  private controls: OrbitControls
  private city = new THREE.Group()
  private assets: CityAssets | null = null
  private assetQueue = new Map<CityAssetId, CityAssetPlacement[]>()
  private materials = new Map<string, THREE.Material>()
  private textures: THREE.Texture[] = []
  private latest: CityData | null = null
  private reframe = true
  private lots: VisualLot[] = []
  private byId = new Map<string, VisualLot>()
  private blockMembers = new Map<string, string[]>()
  private pickables: THREE.InstancedMesh[] = []
  private instanceIds = new Map<THREE.Object3D, (string | null)[]>()
  private labels: VisualLot[] = []
  private markers = new THREE.Group()
  private selected = ''
  private changed = new Set<string>()
  private bounds = new THREE.Box3()
  private frame = 0
  private width = 1
  private height = 1
  private dark = false
  private disposed = false
  private loading = true
  private error = ''
  private total = 0
  private pointerDown: { x: number; y: number } | null = null
  private lastHover = 0
  private ray = new THREE.Raycaster()
  private mouse = new THREE.Vector2()
  private sun: THREE.DirectionalLight
  private hemisphere: THREE.HemisphereLight
  private ground: THREE.Mesh | null = null
  private water: THREE.Mesh | null = null
  private contact: Primitive[] = []
  private driveways: THREE.BufferGeometry[] = []
  private grass: THREE.CanvasTexture
  private paving: THREE.CanvasTexture
  private contactMap: THREE.CanvasTexture

  constructor(private canvas: HTMLCanvasElement, private status: (value: SceneStatus) => void, private select: (id: string) => void) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.18
    this.camera.position.set(90, 95, 110)
    this.controls = new OrbitControls(this.camera, canvas); this.controls.enableDamping = false
    this.controls.minPolarAngle = .3; this.controls.maxPolarAngle = 1.25; this.controls.minZoom = .45; this.controls.maxZoom = 18
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
    this.controls.addEventListener('change', this.schedule)
    this.hemisphere = new THREE.HemisphereLight(0xeaf2ff, 0x69784a, 2.1)
    this.sun = new THREE.DirectionalLight(0xffecd2, 3.1); this.sun.position.set(-50, 95, 35); this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048); this.sun.shadow.camera.near = .1; this.sun.shadow.camera.far = 350
    this.sun.shadow.bias = -.00008; this.sun.shadow.normalBias = .035; this.sun.shadow.radius = 3
    this.scene.add(this.hemisphere, this.sun, this.sun.target, this.city, this.markers)
    this.grass = this.makeTexture('grass'); this.paving = this.makeTexture('paving'); this.contactMap = this.makeTexture('shadow')
    canvas.addEventListener('pointerdown', this.down); canvas.addEventListener('pointerup', this.up); canvas.addEventListener('pointermove', this.hover); canvas.addEventListener('pointerleave', this.leave); canvas.addEventListener('contextmenu', this.contextMenu)
    CityAssets.load().then(assets => {
      if (this.disposed) { assets.dispose(); return }
      this.assets = assets; this.loading = false
      if (this.latest) this.rebuild(this.latest, this.reframe)
      else this.schedule()
    }).catch(error => { if (!this.disposed) { this.loading = false; this.error = String(error); this.schedule() } })
  }
  private contextMenu = (e: Event) => e.preventDefault()
  private makeTexture(kind: 'grass' | 'paving' | 'shadow') {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = kind === 'shadow' ? 64 : 256
    const c = canvas.getContext('2d')!
    if (kind === 'shadow') {
      const gradient = c.createRadialGradient(32, 32, 3, 32, 32, 31); gradient.addColorStop(0, 'rgba(25,35,22,.7)'); gradient.addColorStop(.5, 'rgba(25,35,22,.28)'); gradient.addColorStop(1, 'rgba(25,35,22,0)'); c.fillStyle = gradient; c.fillRect(0, 0, 64, 64)
    } else {
      c.fillStyle = kind === 'grass' ? '#a7b780' : '#c6c5b4'; c.fillRect(0, 0, 256, 256)
      for (let i = 0; i < 6000; i++) { const v = seed(`${kind}:${i}`); c.fillStyle = `rgba(${v > .5 ? '255,255,220' : '50,65,35'},${.02 + v * .075})`; c.fillRect(seed(`${i}:x`) * 256, seed(`${i}:z`) * 256, 1 + v * 3, 1 + v * 3) }
      if (kind === 'paving') { c.strokeStyle = '#868e791f'; c.lineWidth = 1; for (let i = 0; i < 256; i += 16) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 256); c.moveTo(0, i); c.lineTo(256, i); c.stroke() } }
    }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = kind === 'shadow' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping; texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy()); this.textures.push(texture); return texture
  }
  private material(color: string, texture?: THREE.Texture) {
    const key = `${color}:${texture?.uuid ?? ''}`
    if (!this.materials.has(key)) this.materials.set(key, new THREE.MeshStandardMaterial({ color, map: texture ?? null, roughness: .98, metalness: 0 }))
    return this.materials.get(key)!
  }
  private mesh(geometry: THREE.BufferGeometry, material: THREE.Material, cast = false) {
    const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = cast; mesh.receiveShadow = true; this.city.add(mesh); return mesh
  }
  private merge(geometries: THREE.BufferGeometry[], material: THREE.Material) {
    if (!geometries.length) return
    const merged = mergeGeometries(geometries); geometries.forEach(g => g.dispose()); if (merged) this.mesh(merged, material)
  }
  private batch(geometry: THREE.BufferGeometry, color: string, entries: Primitive[], cast = true) {
    if (!entries.length) { geometry.dispose(); return }
    const mesh = new THREE.InstancedMesh(geometry, this.material(color), entries.length), dummy = new THREE.Object3D()
    entries.forEach((entry, i) => { dummy.position.fromArray(entry.p); dummy.scale.fromArray(entry.s); dummy.rotation.set(0, entry.ry ?? 0, 0); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); mesh.setColorAt(i, new THREE.Color(entry.color ?? '#ffffff')) })
    mesh.castShadow = cast; mesh.receiveShadow = true; mesh.computeBoundingSphere(); this.city.add(mesh)
  }
  private addAsset(asset: CityAssetId, x: number, z: number, radius: number, rotation = 0, id?: string, y = .19) {
    const size = this.assets!.size(asset), scale = radius * 2 / Math.hypot(size.x, size.z)
    if (!this.assetQueue.has(asset)) this.assetQueue.set(asset, [])
    this.assetQueue.get(asset)!.push({ x, y, z, rotation, scale, id })
    this.contact.push({ p: [x, .18, z], s: [radius * 2.5, radius * 2.5, 1] })
    return size.y * scale
  }
  private clearGroup(group: THREE.Group) {
    group.traverse(object => { if (object instanceof THREE.Mesh && !object.geometry.userData.sharedCityAsset) object.geometry.dispose(); if (object instanceof THREE.InstancedMesh) object.dispose() })
    group.clear()
  }
  private clear() { this.clearGroup(this.city); this.clearGroup(this.markers); this.pickables = []; this.instanceIds.clear(); this.assetQueue.clear(); this.contact = []; this.byId.clear(); this.blockMembers.clear(); this.lots = []; this.labels = [] }
  setData(data: CityData, reframe: boolean) {
    this.latest = data; this.reframe = reframe; this.total = data.nodes.length
    if (this.assets) this.rebuild(data, reframe); else this.schedule()
  }
  private rebuild(data: CityData, reframe: boolean) {
    const started = performance.now(); this.clear()
    const positions = new Map(data.layout.map(p => [p.id, p])), nodes = new Map(data.nodes.map(n => [n.id, n])), heroIds = new Set<string>()
    for (const label of known.keys()) {
      const candidates = data.nodes.filter(n => n.label.toLowerCase() === label && landmarkStyle(n)).sort((a, b) => Number(b.status === 'anchor') - Number(a.status === 'anchor') || (b.evidence?.length ?? 0) - (a.evidence?.length ?? 0) || a.id.localeCompare(b.id))
      if (candidates[0]) heroIds.add(candidates[0].id)
    }
    const attention = new Map(data.attention?.map(item => [item.node, item]) ?? [])
    const input = data.nodes.flatMap(originalNode => {
      const node = { ...originalNode, attentionScore: attention.get(originalNode.id)?.score }, p = positions.get(node.id)
      return p ? [{ node, x: p.x * SCALE, z: p.y * SCALE, zone: p.zone, style: heroIds.has(node.id) ? landmarkStyle(node) : undefined }] : []
    })
    const communities = data.keywordGraph ? {
      focus: !!data.attention?.length, memberships: data.memberships ?? [],
      topics: (data.topics ?? []).flatMap(node => { const p = positions.get(node.id); return p ? [{ ...node, x: p.x * SCALE, z: p.y * SCALE }] : [] })
    } : undefined
    const plan = planCity(input, data.edges, communities), parcels = new Map(plan.parcels.map(p => [p.id, p]))
    this.bounds.makeEmpty()
    for (const parcel of plan.parcels) for (const p of parcel.polygon) this.bounds.expandByPoint(new THREE.Vector3(p.x, 0, p.z))
    if (this.bounds.isEmpty()) this.bounds.set(new THREE.Vector3(-12, 0, -12), new THREE.Vector3(12, 1, 12))
    for (const [id, p] of plan.positions) { const node = nodes.get(id); if (node) this.byId.set(id, { node, x: p.x, z: p.z, h: 1, w: .8, parcelId: '' }) }
    this.terrain(plan); this.roads(plan)
    for (const placement of plan.placements) {
      const node = nodes.get(placement.id); if (!node) continue
      const parcel = parcels.get(placement.parcelId)!, h = this.building(placement, node)
      const lot: VisualLot = { node, x: placement.x, z: placement.z, h, w: placement.footprint, style: heroIds.has(node.id) ? landmarkStyle(node) : undefined, parcelId: placement.parcelId }
      this.lots.push(lot); this.byId.set(node.id, lot); this.blockMembers.set(node.id, parcel.members.map(l => l.node.id))
    }
    const represented = new Map(this.lots.map(l => [`${l.x},${l.z}`, l]))
    for (const lot of this.byId.values()) {
      if (lot.parcelId) continue
      const building = represented.get(`${lot.x},${lot.z}`)
      if (building) { lot.h = building.h; lot.w = building.w; lot.parcelId = building.parcelId }
    }
    this.merge(this.driveways, this.material('#c6c2ae')); this.driveways = []
    this.landscape(plan)
    for (const [asset, placements] of this.assetQueue) for (const mesh of this.assets!.instantiate(asset, placements)) { this.city.add(mesh); if (mesh.userData.ids.some((id: string | null) => id)) { this.pickables.push(mesh); this.instanceIds.set(mesh, mesh.userData.ids) } }
    this.contactShadows()
    this.labels = plan.parcels.flatMap(parcel => {
      const members = parcel.members.map(l => nodes.get(l.node.id)!).filter(Boolean)
      const hero = this.lots.find(l => l.parcelId === parcel.id && l.style)
      const rank = (node: Node) => node.nodeType === 'topic' ? 0 : ['concept', 'entity', 'project'].includes(node.nodeType) ? 1 : 2
      const representative = hero?.node ?? [...members].sort((a, b) => rank(a) - rank(b) || Number(a.label.length > 24) - Number(b.label.length > 24) || (b.evidence?.length ?? 0) - (a.evidence?.length ?? 0) || a.id.localeCompare(b.id))[0]
      if (!representative) return []
      const focusLabel = focusDistrictLabel(members, attention)
      const kind = parcel.kind === 'campus' ? '项目园区' : parcel.kind === 'park' ? '探索营地' : parcel.kind === 'growth' ? data.keywordGraph ? '探索地块（尚无社区）' : '材料街区' : '知识街区'
      return [{ node: representative, x: hero?.x ?? parcel.center.x, z: hero?.z ?? parcel.center.z, h: hero?.h ?? .3, w: 1, style: hero?.style, parcelId: parcel.id, district: { name: focusLabel ? (parcel.unassigned ? '待连接：' : '') + focusLabel.name : parcel.name ?? representative.label, contextName: focusLabel && parcel.topicId ? parcel.name : undefined, attentionCategory: focusLabel?.category, count: parcel.members.length, kind, topicId: parcel.topicId, unassigned: parcel.unassigned } }]
    })
    const center = this.bounds.getCenter(new THREE.Vector3()), size = this.bounds.getSize(new THREE.Vector3()), span = Math.max(size.x, size.z) * .7 + 12
    const lightDistance = Math.max(100, span * 2)
    this.sun.position.set(center.x - lightDistance * .5, lightDistance * .95, center.z + lightDistance * .35); this.sun.shadow.camera.far = Math.max(350, lightDistance + span * 3); this.sun.target.position.copy(center); this.sun.shadow.camera.left = this.sun.shadow.camera.bottom = -span; this.sun.shadow.camera.right = this.sun.shadow.camera.top = span; this.sun.shadow.camera.updateProjectionMatrix()
    this.canvas.dataset.planningMs = (performance.now() - started).toFixed(1); this.canvas.dataset.parcels = String(plan.parcels.length); this.canvas.dataset.roads = String(plan.roads.length); this.canvas.dataset.models = String([...this.assetQueue.values()].reduce((n, a) => n + a.length, 0))
    this.setSelected(this.selected, this.changed); if (reframe) this.fit(); else this.schedule()
  }
  private terrain(plan: CityPlan) {
    const bounds = this.bounds, center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3())
    const perimeter = hull(plan.parcels.flatMap(p => p.polygon))
    const outer = (perimeter.length > 2 ? perimeter : [{ x: -12, z: -12 }, { x: 12, z: -12 }, { x: 12, z: 12 }, { x: -12, z: 12 }]).map(p => {
      const dx = p.x - center.x, dz = p.z - center.z, d = Math.hypot(dx, dz) || 1
      return new THREE.Vector3(p.x + dx / d * 4.5, 0, p.z + dz / d * 4.5)
    })
    const curve = new THREE.CatmullRomCurve3(outer, true, 'centripetal'), coast = curve.getPoints(160).map(p => ({ x: p.x, z: p.z }))
    const shape = new THREE.Shape(coast.map(p => new THREE.Vector2(p.x, -p.z)))
    const cliff = new THREE.ExtrudeGeometry(shape, { depth: 1.6, bevelEnabled: true, bevelSegments: 2, bevelSize: .6, bevelThickness: .25, steps: 1 }); cliff.rotateX(-Math.PI / 2); cliff.translate(0, -1.95, 0)
    this.mesh(cliff, this.material('#b6b099'))
    this.ground = this.mesh(polygonGeometry(coast, .09), this.material('#d8caaa'))
    const lawn = coast.map(p => ({ x: center.x + (p.x - center.x) * .985, z: center.z + (p.z - center.z) * .985 }))
    this.mesh(polygonGeometry(lawn, .12), this.material('#c4d39a', this.grass))
    const groups = new Map<string, THREE.BufferGeometry[]>()
    for (const p of plan.parcels) {
      const color = p.kind === 'growth' ? '#c6b68d' : p.kind === 'campus' ? '#d6d8bb' : p.kind === 'park' ? '#b1c887' : '#c5d298'
      if (!groups.has(color)) groups.set(color, [])
      groups.get(color)!.push(polygonGeometry(p.polygon, .145))
    }
    for (const [color, geometries] of groups) this.merge(geometries, this.material(color, this.grass))
    let waterMaterial = this.materials.get('water') as THREE.MeshStandardMaterial | undefined
    if (!waterMaterial) { waterMaterial = new THREE.MeshStandardMaterial({ roughness: .32, metalness: .08 }); this.materials.set('water', waterMaterial) }
    waterMaterial.color.set(this.dark ? '#244a54' : '#75bfc1'); this.water = this.mesh(new THREE.PlaneGeometry(2000, 2000), waterMaterial); this.water.rotation.x = -Math.PI / 2; this.water.position.y = -1.3
    const rocks: { x: number; z: number; radius: number }[] = []
    for (let i = 0; i < 145; i++) { const p = curve.getPoint(i / 145), toward = new THREE.Vector3(center.x - p.x, 0, center.z - p.z).normalize(); rocks.push({ x: p.x + toward.x * .5, z: p.z + toward.z * .5, radius: .25 + seed(`coast:${i}`) * .4 }) }
    for (const [i, p] of rocks.entries()) this.addAsset(i % 4 ? 'nature/rock_smallB' : 'nature/rock_largeA', p.x, p.z, p.radius, seed(`rock:${i}`) * 6, undefined, -.05)
    const surf = coast.map(p => ({ x: center.x + (p.x - center.x) * 1.017, z: center.z + (p.z - center.z) * 1.017 }))
    this.mesh(ribbon(surf, .2, -1.24), this.material('#b9d9cf'))
    this.bounds.expandByVector(new THREE.Vector3(3, 0, 3)); this.bounds.max.y = Math.max(12, size.y)
  }
  private roads(plan: CityPlan) {
    const shoulders: THREE.BufferGeometry[] = [], pavement: THREE.BufferGeometry[] = [], paths: THREE.BufferGeometry[] = [], marks: THREE.BufferGeometry[] = []
    const junctions = new Map<string, { p: CityPoint; width: number; paved: boolean }>()
    for (const road of plan.roads) {
      const paved = road.traffic > .2
      shoulders.push(ribbon(road.points, road.width + .42, .18)); (paved ? pavement : paths).push(ribbon(road.points, road.width, .205))
      for (const p of [road.points[0], road.points.at(-1)!]) { const key = `${p.x},${p.z}`, old = junctions.get(key); if (!old || old.width < road.width) junctions.set(key, { p, width: road.width, paved }) }
      if (road.width > 1.15) for (let i = 1; i < road.points.length; i++) {
        const a = road.points[i - 1], b = road.points[i], length = Math.hypot(b.x - a.x, b.z - a.z), dx = (b.x - a.x) / length, dz = (b.z - a.z) / length
        for (let at = .55; at < length - .5; at += 1.1) marks.push(ribbon([{ x: a.x + dx * at, z: a.z + dz * at }, { x: a.x + dx * Math.min(at + .5, length - .4), z: a.z + dz * Math.min(at + .5, length - .4) }], .045, .216))
      }
    }
    for (const { p, width, paved } of junctions.values()) {
      for (const [target, radius, y] of [[shoulders, width / 2 + .21, .18], [paved ? pavement : paths, width / 2, .206]] as [THREE.BufferGeometry[], number, number][]) {
        const g = new THREE.CircleGeometry(radius, 12); g.rotateX(-Math.PI / 2); g.translate(p.x, y, p.z); g.deleteAttribute('uv'); target.push(g)
      }
    }
    this.merge(shoulders, this.material('#e5dfc8')); this.merge(pavement, this.material('#6e7776')); this.merge(paths, this.material('#bea783')); this.merge(marks, this.material('#e8dfbd'))
  }
  private building(p: CityPlacement, node: Node) {
    const v = seed(node.id), r = p.footprint
    if (p.kind === 'campus') {
      const plaza = new THREE.CircleGeometry(r * .99, 48); plaza.rotateX(-Math.PI / 2); plaza.translate(p.x, .185, p.z); this.mesh(plaza, this.material('#d7d8cb', this.paving))
      let height = 0
      const models: CityAssetId[] = node.label.toLowerCase() === 'hemory' ? [commercial[5], commercial[6], commercial[2], commercial[0]] : [commercial[6], commercial[5], commercial[3], commercial[1]]
      const offsets = [[-.43, -.36, .25], [.35, -.27, .28], [-.35, .4, .24], [.4, .39, .23]]
      offsets.forEach(([dx, dz, radius], i) => { height = Math.max(height, this.addAsset(models[i], p.x + dx * r, p.z + dz * r, radius * r, i % 2 ? Math.PI : 0, node.id)) })
      const pool = new THREE.CylinderGeometry(r * .13, r * .13, .13, 32); pool.translate(p.x, .27, p.z); this.mesh(pool, this.material('#729fa5'))
      const benches: Primitive[] = [], lamps: Primitive[] = []
      for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2, x = p.x + Math.cos(a) * r * .87, z = p.z + Math.sin(a) * r * .87; this.addAsset(trees[i % 2], x, z, .42, a); if (i % 2) benches.push({ p: [p.x + Math.cos(a) * r * .33, .43, p.z + Math.sin(a) * r * .33], s: [.8, .17, .25], ry: -a }); lamps.push({ p: [x, .7, z], s: [.035, 1.05, .035] }) }
      this.batch(new THREE.BoxGeometry(1, 1, 1), '#998069', benches); this.batch(new THREE.CylinderGeometry(1, 1, 1, 5), '#566866', lamps)
      return height
    }
    if (p.kind === 'camp') {
      const clearing = new THREE.CircleGeometry(r * .6, 48); clearing.rotateX(-Math.PI / 2); clearing.translate(p.x, .165, p.z); this.mesh(clearing, this.material('#d5c6a0', this.grass))
      for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2 + .3, radius = r * .4; this.addAsset(tents[i % tents.length], p.x + Math.cos(a) * radius, p.z + Math.sin(a) * radius, r * .17, Math.PI / 2 - a, node.id) }
      for (let i = 0; i < 18; i++) {
        const a = i / 18 * Math.PI * 2, distance = r * (.77 + seed(`${node.id}:forest:${i}`) * .08)
        this.addAsset(trees[i % trees.length], p.x + Math.cos(a) * distance, p.z + Math.sin(a) * distance, r * (.055 + seed(`${node.id}:canopy:${i}`) * .025), a)
      }
      this.addAsset('nature/campfire_logs', p.x, p.z, r * .085); this.addAsset('nature/log_stack', p.x + r * .15, p.z + r * .13, r * .08, .4)
      return r * .38
    }
    const model = p.kind === 'construction' ? (v < .3 ? 'survival/structure' : houses[Math.floor(v * houses.length)]) : p.kind === 'midrise' ? commercial[Math.floor(v * 5)] : houses[Math.floor(v * houses.length)]
    const height = this.addAsset(model, p.x, p.z, r * .97, p.rotation, node.id)
    const dx = Math.sin(p.rotation), dz = Math.cos(p.rotation), driveway = new THREE.PlaneGeometry(r * .5, r * .8); driveway.rotateX(-Math.PI / 2); driveway.rotateY(p.rotation); driveway.translate(p.x + dx * r * .65, .177, p.z + dz * r * .65); this.driveways.push(driveway)
    if (p.kind === 'construction') this.addAsset(v < .5 ? 'survival/resource-wood' : 'survival/box', p.x - dx * r * .66, p.z - dz * r * .66, r * .14, p.rotation)
    else this.addAsset('suburban/planter', p.x + dz * r * .6, p.z - dx * r * .6, r * .16, p.rotation)
    return height
  }
  private landscape(plan: CityPlan) {
    const lamps: Primitive[] = [], heads: Primitive[] = [], benches: Primitive[] = [], planters: Primitive[] = []
    const safe = (p: CityPoint, radius: number) => !plan.placements.some(l => Math.hypot(p.x - l.x, p.z - l.z) < l.footprint + radius + .25) && !plan.roads.some(r => r.points.slice(1).some((b, i) => segmentDistance(p, r.points[i], b) < r.width / 2 + radius + .3))
    for (const parcel of plan.parcels) {
      const xs = parcel.polygon.map(p => p.x), zs = parcel.polygon.map(p => p.z), minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs)
      const count = parcel.kind === 'park' ? 150 : parcel.kind === 'campus' ? 70 : parcel.kind === 'growth' ? 7 : 18
      for (let i = 0; i < count; i++) {
        const x = minX + seed(`${parcel.id}:${i}:x`) * (maxX - minX), z = minZ + seed(`${parcel.id}:${i}:z`) * (maxZ - minZ), p = { x, z }, radius = .35 + seed(`${parcel.id}:${i}:r`) * .42
        if (!inPolygon(p, parcel.polygon) || !safe(p, radius)) continue
        const type = parcel.kind === 'park' ? 2 + i % 2 : i % trees.length
        this.addAsset(trees[type], x, z, radius, seed(`${parcel.id}:${i}:turn`) * 6)
        if (i % 3 === 0) this.addAsset('nature/plant_bushDetailed', x + radius * .5, z + radius * .3, .22, i)
      }
    }
    for (const road of plan.roads) {
      const a = road.points[0], b = road.points.at(-1)!, length = Math.hypot(b.x - a.x, b.z - a.z), dx = (b.x - a.x) / length, dz = (b.z - a.z) / length
      if (length < 4 || road.width < 1) continue
      for (let distance = 2; distance < length - 1; distance += 6) {
        const side = seed(`${road.id}:${distance}`) > .5 ? 1 : -1, offset = side * (road.width / 2 + .42), x = a.x + dx * distance - dz * offset, z = a.z + dz * distance + dx * offset
        lamps.push({ p: [x, .84, z], s: [.025, 1.3, .025] }); heads.push({ p: [x, 1.5, z], s: [.18, .08, .13], ry: Math.atan2(dx, dz) })
        if (distance === 2 && seed(road.id) > .62) { benches.push({ p: [x - dz * .25, .4, z + dx * .25], s: [.65, .13, .23], ry: Math.atan2(dx, dz) }); planters.push({ p: [x + dx * .8, .3, z + dz * .8], s: [.3, .24, .3] }) }
      }
    }
    this.batch(new THREE.CylinderGeometry(1, 1, 1, 6), '#52615e', lamps); this.batch(new THREE.BoxGeometry(1, 1, 1), '#e4dfb7', heads); this.batch(new THREE.BoxGeometry(1, 1, 1), '#9e7e57', benches); this.batch(new THREE.BoxGeometry(1, 1, 1), '#8b9d65', planters)
  }
  private contactShadows() {
    if (!this.contact.length) return
    let material = this.materials.get('contact')
    if (!material) { material = new THREE.MeshBasicMaterial({ map: this.contactMap, transparent: true, depthWrite: false, opacity: .5 }); this.materials.set('contact', material) }
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, this.contact.length), dummy = new THREE.Object3D()
    this.contact.forEach((p, i) => { dummy.position.fromArray(p.p); dummy.rotation.set(-Math.PI / 2, 0, 0); dummy.scale.fromArray(p.s); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix) }); mesh.computeBoundingSphere(); this.city.add(mesh)
  }
  setSelected(id: string, changed: Set<string>) {
    this.selected = id; this.changed = changed; this.clearGroup(this.markers)
    const marked = this.lots.filter(l => changed.has(l.node.id) || this.blockMembers.get(l.node.id)?.some(id => changed.has(id)))
    if (marked.length) {
      const rings = marked.map(l => { const g = new THREE.RingGeometry(l.w, l.w + .13, 32); g.rotateX(-Math.PI / 2); g.translate(l.x, .24, l.z); return g })
      const geometry = mergeGeometries(rings); rings.forEach(g => g.dispose())
      if (geometry) this.markers.add(new THREE.Mesh(geometry, this.material('#dba751')))
    }
    const lot = this.byId.get(id)
    if (lot) { const radius = Math.max(.8, lot.w), ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius + .12, 48), this.material('#eabc65')); ring.rotation.x = -Math.PI / 2; ring.position.set(lot.x, .25, lot.z); this.markers.add(ring) }
    this.schedule()
  }
  setDark(value: boolean) {
    this.dark = value; this.renderer.setClearColor(value ? '#172e35' : '#acd2d1', 1); this.renderer.toneMappingExposure = value ? .8 : 1.05; this.sun.intensity = value ? 1.5 : 2.4; this.hemisphere.intensity = value ? 1.3 : 1.7
    if (this.water) (this.water.material as THREE.MeshStandardMaterial).color.set(value ? '#244a54' : '#75bfc1')
    this.schedule()
  }
  resize(width: number, height: number) { this.width = width; this.height = height; this.renderer.setSize(width, height, false); const half = (this.camera.top - this.camera.bottom) / 2; this.camera.left = -half * width / height; this.camera.right = half * width / height; this.camera.updateProjectionMatrix(); if (this.lots.length && this.camera.zoom === 1) this.fit(); else this.schedule() }
  fit() {
    const center = this.bounds.getCenter(new THREE.Vector3()), size = this.bounds.getSize(new THREE.Vector3()), span = Math.max(30, size.x, size.z)
    this.camera.far = Math.max(700, span * 6);
    this.controls.target.set(center.x, 0, center.z); this.camera.position.set(center.x + span * .78, span * .85, center.z + span * .98); this.camera.zoom = 1; this.controls.update()
    this.camera.updateMatrixWorld(true)
    const viewBounds = new THREE.Box3()
    for (const x of [this.bounds.min.x, this.bounds.max.x]) for (const y of [0, this.bounds.max.y]) for (const z of [this.bounds.min.z, this.bounds.max.z]) viewBounds.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(this.camera.matrixWorldInverse))
    const half = Math.max(12, Math.abs(viewBounds.min.y), Math.abs(viewBounds.max.y), Math.abs(viewBounds.min.x) * this.height / this.width, Math.abs(viewBounds.max.x) * this.height / this.width) * 1.04
    this.camera.top = half; this.camera.bottom = -half; this.camera.left = -half * this.width / this.height; this.camera.right = half * this.width / this.height; this.camera.updateProjectionMatrix(); this.schedule()
  }
  zoom(factor: number) { this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * factor, .45, 18); this.camera.updateProjectionMatrix(); this.schedule() }
  rotate() { const offset = this.camera.position.clone().sub(this.controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4); this.camera.position.copy(this.controls.target).add(offset); this.controls.update(); this.schedule() }
  focus(id: string) { const l = this.byId.get(id); if (!l) return; const offset = this.camera.position.clone().sub(this.controls.target); this.controls.target.set(l.x, l.h * .25, l.z); this.camera.position.copy(this.controls.target).add(offset); this.camera.zoom = Math.max(this.camera.zoom, l.w > 4 ? 3 : 5); this.camera.updateProjectionMatrix(); this.controls.update(); this.schedule() }
  private down = (e: PointerEvent) => { this.pointerDown = { x: e.clientX, y: e.clientY } }
  private up = (e: PointerEvent) => { if (e.button === 0 && this.pointerDown && Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y) < 4) { const id = this.pick(e); if (id) this.select(id) } this.pointerDown = null }
  private pick(e: PointerEvent) { const rect = this.canvas.getBoundingClientRect(); this.mouse.set((e.clientX - rect.left) / this.width * 2 - 1, -(e.clientY - rect.top) / this.height * 2 + 1); this.ray.setFromCamera(this.mouse, this.camera); const hit = this.ray.intersectObjects(this.pickables, false)[0]; return hit && hit.instanceId !== undefined ? this.instanceIds.get(hit.object)?.[hit.instanceId] : undefined }
  private hover = (e: PointerEvent) => { if (this.pointerDown || performance.now() - this.lastHover < 130) return; this.lastHover = performance.now(); const id = this.pick(e), lot = id ? this.byId.get(id) : undefined; this.canvas.style.cursor = lot ? 'pointer' : 'grab'; if (lot) { const r = this.canvas.getBoundingClientRect(); this.emit({ name: lot.node.label + (this.blockMembers.has(lot.node.id) ? ` · 街区含 ${this.blockMembers.get(lot.node.id)!.length} ${this.latest?.keywordGraph ? '个关键词' : '个对象'}` : ''), kind: lot.node.nodeType, x: e.clientX - r.left, y: e.clientY - r.top }) } else this.emit() }
  private leave = () => this.emit()
  private emit(hover?: SceneStatus['hover']) {
    const candidates = [...this.labels], selected = this.byId.get(this.selected)
    if (selected && !candidates.some(l => l.node.id === selected.node.id)) candidates.unshift(selected)
    const rects: { x: number; y: number; w: number; h: number }[] = [], labels: Label[] = []
    for (const l of candidates.sort((a, b) => Number(b.node.id === this.selected) - Number(a.node.id === this.selected) || Number(!!b.style) - Number(!!a.style) || a.parcelId.localeCompare(b.parcelId))) {
      const p = new THREE.Vector3(l.x, l.h + .6, l.z).project(this.camera), x = (p.x + 1) * this.width / 2, y = (1 - p.y) * this.height / 2
      if (x < 12 || x > this.width - 12 || y < 22 || y > this.height - 50 || p.z < -1 || p.z > 1) continue
      const prominent = !!l.style || l.node.id === this.selected
      const width = prominent ? Math.min(185, (l.district?.name ?? l.node.label).length * 10 + 28) : Math.min(this.camera.zoom > 1.5 ? 132 : 82, (l.district?.name ?? l.node.label).length * 9 + 30)
      const height = prominent ? 29 : 19
      const overlaps = rects.some(r => Math.abs(x - r.x) < (width + r.w) / 2 + 3 && Math.abs(y - height / 2 - r.y) < (height + r.h) / 2 + 3)
      // Every on-screen parcel retains its marker; only its text folds when crowded.
      const compact = !prominent && overlaps
      rects.push({ x, y: y - height / 2, w: compact ? 12 : width, h: compact ? 12 : height })
      labels.push({ id: l.district ? l.parcelId : l.node.id, nodeId: l.node.id, attentionCategory: l.district?.attentionCategory ?? this.latest?.attention?.find(item => item.node === l.node.id)?.category, name: l.district?.name ?? l.node.label, x, y, kind: l.node.nodeType, selected: l.node.id === this.selected, district: l.district, compact, width })
    }
    this.canvas.dataset.districtLabels = String(labels.filter(l => l.district).length)
    this.status({ labels, count: this.total, rendered: this.lots.length, aggregated: this.total > this.lots.length, zoom: this.camera.zoom, loading: this.loading, error: this.error || undefined, hover })
  }
  private schedule = () => { if (this.disposed) return; cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(() => { const start = performance.now(); this.renderer.render(this.scene, this.camera); Object.assign(this.canvas.dataset, { ready: String(!this.loading && !this.error), drawCalls: String(this.renderer.info.render.calls), triangles: String(this.renderer.info.render.triangles), geometries: String(this.renderer.info.memory.geometries), textures: String(this.renderer.info.memory.textures), renderMs: (performance.now() - start).toFixed(1) }); this.emit() }) }
  dispose() { this.disposed = true; cancelAnimationFrame(this.frame); this.controls.dispose(); this.clear(); this.assets?.dispose(); for (const m of this.materials.values()) m.dispose(); for (const t of this.textures) t.dispose(); this.sun.shadow.map?.dispose(); const gl = this.renderer.getContext(); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); this.renderer.dispose(); this.canvas.removeEventListener('pointerdown', this.down); this.canvas.removeEventListener('pointerup', this.up); this.canvas.removeEventListener('pointermove', this.hover); this.canvas.removeEventListener('pointerleave', this.leave); this.canvas.removeEventListener('contextmenu', this.contextMenu) }
}
