import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { cityNodes } from './domain'
import { districtCenter, overviewBlocks, overviewBuildings, streetPlan, visualPoint, type StreetSegment } from './city-projection'
import type { Edge, Layout, Node } from './types'

const SCALE = .052
const known = new Map([['hemory', 'campus'], ['note.md', 'campus'], ['bushcraft', 'camp']])
export function landmarkStyle(node: Node) {
  return (node.status === 'anchor' || node.status === 'observed') ? known.get(node.label.toLowerCase()) : undefined
}
function seed(text: string) { let n = 2166136261; for (const c of text) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return (n >>> 0) / 4294967296 }
interface Lot { node: Node; x: number; z: number; h: number; w: number; zone: string; style?: string; growing?: boolean }
export interface CityData { nodes: Node[]; layout: Layout[]; edges: Edge[] }
export interface Label { id: string; name: string; x: number; y: number; kind: string; selected: boolean }
export interface SceneStatus { labels: Label[]; count: number; rendered?: number; aggregated?: boolean; zoom?: number; hover?: { name: string; kind: string; x: number; y: number } }
const palette = { road: '#687777', path: '#d8c49b' }

export class CityScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-60, 60, 45, -45, .1, 700)
  private controls: OrbitControls
  private city = new THREE.Group()
  private lots: Lot[] = []
  private total = 0
  private rawLots = new Map<string, Lot>()
  private changeMarkers: THREE.InstancedMesh | null = null
  private blockMembers = new Map<string, string[]>()
  private byId = new Map<string, Lot>()
  private pickables: THREE.InstancedMesh[] = []
  private instanceIds = new Map<THREE.Object3D, string[]>()
  private materials = new Map<string, THREE.MeshStandardMaterial>()
  private selected = ''
  private changed = new Set<string>()
  private ring: THREE.Mesh | null = null
  private selectedGlyph: THREE.InstancedMesh | null = null
  private renderedIds = new Set<string>()
  private labels: Lot[] = []
  private bounds = new THREE.Box3()
  private frame = 0
  private width = 1
  private height = 1
  private dark = false
  private disposed = false
  private hasData = false
  private pointerDown: { x: number; y: number } | null = null
  private lastHover = 0
  private ray = new THREE.Raycaster()
  private mouse = new THREE.Vector2()
  private sun: THREE.DirectionalLight
  private water: THREE.Mesh | null = null
  private ground: THREE.Mesh | null = null
  constructor(private canvas: HTMLCanvasElement, private status: (value: SceneStatus) => void, private select: (id: string) => void) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.1
    this.camera.position.set(95, 92, 116)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = false
    this.controls.minPolarAngle = .35
    this.controls.maxPolarAngle = 1.22
    this.controls.minZoom = .35
    this.controls.maxZoom = 16
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
    this.controls.addEventListener('change', this.cameraChanged)
    this.scene.add(new THREE.HemisphereLight(0xe8f1ee, 0x8c8a6a, 1.5))
    this.sun = new THREE.DirectionalLight(0xffedcd, 2.6)
    this.sun.position.set(-35, 75, 30)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.camera.left = this.sun.shadow.camera.bottom = -65
    this.sun.shadow.camera.right = this.sun.shadow.camera.top = 65
    this.sun.shadow.camera.near = .1; this.sun.shadow.camera.far = 220
    this.sun.shadow.bias = -.0006; this.sun.shadow.normalBias = .025
    this.scene.add(this.sun, this.sun.target, this.city)
    canvas.addEventListener('pointerdown', this.down)
    canvas.addEventListener('pointerup', this.up)
    canvas.addEventListener('pointermove', this.hover)
    canvas.addEventListener('pointerleave', this.leave)
    canvas.addEventListener('contextmenu', this.contextMenu)
  }
  private contextMenu = (e: Event) => e.preventDefault()
  private material(color: string, roughness = .86) {
    const key = `${color}:${roughness}`
    if (!this.materials.has(key)) this.materials.set(key, new THREE.MeshStandardMaterial({ color, roughness, flatShading: true }))
    return this.materials.get(key)!
  }
  private mesh(geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number) {
    const mesh = new THREE.Mesh(geometry, this.material(color)); mesh.position.set(x, y, z)
    mesh.castShadow = true; mesh.receiveShadow = true; this.city.add(mesh); return mesh
  }
  private batch(geometry: THREE.BufferGeometry, color: string, entries: { p: number[]; s: number[]; ry?: number; id?: string; color?: string }[], selectable = false) {
    if (!entries.length) { geometry.dispose(); return }
    const mesh = new THREE.InstancedMesh(geometry, this.material(color), entries.length)
    const dummy = new THREE.Object3D()
    const hasColors = entries.some(entry => !!entry.color)
    entries.forEach((entry, i) => {
      dummy.position.set(entry.p[0], entry.p[1], entry.p[2]); dummy.scale.set(entry.s[0], entry.s[1], entry.s[2]); dummy.rotation.set(0, entry.ry ?? 0, 0); dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
      if (hasColors) mesh.setColorAt(i, new THREE.Color(entry.color ?? color))
    })
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere(); this.city.add(mesh)
    if (selectable) { this.pickables.push(mesh); this.instanceIds.set(mesh, entries.map(e => e.id ?? '')) }
  }
  private streetStrip(street: StreetSegment, width: number, y: number, color: string) {
    const [a, bend, b] = street.points
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(a[0], y, a[1]), new THREE.Vector3(bend[0], y, bend[1]), new THREE.Vector3(b[0], y, b[1]))
    const points = curve.getPoints(12), vertices: number[] = [], indices: number[] = []
    points.forEach((point, i) => {
      const before = points[Math.max(0, i - 1)], after = points[Math.min(points.length - 1, i + 1)]
      const dx = after.x - before.x, dz = after.z - before.z, length = Math.hypot(dx, dz) || 1
      const sideX = -dz / length * width / 2, sideZ = dx / length * width / 2
      vertices.push(point.x + sideX, y, point.z + sideZ, point.x - sideX, y, point.z - sideZ)
      if (i) { const n = i * 2; indices.push(n - 2, n, n - 1, n - 1, n, n + 1) }
    })
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setIndex(indices); geometry.computeVertexNormals()
    const mesh = new THREE.Mesh(geometry, this.material(color)); mesh.receiveShadow = true; this.city.add(mesh)
  }
  private gableRoof() {
    const lf=[-1,-.5,1], lb=[-1,-.5,-1], rf=[1,-.5,1], rb=[1,-.5,-1], front=[0,.5,1], back=[0,.5,-1]
    const triangles=[lf,front,back, lf,back,lb, rf,rb,back, rf,back,front, lf,rf,front, lb,back,rb]
    const geometry=new THREE.BufferGeometry()
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(triangles.flat(),3));geometry.computeVertexNormals()
    return geometry
  }
  private streets(streets: StreetSegment[]) {
    for (const street of streets) {
      if (street.traffic) {
        this.streetStrip(street, street.width + .23, .145, this.dark ? '#9ba99c' : '#c9c5af')
        this.streetStrip(street, street.width, .153, this.dark ? '#526569' : palette.road)
        if (street.traffic > 4) this.streetStrip(street, .035, .159, this.dark ? '#b7ab82' : '#e9d8a8')
      } else {
        this.streetStrip(street, street.width + .16, .143, this.dark ? '#506852' : '#a9bd97')
        this.streetStrip(street, street.width, .15, this.dark ? '#aa9d79' : palette.path)
      }
    }
  }
  private river(center: THREE.Vector3, width: number, depth: number) {
    const left=center.x-width/2+.35, span=(width-.7)/6, coast=center.z+depth/2-2
    for(let i=0;i<6;i++) {
      const x0=left+i*span, x1=x0+span
      const z0=coast+Math.sin(i*.9)*.5, z1=coast+Math.sin((i+1)*.9)*.5
      const segment:StreetSegment={id:`river-${i}`,points:[[x0,z0],[(x0+x1)/2,(z0+z1)/2+Math.sin(i*1.7)*.5],[x1,z1]],width:2.6,traffic:0}
      this.streetStrip(segment,3.25,.111,this.dark?'#7a947f':'#dbcda8')
      this.streetStrip(segment,2.6,.121,this.dark?'#386977':'#69b5bd')
    }
    const rocks=[]
    for(let i=0;i<64;i++) {
      const x=left+seed(`river-rock-x-${i}`)*(width-.7), z=coast+(i%2?1.6:-1.6)+Math.sin((x-left)/span*.9)*.5
      const size=.18+seed(`river-rock-size-${i}`)*.34
      rocks.push({p:[x,.22,z],s:[size,size*.75,size*.7],ry:seed(`river-rock-turn-${i}`)*6,color:i%3?'#a9a99c':'#8d9d91'})
    }
    this.batch(new THREE.DodecahedronGeometry(1,0),'#a9a99c',rocks)
  }
  private clear() {
    this.city.traverse(object => { if(object instanceof THREE.InstancedMesh)object.dispose(); if (object instanceof THREE.Mesh) object.geometry.dispose() })
    this.city.clear(); this.pickables = []; this.instanceIds.clear(); this.ring = null; this.selectedGlyph = null; this.renderedIds.clear()
  }
  setData(data: CityData, reframe: boolean) {
    this.clear(); this.changeMarkers = null; this.blockMembers.clear()
    const positions = new Map(data.layout.map(p => [p.id, p]))
    const heroIds = new Set<string>()
    for (const label of known.keys()) {
      const candidates = data.nodes.filter(n=>n.label.toLowerCase()===label && landmarkStyle(n)).sort((a,b)=>Number(b.status==='anchor')-Number(a.status==='anchor')||(b.evidence?.length??0)-(a.evidence?.length??0)||a.id.localeCompare(b.id))
      if(candidates[0])heroIds.add(candidates[0].id)
    }
    const sourceLots: Lot[] = data.nodes.flatMap(node => {
      const p = positions.get(node.id); if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return []
      const variation = seed(node.id), style = heroIds.has(node.id) ? landmarkStyle(node) : undefined
      const h = style === 'campus' ? 5.5 : style === 'camp' ? 2 : node.nodeType === 'project' ? 1.25 + variation * 1.8 : node.nodeType === 'topic' ? .15 : node.nodeType === 'document' ? .12 + variation * .1 : .2 + variation * .44
      return [{ node, x: p.x * SCALE, z: p.y * SCALE, h, w: style ? 3.6 : node.nodeType === 'project' ? .28 : node.nodeType === 'topic' ? .48 : .13, zone:p.zone, style }]
    })
    const blocks = overviewBlocks(sourceLots)
    this.lots = sourceLots.map(lot => ({...lot, ...visualPoint(lot.x, lot.z)}))
    this.total = this.lots.length
    this.rawLots = new Map(this.lots.map(l => [l.node.id, l]))
    this.bounds.makeEmpty(); for (const lot of this.lots) this.bounds.expandByPoint(new THREE.Vector3(lot.x, lot.h, lot.z))
    if (this.bounds.isEmpty()) this.bounds.set(new THREE.Vector3(-12, 0, -12), new THREE.Vector3(12, 1, 12))
    const aggregated = data.nodes.length > 1200
    if (aggregated) {
      const heroes = this.lots.filter(l => l.style)
      const largestBlock = Math.max(1, ...blocks.map(block => block.members.length))
      this.lots = [...heroes, ...blocks.flatMap(block => overviewBuildings(block, largestBlock).map(({lot,x,z}) => {
        this.blockMembers.set(lot.node.id, block.members.map(l=>l.node.id))
        const v = seed(lot.node.id), established = lot.node.nodeType === 'project' && ['anchor','observed','confirmed','user-confirmed'].includes(lot.node.status)
        const growing = block.members.filter(member => member.zone === 'unassigned').length > block.members.length / 2
        return {...lot, ...visualPoint(x,z), growing, w:growing ? .45 + v * .22 : established ? .9 + v * .18 : .7 + v * .23,
          h:growing ? .28 + v * .4 : established ? 1.8 + v * 2.5 : .8 + v * 1.2}
      }))]
    }
    this.byId = new Map(this.lots.map(l => [l.node.id, l]))
    const size = this.bounds.getSize(new THREE.Vector3()), center = this.bounds.getCenter(new THREE.Vector3())
    const w = Math.max(24, size.x + 8), d = Math.max(24, size.z + 8)
    const shape = new THREE.Shape(), r = Math.min(4, w / 8, d / 8)
    shape.moveTo(-w/2+r, -d/2); shape.lineTo(w/2-r,-d/2); shape.quadraticCurveTo(w/2,-d/2,w/2,-d/2+r); shape.lineTo(w/2,d/2-r); shape.quadraticCurveTo(w/2,d/2,w/2-r,d/2); shape.lineTo(-w/2+r,d/2); shape.quadraticCurveTo(-w/2,d/2,-w/2,d/2-r); shape.lineTo(-w/2,-d/2+r); shape.quadraticCurveTo(-w/2,-d/2,-w/2+r,-d/2)
    const base = this.mesh(new THREE.ExtrudeGeometry(shape, { depth: 1.2, bevelEnabled: true, bevelSize: .22, bevelThickness: .22, bevelSegments: 2, steps: 1 }), '#c3b297', center.x, -1.35, center.z); base.rotation.x = -Math.PI / 2
    this.ground = this.mesh(new THREE.ShapeGeometry(shape), this.dark ? '#516956' : '#bdcba3', center.x, .09, center.z); this.ground.rotation.x = -Math.PI/2; this.ground.castShadow = false
    this.water = this.mesh(new THREE.PlaneGeometry(2000,2000), this.dark ? '#2c5054' : '#b8d9d5', center.x, -1.7, center.z); this.water.rotation.x = -Math.PI/2; this.water.castShadow = false
    const growingGround=blocks.filter(block=>block.members.filter(member=>member.zone==='unassigned').length>block.members.length/2).map(block=>{
      const c=districtCenter(block),p=visualPoint(c.x,c.z)
      return {p:[p.x,.106,p.z],s:[4.2,.025,4.1],ry:seed(`${block.x}:${block.z}:ground`)*6,color:'#d3c69e'}
    })
    this.batch(new THREE.CylinderGeometry(1,1,1,12),'#d3c69e',growingGround)
    this.river(center,w,d)
    // Pale paths complete the landscape; explicit links widen their routed street segments.
    const streets = streetPlan(blocks, data.edges, sourceLots).map(street => ({...street, points:street.points.map(([x,z]) => { const p=visualPoint(x,z); return [p.x,p.z] as [number,number] })}))
    const heroes=this.lots.filter(l=>l.style)
    const nearHero=(x:number,z:number,margin=0)=>heroes.some(h=>Math.abs(x-h.x)<(h.style==='camp'?8:4.5)+margin && Math.abs(z-h.z)<(h.style==='camp'?6.5:3.8)+margin)
    const inHero=(l:Lot)=>nearHero(l.x,l.z)
    const plots = blocks.map(b=>{
      const c=districtCenter(b), p=visualPoint(c.x,c.z), v=seed(`${b.x}/${b.z}`), density=Math.min(1,Math.log2(b.members.length+1)/9)
      const growing=b.members.filter(member=>member.zone==='unassigned').length>b.members.length/2
      return {p:[p.x,.115,p.z],s:[growing?1.8:1.85+v*.1,.045,growing?1.7:1.75+seed(`${b.x}:${b.z}:plot`)*.1],ry:v*6.28,color:growing?'#d9c99d':density>.55?'#d9d5b7':'#a9c29a'}
    }).filter(plot=>!nearHero(plot.p[0],plot.p[2],.5))
    this.batch(new THREE.CylinderGeometry(1,1,1,9), '#ffffff', plots)
    this.streets(streets)
    const bodies = [], roofs = [], houseRoofs = [], windows = [], doors = [], trees = [], trunks = []
    for (const lot of this.lots) {
      const {node,x,z,h,w,style} = lot, v = seed(node.id)
      if (style) { this.landmark(lot); this.renderedIds.add(node.id); continue }
      if(inHero(lot) && lot.node.id!==this.selected) continue
      this.renderedIds.add(node.id)
      const project = !lot.growing && node.nodeType === 'project' && ['anchor','observed','confirmed','user-confirmed'].includes(node.status), topic = node.nodeType === 'topic', document = node.nodeType === 'document'
      if(lot.growing) {
        bodies.push({p:[x,.16+h/2,z],s:[w,h,w*.86],id:node.id,color:['#b7a991','#d2bb95','#b9b9aa'][Math.floor(v*3)]})
        continue
      }
      bodies.push({p:[x,.16+h/2,z],s:[w,h,w*.86],id:node.id,color:project ? ['#76969a','#a8bcb7','#8a9c8c'][Math.floor(v*3)] : topic ? '#becfa5' : document ? '#ded6c0' : node.nodeType === 'project' ? '#a6bab0' : ['#f0e7d3','#d9ccb2','#d9c3a8','#b5c4ba'][Math.floor(v*4)]})
      if (!project && !topic) {
        houseRoofs.push({p:[x,.35+h,z],s:[w*.57,.4,w*.52],ry:v>.5?Math.PI/2:0,color:document ? '#a97b63' : ['#bd8c68','#c7956f','#a8876d'][Math.floor(v*3)]})
        windows.push({p:[x+w*.17,.18+Math.min(h*.62,.92),z+w*.44],s:[w*.26,.2,.025],color:'#9fb9b4'})
        windows.push({p:[x+w*.505,.18+Math.min(h*.61,.9),z],s:[.025,.2,w*.24],color:'#9fb9b4'})
        doors.push({p:[x-w*.24,.34,z+w*.445],s:[w*.18,.37,.028],color:'#8b7865'})
      }
      if (project) {
        roofs.push({p:[x,.19+h,z],s:[w*1.05,.055,w*.95],color:'#e9e7dc'})
        for(let y=.38;y<h;y+=.26) windows.push({p:[x,.16+y,z+w*.437],s:[w*.78,.055,.014]})
        bodies.push({p:[x+w*.72,.16+h*.19,z+w*.45],s:[w*.65,h*.38,w*.7],id:node.id,color:'#aabcb3'})
      }
      if (topic && v>.55) { trees.push({p:[x+.75,.76,z+.65],s:[.42,.96,.42],ry:v*6}); trunks.push({p:[x+.75,.3,z+.65],s:[.06,.35,.06]}) }
    }
    this.batch(new THREE.BoxGeometry(1,1,1),'#ffffff', bodies,true)
    this.batch(new THREE.BoxGeometry(1,1,1),'#ffffff', roofs)
    this.batch(this.gableRoof(),'#ffffff', houseRoofs)
    this.batch(new THREE.BoxGeometry(1,1,1),'#d5e4df', windows)
    this.batch(new THREE.BoxGeometry(1,1,1),'#8b7865', doors)
    for (const block of blocks) {
      const center=districtCenter(block), c=visualPoint(center.x,center.z), density=Math.min(1,Math.log2(block.members.length+1)/9)
      const growing=block.members.filter(member=>member.zone==='unassigned').length>block.members.length/2
      const count=growing?1:Math.round(4-density*2)
      for(let i=0;i<count;i++) {
        const angle=seed(`${block.x}:${block.z}:tree:${i}`)*Math.PI*2, radius=2.55+seed(`${i}:${block.x}:radius`)*.32
        const x=c.x+Math.cos(angle)*radius,z=c.z+Math.sin(angle)*radius
        if(nearHero(x,z))continue
        const height=.65+seed(`${block.x}:${block.z}:${i}:height`)*.65
        trees.push({p:[x,.35+height/2,z],s:[.28+height*.13,height,.28+height*.13],ry:angle,color:i%3?'#739b75':'#8aae78'})
        trunks.push({p:[x,.28,z],s:[.06,.34,.06]})
      }
    }
    // A planted perimeter makes the scene a single place, instead of a scatterplot.
    for (let i=0;i<130;i++) {
      const t=i/130*Math.PI*2, variation=seed(`tree-${i}`), x=center.x+Math.cos(t)*(w/2-1.2-variation*.8), z=center.z+Math.sin(t)*(d/2-1.2-variation*.8)
      trees.push({p:[x,.45+variation*.2,z],s:[.5,.7+variation*.4,.5],ry:variation*6})
      trunks.push({p:[x,.22,z],s:[.06,.32,.06]})
    }
    this.batch(new THREE.ConeGeometry(1,1,6),'#8baf85',trees)
    this.batch(new THREE.BoxGeometry(1,1,1),'#997e60',trunks)
    const reserved = this.lots.filter(l => l.style).sort((a,b)=>(b.node.evidence?.length??0)-(a.node.evidence?.length??0)).slice(0,3)
    const named = [...reserved,...cityNodes(this.lots.map(l=>l.node).filter(n=>!known.has(n.label.toLowerCase())),'',7).flatMap(n=>this.byId.has(n.id)?[this.byId.get(n.id)!]:[])]
    const seen = new Set<string>(); this.labels = named.filter(l=>!seen.has(l.node.id)&&!!seen.add(l.node.id)).slice(0,12)
    this.hasData = true
    this.setSelected(this.selected,this.changed)
    if (reframe) this.fit(); else this.schedule()
  }
  private landmark(lot: Lot) {
    const {x,z,node,style} = lot
    const camp=style==='camp'
    if(camp) {
      const grove=this.mesh(new THREE.CylinderGeometry(1,1,.06,28),'#91b17e',x,.145,z)
      grove.scale.set(8,1,6.6)
      const forest=[],forestTrunks=[]
      for(let i=0;i<66;i++) {
        const angle=seed(`${node.id}:forest-angle:${i}`)*Math.PI*2, radius=3.8+seed(`${node.id}:forest-radius:${i}`)*4
        const tx=x+Math.cos(angle)*radius,tz=z+Math.sin(angle)*radius*.82, height=1.05+seed(`${node.id}:forest-height:${i}`)*1.25
        forest.push({p:[tx,.4+height/2,tz],s:[.46+height*.16,height,.46+height*.16],ry:angle,color:i%4?'#587f66':'#769d71'})
        forestTrunks.push({p:[tx,.32,tz],s:[.08,.5,.08]})
      }
      this.batch(new THREE.ConeGeometry(1,1,7),'#6e9871',forest)
      this.batch(new THREE.BoxGeometry(1,1,1),'#997954',forestTrunks)
    }
    this.mesh(new THREE.BoxGeometry(9,.16,7.8),camp?'#a7be8f':'#e5dfcc',x,.23,z)
    this.mesh(new THREE.BoxGeometry(9.4,.08,8.2),'#eee6d1',x,.14,z)
    const trees=[],trunks=[]
    for(let i=0;i<16;i++) {
      const angle=i/16*Math.PI*2, tx=x+Math.cos(angle)*4.1,tz=z+Math.sin(angle)*3.4,h=.9+seed(`${node.id}:hero-tree-${i}`)*1.1
      trees.push({p:[tx,.5+h/2,tz],s:[.7,h,.7],ry:i});trunks.push({p:[tx,.4,tz],s:[.09,.5,.09]})
    }
    this.batch(new THREE.ConeGeometry(1,1,7),'#6e9871',trees)
    this.batch(new THREE.BoxGeometry(1,1,1),'#997954',trunks)
    if(camp) {
      const tents=[{p:[x-1.4,1.05,z-.3],s:[1.6,1.45,1.5],ry:.6,id:node.id},{p:[x+1.2,.9,z+.5],s:[1.3,1.15,1.6],ry:-.5,id:node.id},{p:[x-.6,.8,z+2],s:[1.1,.9,1.2],ry:.2,id:node.id}]
      this.batch(new THREE.ConeGeometry(1,1,4),'#cd955c',tents,true)
      const pond=this.mesh(new THREE.CircleGeometry(1.15,32),'#78b7b0',x+.7,.33,z-1.9);pond.rotation.x=-Math.PI/2;pond.scale.x=1.5
      this.mesh(new THREE.CylinderGeometry(.35,.4,.08,14),'#e7c78b',x-.1,.4,z+.5)
      this.batch(new THREE.BoxGeometry(1,1,1),'#a77f56',[{p:[x-.9,.55,z+.6],s:[.9,.15,.25]},{p:[x+.2,.55,z+1.3],s:[.25,.15,.9]}])
    } else {
      const warm=node.label.toLowerCase()==='note.md'
      const buildings=[
        {p:[x-2.15,2.05,z-1.7],s:[2.15,3.65,2.1],id:node.id},
        {p:[x+1.65,2.7,z-1.7],s:[2.35,4.95,2.05],id:node.id},
        {p:[x-2.05,1.55,z+1.8],s:[2.3,2.65,2],id:node.id},
        {p:[x+1.65,1.95,z+1.8],s:[2.25,3.45,2.1],id:node.id},
      ]
      this.batch(new THREE.BoxGeometry(1,1,1),warm?'#c6ac84':'#668d83',buildings,true)
      const stripes=[]
      for(const building of buildings) for(let y=.75;y<building.s[1];y+=.48) {
        stripes.push({p:[building.p[0],y,building.p[2]+building.s[2]/2+.012],s:[building.s[0]*.83,.14,.02]})
        stripes.push({p:[building.p[0]+building.s[0]/2+.012,y,building.p[2]],s:[.02,.14,building.s[2]*.83]})
      }
      this.batch(new THREE.BoxGeometry(1,1,1),warm?'#f0e5cb':'#b8d9d5',stripes)
      const roofs=buildings.map(t=>({p:[t.p[0],t.p[1]+t.s[1]/2+.08,t.p[2]],s:[t.s[0]*1.09,.15,t.s[2]*1.09]}))
      this.batch(new THREE.BoxGeometry(1,1,1),'#e9e5d3',roofs)
      this.mesh(new THREE.CylinderGeometry(.72,.72,.13,16),'#e8ddbf',x,.34,z)
      this.mesh(new THREE.CylinderGeometry(.52,.52,.025,16),'#83bfc1',x,.42,z)
      this.mesh(new THREE.BoxGeometry(1.15,.08,1.9),'#e7dfca',x,.24,z+2.45)
      this.batch(new THREE.BoxGeometry(1,1,1),'#c0a889',[{p:[x-1.1,.4,z+2.7],s:[.75,.2,.25]},{p:[x+1.05,.4,z+2.7],s:[.75,.2,.25]}])
    }
  }

  setSelected(id: string, changed: Set<string>) {
    this.selected=id;this.changed=changed
    if(this.changeMarkers){this.city.remove(this.changeMarkers);this.changeMarkers.geometry.dispose();this.changeMarkers.dispose();this.changeMarkers=null}
    const marked=this.lots.filter(l=>changed.has(l.node.id) || this.blockMembers.get(l.node.id)?.some(id=>changed.has(id)))
    if(marked.length){
      const markers=new THREE.InstancedMesh(new THREE.RingGeometry(.7,.85,20),this.material('#d79542'),marked.length),dummy=new THREE.Object3D()
      marked.forEach((l,i)=>{dummy.position.set(l.x,.28,l.z);dummy.rotation.x=-Math.PI/2;dummy.scale.setScalar(Math.max(1,l.w));dummy.updateMatrix();markers.setMatrixAt(i,dummy.matrix)})
      this.city.add(markers);this.changeMarkers=markers
    }
    if(this.ring){this.city.remove(this.ring);this.ring.geometry.dispose();this.ring=null}
    if(this.selectedGlyph){
      this.city.remove(this.selectedGlyph);this.pickables=this.pickables.filter(m=>m!==this.selectedGlyph);this.instanceIds.delete(this.selectedGlyph)
      this.selectedGlyph.geometry.dispose();this.selectedGlyph.dispose();this.selectedGlyph=null
    }
    const lot=this.byId.get(id) ?? this.rawLots.get(id)
    if(lot&&!this.renderedIds.has(id)){
      const glyph=new THREE.InstancedMesh(new THREE.BoxGeometry(.55,1.1,.55),this.material('#d4aa6c'),1)
      glyph.setMatrixAt(0,new THREE.Matrix4().makeTranslation(lot.x,.75,lot.z));glyph.computeBoundingSphere();glyph.castShadow=true
      this.city.add(glyph);this.pickables.push(glyph);this.instanceIds.set(glyph,[id]);this.selectedGlyph=glyph
    }
    if(lot){const radius=Math.max(.45,lot.w*1.2);this.ring=this.mesh(new THREE.RingGeometry(radius,radius+.09,48),'#de994e',lot.x,.26,lot.z);this.ring.rotation.x=-Math.PI/2;this.ring.castShadow=false}
    this.schedule()
  }
  setDark(value: boolean) {this.dark=value;this.renderer.setClearColor(value?'#162c30':'#e7eee5',1);this.renderer.toneMappingExposure=value?.85:1.1;this.sun.intensity=value?1.6:2.6;if(this.ground)this.ground.material=this.material(value?'#516956':'#bdcba3');if(this.water)this.water.material=this.material(value?'#2c5054':'#b8d9d5');this.schedule()}
  resize(width: number,height: number) {this.width=width;this.height=height;this.renderer.setSize(width,height,false);const size=this.bounds.getSize(new THREE.Vector3());const half=this.hasData&&this.camera.zoom===1?Math.max(12,(size.x+size.z+15)*.26,(size.x+size.z+15)*.35*height/width):(this.camera.top-this.camera.bottom)/2;this.camera.top=half;this.camera.bottom=-half;this.camera.left=-half*width/height;this.camera.right=half*width/height;this.camera.updateProjectionMatrix();if(this.hasData)this.schedule()}
  fit() {
    const center=this.bounds.getCenter(new THREE.Vector3()), size=this.bounds.getSize(new THREE.Vector3())
    this.controls.target.set(center.x,0,center.z);this.camera.position.set(center.x+95,92,center.z+116);this.camera.zoom=1;this.controls.update()
    const half=Math.max(12,(size.x+size.z+15)*.26,((size.x+size.z+15)*.35)*this.height/this.width)
    this.camera.top=half;this.camera.bottom=-half;this.camera.left=-half*this.width/this.height;this.camera.right=half*this.width/this.height;this.camera.updateProjectionMatrix();this.schedule()
  }
  zoom(factor: number) {this.camera.zoom=THREE.MathUtils.clamp(this.camera.zoom*factor,.35,16);this.camera.updateProjectionMatrix();this.cameraChanged()}
  rotate() {const offset=this.camera.position.clone().sub(this.controls.target).applyAxisAngle(new THREE.Vector3(0,1,0),Math.PI/4);this.camera.position.copy(this.controls.target).add(offset);this.controls.update();this.schedule()}
  focus(id: string) {const l=this.byId.get(id) ?? this.rawLots.get(id);if(!l)return;const offset=this.camera.position.clone().sub(this.controls.target);this.controls.target.set(l.x,l.h*.3,l.z);this.camera.position.copy(this.controls.target).add(offset);this.camera.zoom=Math.max(this.camera.zoom,2);this.camera.updateProjectionMatrix();this.controls.update();this.cameraChanged()}
  private down=(e:PointerEvent)=>{this.pointerDown={x:e.clientX,y:e.clientY}}
  private up=(e:PointerEvent)=>{if(this.pointerDown&&Math.hypot(e.clientX-this.pointerDown.x,e.clientY-this.pointerDown.y)<4){const id=this.pick(e);if(id)this.select(id)}this.pointerDown=null}
  private pick(e:PointerEvent) {
    const rect=this.canvas.getBoundingClientRect();this.mouse.set((e.clientX-rect.left)/this.width*2-1,-(e.clientY-rect.top)/this.height*2+1);this.ray.setFromCamera(this.mouse,this.camera)
    const hit=this.ray.intersectObjects(this.pickables,false)[0];return hit&&hit.instanceId!==undefined?this.instanceIds.get(hit.object)?.[hit.instanceId]:undefined
  }
  private hover=(e:PointerEvent)=>{if(this.pointerDown||performance.now()-this.lastHover<130)return;this.lastHover=performance.now();const id=this.pick(e),lot=id?this.byId.get(id):undefined;this.canvas.style.cursor=lot?'pointer':'grab';if(lot){const r=this.canvas.getBoundingClientRect();this.emit({name:lot.node.label + (this.blockMembers.has(lot.node.id) ? ` · 街区含 ${this.blockMembers.get(lot.node.id)!.length} 个对象` : ''),kind:lot.node.nodeType,x:e.clientX-r.left,y:e.clientY-r.top})}else this.emit()}
  private leave=()=>this.emit()
  private emit(hover?:SceneStatus['hover']) {
    const candidates=[...this.labels];const selected=this.byId.get(this.selected) ?? this.rawLots.get(this.selected);if(selected&&!candidates.includes(selected))candidates.unshift(selected)
    const rects:{x:number;y:number;w:number}[]=[],labels:Label[]=[]
    for(const l of candidates.sort((a,b)=>Number(!!b.style)-Number(!!a.style)||Number(b.node.id===this.selected)-Number(a.node.id===this.selected))) {
      const p=new THREE.Vector3(l.x,l.h+.6,l.z).project(this.camera),x=(p.x+1)*this.width/2,w=Math.min(180,l.node.label.length*8+25)
      let y=(1-p.y)*this.height/2
      if(l.style)for(let attempt=0;attempt<3&&rects.some(r=>Math.abs(x-r.x)<(w+r.w)/2+10&&Math.abs(y-r.y)<35);attempt++)y-=36
      if(x<50||x>this.width-60||y<30||y>this.height-80||p.z>1)continue
      if(!l.style&&l.node.id!==this.selected&&rects.some(r=>Math.abs(x-r.x)<(w+r.w)/2+10&&Math.abs(y-r.y)<35))continue
      rects.push({x,y,w});labels.push({id:l.node.id,name:l.node.label,x,y,kind:l.node.nodeType,selected:l.node.id===this.selected})
    }
    this.status({labels,count:this.total,rendered:this.lots.length,aggregated:this.total>1200,zoom:this.camera.zoom,hover})
  }
  private cameraChanged=()=>{
    this.schedule()
  }
  private schedule=()=>{if(this.disposed)return;cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(()=>{this.renderer.render(this.scene,this.camera);this.emit()})}
  dispose() {
    this.disposed=true;cancelAnimationFrame(this.frame);this.controls.dispose();this.clear();for(const m of this.materials.values())m.dispose();this.materials.clear();this.sun.shadow.map?.dispose();this.renderer.dispose()
    this.canvas.removeEventListener('pointerdown',this.down);this.canvas.removeEventListener('pointerup',this.up);this.canvas.removeEventListener('pointermove',this.hover);this.canvas.removeEventListener('pointerleave',this.leave);this.canvas.removeEventListener('contextmenu',this.contextMenu)
  }
}
