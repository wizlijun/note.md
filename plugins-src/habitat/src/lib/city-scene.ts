import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { cityNodes, isExplicit } from './domain'
import { overviewBlocks } from './city-projection'
import type { Edge, Layout, Node } from './types'

const SCALE = .052
const known = new Map([['hemory', 'campus'], ['note.md', 'campus'], ['bushcraft', 'camp']])
export function landmarkStyle(node: Node) {
  return (node.status === 'anchor' || node.status === 'observed') ? known.get(node.label.toLowerCase()) : undefined
}
function seed(text: string) { let n = 2166136261; for (const c of text) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return (n >>> 0) / 4294967296 }
interface Lot { node: Node; x: number; z: number; h: number; w: number; style?: string }
export interface CityData { nodes: Node[]; layout: Layout[]; edges: Edge[] }
export interface Label { id: string; name: string; x: number; y: number; kind: string; selected: boolean }
export interface SceneStatus { labels: Label[]; count: number; rendered?: number; aggregated?: boolean; hover?: { name: string; kind: string; x: number; y: number } }
const palette = { cream: '#ece7d5', roof: '#c29b78', project: '#729497', park: '#a4b789', grass: '#b9c8a1', road: '#ddd8c8' }

export class CityScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-60, 60, 45, -45, .1, 700)
  private controls: OrbitControls
  private city = new THREE.Group()
  private lots: Lot[] = []
  private data: CityData | null = null
  private detail = false
  private building = false
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
    entries.forEach((entry, i) => {
      dummy.position.set(entry.p[0], entry.p[1], entry.p[2]); dummy.scale.set(entry.s[0], entry.s[1], entry.s[2]); dummy.rotation.set(0, entry.ry ?? 0, 0); dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
      if (entry.color) mesh.setColorAt(i, new THREE.Color(entry.color))
    })
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere(); this.city.add(mesh)
    if (selectable) { this.pickables.push(mesh); this.instanceIds.set(mesh, entries.map(e => e.id ?? '')) }
  }
  private clear() {
    this.city.traverse(object => { if(object instanceof THREE.InstancedMesh)object.dispose(); if (object instanceof THREE.Mesh) object.geometry.dispose(); if(object instanceof THREE.Line){object.geometry.dispose();for(const m of Array.isArray(object.material)?object.material:[object.material])m.dispose()} })
    this.city.clear(); this.pickables = []; this.instanceIds.clear(); this.ring = null; this.selectedGlyph = null; this.renderedIds.clear()
  }
  setData(data: CityData, reframe: boolean) {
    this.data = data; this.building = true
    if (reframe) this.detail = false
    this.clear(); this.changeMarkers = null; this.blockMembers.clear()
    const positions = new Map(data.layout.map(p => [p.id, p]))
    const heroIds = new Set<string>()
    for (const label of known.keys()) {
      const candidates = data.nodes.filter(n=>n.label.toLowerCase()===label && landmarkStyle(n)).sort((a,b)=>Number(b.status==='anchor')-Number(a.status==='anchor')||(b.evidence?.length??0)-(a.evidence?.length??0)||a.id.localeCompare(b.id))
      if(candidates[0])heroIds.add(candidates[0].id)
    }
    this.lots = data.nodes.flatMap(node => {
      const p = positions.get(node.id); if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return []
      const variation = seed(node.id), style = heroIds.has(node.id) ? landmarkStyle(node) : undefined
      const h = style === 'campus' ? 11 : style === 'camp' ? 2 : node.nodeType === 'project' ? 1.25 + variation * 1.8 : node.nodeType === 'topic' ? .15 : node.nodeType === 'document' ? .12 + variation * .1 : .2 + variation * .44
      return [{ node, x: p.x * SCALE, z: p.y * SCALE, h, w: style ? 3.6 : node.nodeType === 'project' ? .28 : node.nodeType === 'topic' ? .48 : .13, style }]
    })
    this.total = this.lots.length
    this.rawLots = new Map(this.lots.map(l => [l.node.id, l]))
    this.bounds.makeEmpty(); for (const lot of this.lots) this.bounds.expandByPoint(new THREE.Vector3(lot.x, lot.h, lot.z))
    if (this.bounds.isEmpty()) this.bounds.set(new THREE.Vector3(-12, 0, -12), new THREE.Vector3(12, 1, 12))
    const aggregated = data.nodes.length > 1200 && !this.detail
    const blocks = aggregated ? overviewBlocks(this.lots) : []
    if (aggregated) {
      const heroes = this.lots.filter(l => l.style)
      this.lots = [...heroes, ...blocks.flatMap(block => block.representatives.slice(0, block.members.some(l=>l.node.nodeType==='project') ? 7 : 5).map((lot, i) => {
        this.blockMembers.set(lot.node.id, block.members.map(l=>l.node.id))
        const v = seed(lot.node.id), project = lot.node.nodeType === 'project'
        return {...lot, x:block.x + (i % 3 - 1) * 1.8, z:block.z + (Math.floor(i / 3) - 1) * 1.8,
          w:project ? 1.1 : .85 + v * .28, h:project ? 2 + v * 3.2 : .65 + v * 1.65}
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
    // Environment paving and landscape have no knowledge-edge meaning.
    const streetEntries = []
    const spacing = aggregated ? 8 : 34 * SCALE
    const roadWidth = aggregated ? .85 : .045
    for (let x = Math.ceil((center.x-w/2+2)/spacing)*spacing; x < center.x+w/2-2; x+=spacing) streetEntries.push({p:[x,.115,center.z],s:[roadWidth,.012,d-3]})
    for (let z = Math.ceil((center.z-d/2+2)/spacing)*spacing; z < center.z+d/2-2; z+=spacing) streetEntries.push({p:[center.x,.115,z],s:[w-3,.012,roadWidth]})
    this.batch(new THREE.BoxGeometry(1,1,1), aggregated ? '#b1b6a6' : palette.road, streetEntries)
    const heroes=this.lots.filter(l=>l.style)
    const inHero=(l:Lot)=>heroes.some(h=>Math.abs(l.x-h.x)<4.5 && Math.abs(l.z-h.z)<3.8)
    const plots = aggregated ? blocks.map(b=>({p:[b.x,.12,b.z],s:[6.5,.04,6.5],color:seed(`${b.x}/${b.z}`)>.65?'#acc397':'#d9d9be'})) : this.lots.filter(l => !inHero(l) && l.node.nodeType === 'topic').map(l => ({p:[l.x,.12,l.z],s:[1.28,.035,1.28],color:seed(l.node.id)> .7?'#b4c49b':'#c4cfac'}))
    this.batch(new THREE.BoxGeometry(1,1,1), '#ffffff', plots)
    const bodies = [], roofs = [], windows = [], trees = [], trunks = []
    for (const lot of this.lots) {
      const {node,x,z,h,w,style} = lot, v = seed(node.id)
      if (style) { this.landmark(lot); this.renderedIds.add(node.id); continue }
      if(inHero(lot) && lot.node.id!==this.selected) continue
      this.renderedIds.add(node.id)
      const project = node.nodeType === 'project', topic = node.nodeType === 'topic', document = node.nodeType === 'document'
      bodies.push({p:[x,.16+h/2,z],s:[w,h,w*.86],id:node.id,color:project ? ['#76969a','#a8bcb7','#8a9c8c'][Math.floor(v*3)] : topic ? '#becfa5' : document ? '#ded6c0' : ['#f0e7d3','#d9ccb2','#d9c3a8','#b5c4ba'][Math.floor(v*4)]})
      if (!project && !topic) roofs.push({p:[x,.17+h,z],s:[w*1.1,.055,w],color:document ? '#ae8971' : '#c2aa86'})
      if (project) {
        roofs.push({p:[x,.19+h,z],s:[w*1.05,.055,w*.95],color:'#e9e7dc'})
        for(let y=.38;y<h;y+=.26) windows.push({p:[x,.16+y,z+w*.437],s:[w*.78,.055,.014]})
        bodies.push({p:[x+w*.72,.16+h*.19,z+w*.45],s:[w*.65,h*.38,w*.7],id:node.id,color:'#aabcb3'})
      }
      if ((topic || aggregated) && v>.35) {
        trees.push({p:[x+.72,aggregated ? .7 : .45,z+.65],s:[aggregated ? .4 : .26,aggregated ? 1 : .5,aggregated ? .4 : .26],ry:v*6})
        trunks.push({p:[x+.72,.3,z+.65],s:[.035,.2,.035]})
      }
    }
    this.batch(new THREE.BoxGeometry(1,1,1),'#ffffff', bodies,true)
    this.batch(new THREE.BoxGeometry(1,1,1),'#ffffff', roofs)
    this.batch(new THREE.BoxGeometry(1,1,1),'#d5e4df', windows)
    // A planted perimeter makes the scene a single place, instead of a scatterplot.
    for (let i=0;i<130;i++) {
      const t=i/130*Math.PI*2, x=center.x+Math.cos(t)*(w/2-1.6), z=center.z+Math.sin(t)*(d/2-1.6), variation=seed(`tree-${i}`)
      trees.push({p:[x,.45+variation*.2,z],s:[.5,.7+variation*.4,.5],ry:variation*6})
      trunks.push({p:[x,.22,z],s:[.06,.32,.06]})
    }
    this.batch(new THREE.ConeGeometry(1,1,6),'#8baf85',trees)
    this.batch(new THREE.BoxGeometry(1,1,1),'#997e60',trunks)
    this.relationships(data.edges)
    const reserved = this.lots.filter(l => l.style).sort((a,b)=>(b.node.evidence?.length??0)-(a.node.evidence?.length??0)).slice(0,3)
    const named = [...reserved,...cityNodes(this.lots.map(l=>l.node).filter(n=>!known.has(n.label.toLowerCase())),'',7).flatMap(n=>this.byId.has(n.id)?[this.byId.get(n.id)!]:[])]
    const seen = new Set<string>(); this.labels = named.filter(l=>!seen.has(l.node.id)&&!!seen.add(l.node.id)).slice(0,12)
    this.hasData = true
    this.setSelected(this.selected,this.changed)
    if (reframe) this.fit(); else this.schedule()
    this.building = false
  }
  private landmark(lot: Lot) {
    const {x,z,node,style} = lot
    const camp=style==='camp'
    this.mesh(new THREE.BoxGeometry(9,.16,7.8),camp?'#a7be8f':'#e5dfcc',x,.23,z)
    this.mesh(new THREE.BoxGeometry(9.4,.08,8.2),'#eee6d1',x,.14,z)
    const trees=[],trunks=[]
    for(let i=0;i<16;i++) {
      const angle=i/16*Math.PI*2, tx=x+Math.cos(angle)*4.1,tz=z+Math.sin(angle)*3.4,h=.9+seed(`hero-tree-${i}`)*1.1
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
      const towers=[{p:[x-1.5,3.9,z-.3],s:[1.6,7.3,1.65],id:node.id},{p:[x+.65,5.7,z-1.15],s:[1.7,10.9,1.6],id:node.id},{p:[x+1.7,1.8,z+1.5],s:[1.5,3.1,1.7],id:node.id}]
      this.batch(new THREE.BoxGeometry(1,1,1),warm?'#c6ac84':'#668d83',towers,true)
      this.mesh(new THREE.BoxGeometry(5.9,.7,4.2),warm?'#ddd0ad':'#a4b3a0',x,.63,z)
      const stripes=[]
      for(const tower of towers) for(let y=.9;y<tower.s[1];y+=.55) {
        stripes.push({p:[tower.p[0],y,tower.p[2]+tower.s[2]/2+.012],s:[tower.s[0]*.83,.16,.02]})
        stripes.push({p:[tower.p[0]+tower.s[0]/2+.012,y,tower.p[2]],s:[.02,.16,tower.s[2]*.83]})
      }
      this.batch(new THREE.BoxGeometry(1,1,1),warm?'#f0e5cb':'#c6d5bc',stripes)
      const roofs=towers.map(t=>({p:[t.p[0],t.p[1]+t.s[1]/2+.08,t.p[2]],s:[t.s[0]*1.09,.15,t.s[2]*1.09]}))
      this.batch(new THREE.BoxGeometry(1,1,1),'#e9e5d3',roofs)
      this.mesh(new THREE.BoxGeometry(.7,.55,.7),'#9caf98',x+.65,11.5,z-1.15)
      this.mesh(new THREE.BoxGeometry(3,.08,.65),'#f4ecda',x,.23,z+3)
      this.batch(new THREE.BoxGeometry(1,1,1),'#c0a889',[{p:[x-2,.45,z+2.6],s:[1.2,.2,.3]},{p:[x+1.4,.45,z+2.6],s:[1.2,.2,.3]}])
    }
  }

  private relationships(edges: Edge[]) {
    const prominent = new Set(cityNodes(this.lots.map(l=>l.node),'',120).map(n=>n.id))
    for(const l of this.lots) if(l.style) prominent.add(l.node.id)
    const candidates=edges.filter(e=>e.participants.filter(p=>prominent.has(p.node)).length>=2).sort((a,b)=>Number(isExplicit(b))-Number(isExplicit(a))||b.verifiedFamilies-a.verifiedFamilies||a.id.localeCompare(b.id)).slice(0,70)
    for(const edge of candidates) {
      const points=[...new Set(edge.participants.map(p=>p.node))].flatMap(id=>this.byId.has(id)?[this.byId.get(id)!]:[])
      if(points.length<2)continue
      const cx=points.reduce((s,l)=>s+l.x,0)/points.length,cz=points.reduce((s,l)=>s+l.z,0)/points.length
      for(const lot of points) {
        const distance=Math.hypot(lot.x-cx,lot.z-cz)
        const curve=new THREE.QuadraticBezierCurve3(new THREE.Vector3(lot.x,.21,lot.z),new THREE.Vector3(lot.x,.22,cz),new THREE.Vector3(cx,.21,cz))
        if(isExplicit(edge)) {
          const road=new THREE.Mesh(new THREE.TubeGeometry(curve,16,.045+Math.min(5,edge.verifiedFamilies)*.018,4,false),this.material('#b49364'))
          road.receiveShadow=true;this.city.add(road);continue
        }
        const geometry=new THREE.BufferGeometry().setFromPoints(curve.getPoints(Math.min(40,Math.max(6,Math.ceil(distance)))))
        const material=isExplicit(edge)?new THREE.LineBasicMaterial({color:'#b08d5b',transparent:true,opacity:.58}):new THREE.LineDashedMaterial({color:'#9cac92',dashSize:.14,gapSize:.12,transparent:true,opacity:.4})
        const line=new THREE.Line(geometry,material);line.computeLineDistances();this.city.add(line)
      }
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
  resize(width: number,height: number) {this.width=width;this.height=height;this.renderer.setSize(width,height,false);const size=this.bounds.getSize(new THREE.Vector3());const half=this.hasData&&this.camera.zoom===1?Math.max(12,(size.x+size.z+15)*.30,(size.x+size.z+15)*.40*height/width):(this.camera.top-this.camera.bottom)/2;this.camera.top=half;this.camera.bottom=-half;this.camera.left=-half*width/height;this.camera.right=half*width/height;this.camera.updateProjectionMatrix();if(this.hasData)this.schedule()}
  fit() {
    const center=this.bounds.getCenter(new THREE.Vector3()), size=this.bounds.getSize(new THREE.Vector3())
    this.controls.target.set(center.x,0,center.z);this.camera.position.set(center.x+95,92,center.z+116);this.camera.zoom=1;this.controls.update()
    const half=Math.max(12,(size.x+size.z+15)*.30,((size.x+size.z+15)*.40)*this.height/this.width)
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
    this.status({labels,count:this.total,rendered:this.lots.length,aggregated:!!this.data && this.data.nodes.length>1200&&!this.detail,hover})
  }
  private cameraChanged=()=>{
    const detail=this.camera.zoom>=3.5
    if(!this.building && this.data && this.data.nodes.length>1200 && detail!==this.detail){this.detail=detail;this.setData(this.data,false)}
    this.schedule()
  }
  private schedule=()=>{if(this.disposed)return;cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(()=>{this.renderer.render(this.scene,this.camera);this.emit()})}
  dispose() {
    this.disposed=true;cancelAnimationFrame(this.frame);this.controls.dispose();this.clear();for(const m of this.materials.values())m.dispose();this.materials.clear();this.sun.shadow.map?.dispose();this.renderer.dispose()
    this.canvas.removeEventListener('pointerdown',this.down);this.canvas.removeEventListener('pointerup',this.up);this.canvas.removeEventListener('pointermove',this.hover);this.canvas.removeEventListener('pointerleave',this.leave);this.canvas.removeEventListener('contextmenu',this.contextMenu)
  }
}
