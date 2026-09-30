<script lang="ts">
  import { onMount } from 'svelte'
  import type { TerrainResult, TerrainBounds, AtlasCluster, AtlasNode, PeakAnchor } from '../lib/types-terrain'
  import { createTerrain3D } from '../lib/terrain-renderer'
  import { elevation, traceContour } from '../lib/contour-path'

  let { result, view = '3d', dataset = 'vault_index', selectedId = '', personal = true, relations = [], showRelations = false, level = 'auto', verticalScale = 1, onselect, onview, onfocus, onerror }: {
    result: TerrainResult | null
    view: '2d' | '3d'
    dataset?: 'vault_index' | 'meetings_knowledge'
    selectedId?: string
    personal?: boolean
    relations?: { source: string; target: string; participants?: { nodeId: string; role: string }[] }[]
    showRelations?: boolean
    level?: 'auto' | 'domain' | 'topic' | 'knowledge'
    verticalScale?: number
    onselect: (id: string) => void
    onview: (mode: '2d' | '3d') => void
    onfocus: (bounds: TerrainBounds | undefined) => void
    onerror: (message: string) => void
  } = $props()

  type Label = { id: string; text: string; sub: string; x: number; y: number; w: number; personal: boolean; cluster: boolean }
  type Entry = { id: string; name: string; x: number; y: number; sub: string; personal: boolean; cluster: boolean; width: number }
  type Mark = { id: string; x: number; y: number; personal: boolean; kind?: string }
  type Projected = { x: number; y: number; visible: boolean }
  let surface: HTMLDivElement
  let overlay: HTMLCanvasElement
  let mountain: HTMLCanvasElement
  let colorProbe: HTMLSpanElement
  let controls: HTMLDivElement
  let labels = $state<Label[]>([])
  let zoom = $state(1)
  let focusName = $state('')
  let focusId = ''
  let camera = { yaw: -.25, pitch: .85, targetX: .5, targetY: .5 }
  let pan = { x: 0, y: 0 }
  let mounted = false
  let frame = 0
  let three: ReturnType<typeof createTerrain3D> | null = null
  let context: CanvasRenderingContext2D | null = null
  let previousResult: TerrainResult | null = null
  let previousDataset: typeof dataset | undefined
  let layoutEpoch = ''
  let paths: Path2D[] = []
  let shade: HTMLCanvasElement | null = null
  let shadeTheme = ''
  let plotPoints: { id: string; x: number; y: number; personal: boolean }[] = []
  let drag: { x: number; y: number; panX: number; panY: number; yaw: number; pitch: number } | null = null
  let observedBounds = ''
  let frameWidth = 1, frameHeight = 1
  let peakMaximum = 0
  let visibleIds = new Set<string>()
  let visibleNodes: AtlasNode[] = []
  let nodeById = new Map<string, AtlasNode>()
  let anchors = new Map<string, PeakAnchor>()
  let clusterById = new Map<string, AtlasCluster>()
  let clusterEntries: { domain: Entry[]; topic: Entry[] } = { domain: [], topic: [] }
  let sceneKey = ''
  let marks: Mark[] = []
  let entries: Entry[] = []
  let previousRelations: typeof relations | null = null
  let relationSelection = ''
  let relationDrawings: { points: { x: number; y: number }[]; center?: { x: number; y: number } }[] = []
  let occupiedControl: { x: number; y: number; w: number; h: number } | null = null
  let controlKey = ''
  const frameColors = new Map<string, string>()
  const projected = new Map<string, Projected>()
  const knowledgeKinds = [
    { id: 'entity', name: '实体' }, { id: 'concept', name: '概念' }, { id: 'claim', name: '主张' },
    { id: 'event', name: '事件' }, { id: 'narrative', name: '叙事' },
  ]
  const emphasized = (node: AtlasNode) => dataset === 'meetings_knowledge' ? node.importance === 0 : node.ownerSpecificity === 'owner_specific'
  const local = (p: { x: number; y: number }) => {
    const b = result!.grid.bounds
    return { x: (p.x - b.x) / b.width, y: (p.y - b.y) / b.height }
  }
  const ink = (token: string) => {
    const cached = frameColors.get(token)
    if (cached) return cached
    colorProbe.style.color = `var(${token})`
    const color = getComputedStyle(colorProbe).color
    frameColors.set(token, color)
    return color
  }
  const lod = () => level !== 'auto' ? level : focusId || zoom >= 2.4 ? 'knowledge' : zoom >= 1.6 ? 'topic' : 'domain'
  function point(p: { x: number; y: number }) {
    const n = local(p)
    if (view === '3d' && three) return three.project(n)
    return { x: ((n.x - .5) * zoom + .5 + pan.x) * frameWidth, y: ((n.y - .5) * zoom + .5 + pan.y) * frameHeight, visible: true }
  }
  function project(id: string, position: { x: number; y: number }) {
    let value = projected.get(id)
    if (!value) { value = point(position); projected.set(id, value) }
    return value
  }
  function entryWidth(text: string) { return Math.min(190, Math.max(100, context!.measureText(text).width + 28)) }

  /** O(N) data work happens once per Worker result, never on camera-only frames. */
  function cacheResult() {
    if (!result || !context) return
    visibleIds = new Set(result.visibleIds)
    visibleNodes = result.layout.nodes.filter(node => visibleIds.has(node.id))
    nodeById = new Map(result.layout.nodes.map(node => [node.id, node]))
    anchors = new Map(result.peakAnchors.map(peak => [peak.id, peak]))
    clusterById = new Map([...result.layout.domains, ...result.layout.topics].map(cluster => [cluster.id, cluster]))
    const epochChanged = layoutEpoch !== '' && layoutEpoch !== result.layout.epoch
    layoutEpoch = result.layout.epoch
    if (epochChanged || (focusId && !clusterById.has(focusId))) {
      resetNavigation()
      const bounds = result.grid.bounds
      if (bounds.x !== 0 || bounds.y !== 0 || bounds.width !== 1 || bounds.height !== 1) onfocus(undefined)
    } else if (focusId) focusName = clusterById.get(focusId)!.name
    peakMaximum = 0
    for (const peak of result.peakAnchors) peakMaximum = Math.max(peakMaximum, peak.height)
    const counts = new Map<string, { count: number; verified: boolean; personal: boolean }>()
    for (const node of visibleNodes) for (const id of [node.parentDomain, node.parentTopic]) {
      const summary = counts.get(id) || { count: 0, verified: false, personal: false }
      summary.count++; summary.verified ||= node.state === 'verified'; summary.personal ||= emphasized(node)
      counts.set(id, summary)
    }
    context.font = '13px -apple-system, sans-serif'
    const summarize = (clusters: AtlasCluster[]): Entry[] => clusters.flatMap(cluster => {
      const summary = counts.get(cluster.id)
      return summary ? [{ id: cluster.id, name: cluster.name, x: cluster.x, y: cluster.y,
        sub: dataset === 'meetings_knowledge' ? `${summary.count} 条知识` : `${summary.count} 个${summary.verified ? '知识 / 候选' : '索引候选'}`, personal: summary.personal,
        cluster: true, width: entryWidth(cluster.name) }] : []
    })
    clusterEntries = { domain: summarize(result.layout.domains), topic: summarize(result.layout.topics) }
    sceneKey = ''; previousRelations = null
  }

  /** Cache only bounded drawing candidates when presentation settings/semantic LOD change. */
  function cacheScene(currentLod: 'domain' | 'topic' | 'knowledge') {
    const key = `${dataset}:${focusId}:${personal}:${currentLod}`
    if (sceneKey === key) return
    sceneKey = key
    const limit = dataset === 'meetings_knowledge' ? (currentLod === 'knowledge' ? 200 : 0) : currentLod === 'knowledge' ? 1500 : 300
    const ordered: AtlasNode[] = []
    // Atlas order is stable. Prioritize core/owner nodes without sorting 32k rows.
    const append = (owner: boolean | null) => {
      for (const node of visibleNodes) {
        if (ordered.length >= limit) break
        if (focusId && node.parentDomain !== focusId && node.parentTopic !== focusId) continue
        if (owner !== null && emphasized(node) !== owner) continue
        ordered.push(node)
      }
    }
    if (personal) { append(true); append(false) } else append(null)
    marks = dataset === 'meetings_knowledge' ? [] : ordered.map(node => ({ id: node.id, x: anchors.get(node.id)?.x ?? node.x, y: anchors.get(node.id)?.y ?? node.y,
      personal: emphasized(node), kind: node.kind }))
    context!.font = '13px -apple-system, sans-serif'
    if (currentLod === 'knowledge') entries = ordered.slice(0, 200).map(node => ({
      id: node.id, name: node.title, x: anchors.get(node.id)?.x ?? node.x, y: anchors.get(node.id)?.y ?? node.y,
      sub: node.state === 'imported' ? '已提取知识' : node.state === 'verified' ? '引文已核对' : '索引候选', personal: emphasized(node),
      cluster: false, width: entryWidth(node.title),
    }))
    else {
      const candidates = clusterEntries[currentLod]
      entries = personal ? [...candidates.filter(entry => entry.personal), ...candidates.filter(entry => !entry.personal)].slice(0, 200) : candidates.slice(0, 200)
    }
  }

  function cacheRelations() {
    if (previousRelations === relations && relationSelection === selectedId) return
    previousRelations = relations; relationSelection = selectedId
    const visible = new Set(visibleNodes.map(node => node.id))
    const participantIds = (edge: typeof relations[number]) => dataset === 'meetings_knowledge' && edge.participants?.length ? edge.participants.map(participant => participant.nodeId) : [edge.source, edge.target]
    relationDrawings = []
    let count = 0
    // Selected-node relations come first. Skip incomplete/oversized relations as a whole:
    // drawing a subset of a hyperedge would imply a different relationship.
    const append = (selected: boolean) => {
      for (const edge of relations) {
        if (count >= 60) break
        const ids = participantIds(edge)
        if (!!selectedId && ids.includes(selectedId) !== selected) continue
        if (ids.length > 32 || ids.some(id => !visible.has(id))) continue
        const nodes = [...new Set(ids)].map(id => nodeById.get(id)!).filter(Boolean)
        if (nodes.length < 2) continue
        const points = nodes.map(node => anchors.get(node.id) || node)
        if (points.length === 2) relationDrawings.push({ points })
        else {
          const center = { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length }
          relationDrawings.push({ points, center })
        }
        count++
      }
    }
    if (selectedId) { append(true); append(false) } else append(false)
  }
  function schedule() { if (mounted && !frame) frame = requestAnimationFrame(() => { frame = 0; draw() }) }
  function raster() {
    if (!result) return
    const theme = ink('--st-terrain-low') + ink('--st-terrain-high')
    if (shade && shadeTheme === theme) return
    shadeTheme = theme
    const { width: w, height: h } = result.grid
    shade = document.createElement('canvas'); shade.width = w; shade.height = h
    const c = shade.getContext('2d')!
    const rgb = (token: string) => { c.fillStyle = ink(token); c.fillRect(0, 0, 1, 1); return c.getImageData(0, 0, 1, 1).data.slice(0, 3) }
    const low = rgb('--st-terrain-low'), high = rgb('--st-terrain-high')
    const pixels = c.createImageData(w, h), heights = Float32Array.from(result.field, elevation)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, band = Math.min(1, heights[i] / 1.05)
      const nx = -(heights[y * w + Math.min(w - 1, x + 1)] - heights[y * w + Math.max(0, x - 1)]) * w / 24
      const nz = -(heights[Math.min(h - 1, y + 1) * w + x] - heights[Math.max(0, y - 1) * w + x]) * h / 16
      const light = .76 + .25 * Math.max(0, (-.45 * nx + 1 - .6 * nz) / (Math.hypot(nx, 1, nz) * 1.25))
      for (let k = 0; k < 3; k++) pixels.data[i * 4 + k] = (low[k] + (high[k] - low[k]) * band) * light
      pixels.data[i * 4 + 3] = 255
    }
    c.putImageData(pixels, 0, 0)
  }
  function draw() {
    if (!context || !surface) return
    const w = surface.clientWidth, h = surface.clientHeight, dpr = Math.min(devicePixelRatio || 1, 2)
    frameWidth = w; frameHeight = h; frameColors.clear(); projected.clear()
    if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(h * dpr)) { overlay.width = w * dpr; overlay.height = h * dpr }
    const ctx = context
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h)
    if (!result) {
      labels = []; plotPoints = []; previousResult = null
      visibleNodes = []; visibleIds.clear(); nodeById.clear(); anchors.clear(); clusterById.clear(); clusterEntries = { domain: [], topic: [] }
      marks = []; entries = []; relationDrawings = []; sceneKey = ''; previousRelations = null
      paths = []; shade = null; peakMaximum = 0
      return
    }
    const boundsKey = JSON.stringify(result.grid.bounds)
    if (boundsKey !== observedBounds) { observedBounds = boundsKey; zoom = 1; pan = { x: 0, y: 0 }; camera.targetX = .5; camera.targetY = .5 }
    if (previousResult !== result || previousDataset !== dataset) {
      previousResult = result; previousDataset = dataset; shade = null
      paths = result.contours.map(contour => { const p = new Path2D(); traceContour(p, contour); return p })
      cacheResult()
    }
    const currentLod = lod(), step = currentLod === 'knowledge' ? 1 : 2
    cacheScene(currentLod)
    if (showRelations) cacheRelations()
    if (view === '3d') {
      try {
        three ??= createTerrain3D(mountain, ink)
        three.render({ field: result.field, grid: result.grid, contours: result.contours, levels: result.levels, view: { ...camera, distance: Math.max(14 * Math.max(result.grid.bounds.width, result.grid.bounds.height), 2.8 * elevation(peakMaximum) * verticalScale) * Math.max(1, .85 / (w / h)) / zoom }, verticalScale, contourOpacity: .65, detail: Math.ceil(result.contours.length / step) })
      } catch (error) { three?.dispose(); three = null; onview('2d'); onerror('三维暂不可用，已切换到同一地形的等高线。'); return }
    } else {
      ctx.fillStyle = ink('--st-bg'); ctx.fillRect(0, 0, w, h)
      if (result.visibleIds.length) {
        raster()
        const left = (.5 - .5 * zoom + pan.x) * w, top = (.5 - .5 * zoom + pan.y) * h
        if (shade) ctx.drawImage(shade, left, top, w * zoom, h * zoom)
        ctx.save(); ctx.translate(left, top); ctx.scale(w * zoom / result.grid.width, h * zoom / result.grid.height)
        ctx.strokeStyle = ink('--st-green')
        for (let i = 0; i < paths.length; i += step) {
          ctx.globalAlpha = i % (step * 4) === 0 ? .7 : .4
          ctx.lineWidth = (i % (step * 4) === 0 ? 1 : .6) * result.grid.width / (w * zoom)
          ctx.stroke(paths[i])
        }
        ctx.restore()
      }
    }
    if (showRelations) {
      ctx.strokeStyle = ink(dataset === 'meetings_knowledge' ? '--st-muted' : '--st-gold'); ctx.lineWidth = 1; ctx.globalAlpha = .65
      ctx.setLineDash(dataset === 'meetings_knowledge' ? [4, 3] : [])
      const onScreen = (p: Projected) => p.visible && p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h
      for (const relation of relationDrawings) {
        const points = relation.points.map(point), center = relation.center ? point(relation.center) : undefined
        if (points.some(p => !onScreen(p)) || (center && !onScreen(center))) continue
        const end = center || points[1]
        for (const start of center ? points : [points[0]]) {
          ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke()
        }
        if (center) { ctx.beginPath(); ctx.arc(center.x, center.y, 3, 0, Math.PI * 2); ctx.stroke() }
      }
      ctx.setLineDash([])
    }
    ctx.globalAlpha = 1; plotPoints = []
    const drawMark = (n: Pick<Mark, 'id' | 'personal' | 'kind'>, p: Projected) => {
      const owner = n.personal
      plotPoints.push({ id: n.id, x: p.x, y: p.y, personal: owner })
      if (dataset === 'meetings_knowledge' && n.id === selectedId) return
      const kind = knowledgeKinds.find(kind => kind.id === n.kind)
      ctx.fillStyle = ink(dataset === 'meetings_knowledge' && kind ? `--st-kind-${kind.id}` : owner && personal ? '--st-gold' : '--st-green'); ctx.beginPath()
      const size = currentLod === 'knowledge' ? 3 : 2
      if (owner) { ctx.moveTo(p.x, p.y - size * 1.5); ctx.lineTo(p.x + size, p.y); ctx.lineTo(p.x, p.y + size * 1.5); ctx.lineTo(p.x - size, p.y); ctx.closePath() }
      else ctx.arc(p.x, p.y, size, 0, Math.PI * 2)
      if (dataset === 'meetings_knowledge') { ctx.strokeStyle = ink('--st-bg'); ctx.lineWidth = 2; ctx.stroke() }
      ctx.fill()
    }
    // Index markers retain their existing budget. Meeting markers are emitted only
    // with a readable individual label below, never as an overview point cloud.
    for (const n of marks) {
      const p = project(n.id, n)
      if (p.visible && p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h) drawMark(n, p)
    }
    const nextControlKey = `${w}:${h}:${view}`
    if (!occupiedControl || controlKey !== nextControlKey) {
      controlKey = nextControlKey
      const mapBox = surface.getBoundingClientRect(), controlBox = controls.getBoundingClientRect()
      occupiedControl = { x: controlBox.left - mapBox.left - 5, y: controlBox.top - mapBox.top - 5, w: controlBox.width + 10, h: controlBox.height + 10 }
    }
    const occupied = [occupiedControl]
    const next: Label[] = [], bottomMargin = dataset === 'meetings_knowledge' ? 100 : 50; ctx.font = '13px -apple-system, sans-serif'
    for (const e of entries) {
      if (next.length >= 24) break
      const p = project(e.id, e)
      if (!p.visible || p.x < 0 || p.x > w || p.y < 90 || p.y > h - bottomMargin - 5) continue
      if (dataset === 'meetings_knowledge' && !e.cluster && plotPoints.some(mark => Math.hypot(mark.x - p.x, mark.y - p.y) < 56)) continue
      const bw = e.width, bh = 46
      const offsets = e.cluster ? [[0, 22], [0, -28], [60, 0], [-60, 0]] : [[0, 38], [0, -38], [100, 0], [-100, 0], [90, 48], [-90, 48]]
      for (const [dx, dy] of offsets) {
        const x = Math.max(bw / 2 + 8, Math.min(w - bw / 2 - 8, p.x + dx)), y = p.y + dy
        const box = { x: x - bw / 2 - 4, y: y - bh / 2 - 4, w: bw + 8, h: bh + 8 }
        if (box.y < 86 || box.y + box.h > h - bottomMargin || occupied.some(b => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) continue
        occupied.push(box); next.push({ id: e.id, text: e.name, sub: e.sub, x, y, w: bw, personal: e.personal, cluster: e.cluster })
        if (dataset === 'meetings_knowledge' && !e.cluster) drawMark({ id: e.id, personal: e.personal, kind: nodeById.get(e.id)?.kind }, p)
        if (!e.cluster) { ctx.strokeStyle = ink('--st-muted'); ctx.globalAlpha = .45; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(x, y + (y > p.y ? -22 : 22)); ctx.stroke(); ctx.globalAlpha = 1 }
        break
      }
    }
    // A directory selection remains locatable even when its label is omitted.
    // Date-filtered or offscreen knowledge must not acquire a selection marker.
    if (dataset === 'meetings_knowledge' && selectedId && visibleIds.has(selectedId)) {
      const node = nodeById.get(selectedId)
      if (node) {
        const p = project(selectedId, anchors.get(selectedId) || node)
        if (p.visible && p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h) {
          ctx.strokeStyle = ink('--st-ink'); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.stroke()
          if (!plotPoints.some(mark => mark.id === selectedId)) plotPoints.push({ id: selectedId, x: p.x, y: p.y, personal: emphasized(node) })
        }
      }
    }
    labels = next
  }
  function focusCluster(c: AtlasCluster) {
    if (!result) return
    const members = c.memberIds.map(id => nodeById.get(id)).filter((node): node is AtlasNode => !!node)
    if (!members.length) return
    const minX = Math.min(...members.map(n => n.x - n.radius * 3)), maxX = Math.max(...members.map(n => n.x + n.radius * 3))
    const minY = Math.min(...members.map(n => n.y - n.radius * 3)), maxY = Math.max(...members.map(n => n.y + n.radius * 3))
    const size = Math.min(1, Math.max(.04, maxX - minX, maxY - minY) * 1.2)
    const x = Math.max(0, Math.min(1 - size, (minX + maxX - size) / 2)), y = Math.max(0, Math.min(1 - size, (minY + maxY - size) / 2))
    focusId = c.id; focusName = c.name; camera.pitch = 1.05
    onfocus({ x, y, width: size, height: size })
  }
  export function focus(id: string) {
    if (previousResult !== result) cacheResult()
    const cluster = clusterById.get(id)
    if (cluster) focusCluster(cluster)
  }
  function choose(label: Label) { if (label.cluster) focus(label.id); else onselect(label.id) }
  function resetNavigation() { focusId = ''; focusName = ''; zoom = 1; pan = { x: 0, y: 0 }; camera = { yaw: -.25, pitch: .85, targetX: .5, targetY: .5 } }
  function home() { resetNavigation(); onfocus(undefined); schedule() }
  function changeZoom(delta: number) { zoom = Math.max(1, Math.min(6, zoom + delta)); schedule() }
  function turn(delta: number) { camera.yaw += delta; schedule() }
  function tilt(delta: number) { camera.pitch = Math.max(.28, Math.min(1.4, camera.pitch + delta)); schedule() }
  function down(e: PointerEvent) { if (!(e.target instanceof HTMLCanvasElement)) return; drag = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y, yaw: camera.yaw, pitch: camera.pitch }; e.target.setPointerCapture(e.pointerId) }
  function move(e: PointerEvent) {
    if (!drag) return
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y
    if (view === '3d') { camera.yaw = drag.yaw - dx * .006; camera.pitch = Math.max(.28, Math.min(1.4, drag.pitch + dy * .005)) }
    else { pan.x = Math.max(-zoom / 2, Math.min(zoom / 2, drag.panX + dx / surface.clientWidth)); pan.y = Math.max(-zoom / 2, Math.min(zoom / 2, drag.panY + dy / surface.clientHeight)) }
    schedule()
  }
  function up(e: PointerEvent) {
    if (drag && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) {
      const rect = surface.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top
      let nearest: typeof plotPoints[number] | undefined, distance = 18
      for (const p of plotPoints) { const d = Math.hypot(p.x - x, p.y - y); if (d < distance) { nearest = p; distance = d } }
      if (nearest) onselect(nearest.id)
    }
    drag = null
  }
  function wheel(e: WheelEvent) { if (!(e.target instanceof HTMLCanvasElement)) return; e.preventDefault(); changeZoom(-e.deltaY * .003) }
  function keyboard(e: KeyboardEvent) {
    if (e.target !== surface) return
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'].includes(e.key)) e.preventDefault()
    if (e.key === '+' || e.key === '=') changeZoom(.5)
    if (e.key === '-') changeZoom(-.5)
    if (e.key === '0') home()
    if (e.key === 'ArrowLeft') view === '3d' ? turn(-.2) : (pan.x += .08, schedule())
    if (e.key === 'ArrowRight') view === '3d' ? turn(.2) : (pan.x -= .08, schedule())
    if (e.key === 'ArrowUp') view === '3d' ? tilt(.15) : (pan.y += .08, schedule())
    if (e.key === 'ArrowDown') view === '3d' ? tilt(-.15) : (pan.y -= .08, schedule())
  }
  $effect(() => { result; view; dataset; selectedId; personal; showRelations; relations; level; verticalScale; schedule() })
  onMount(() => {
    context = overlay.getContext('2d'); mounted = true
    const resize = new ResizeObserver(() => { occupiedControl = null; schedule() }); resize.observe(surface); resize.observe(controls)
    const media = matchMedia('(prefers-color-scheme: dark)'); media.addEventListener('change', schedule)
    surface.addEventListener('wheel', wheel, { passive: false }); schedule()
    return () => { mounted = false; cancelAnimationFrame(frame); resize.disconnect(); media.removeEventListener('change', schedule); surface.removeEventListener('wheel', wheel); three?.dispose(); shade = null; paths = [] }
  })
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (The canvas map is a keyboard-operated spatial application; every action also has a native button.) -->
<div class="terrain" bind:this={surface} role="application" aria-label="知识地形；方向键移动或旋转，加减键缩放，0返回全景。也可用知识目录导航。" tabindex="0" onkeydown={keyboard}>
  <canvas bind:this={mountain} class:hidden={view !== '3d' || !result} aria-label="三维知识山体" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={() => drag = null}></canvas>
  <canvas bind:this={overlay} class:passive={view === '3d'} aria-label="知识等高线、峰顶和关系" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={() => drag = null}></canvas>
  <span class="color-probe" bind:this={colorProbe} aria-hidden="true"></span>
  <div class="map-caption"><span>YOUR KNOWLEDGE, IN RELIEF</span><h1>{focusName || '每一座山，都有你的来处。'}</h1></div>
  <div class="labels" aria-label="可见的知识与山群">
    {#each labels as label (label.id)}
      <button class="map-label" class:personal={personal && label.personal} style:left="{label.x}px" style:top="{label.y}px" style:width="{label.w}px" title={label.text} onclick={() => choose(label)} aria-label={label.cluster ? `展开山群：${label.text}` : `${dataset === 'meetings_knowledge' ? '查看知识' : '查看证据'}：${label.text}`}><span>{label.personal ? '◆ ' : ''}{label.text}</span><small>{label.sub}</small></button>
    {/each}
  </div>
  <div class="map-controls" bind:this={controls} aria-label="地图导航">
    {#if view === '3d'}<button aria-label="向左旋转" onclick={() => turn(-.3)}>↶</button><button aria-label="向右旋转" onclick={() => turn(.3)}>↷</button><button aria-label="更俯视" onclick={() => tilt(.15)}>俯</button><button aria-label="更侧视" onclick={() => tilt(-.15)}>侧</button>{/if}
    <button aria-label="放大地图" onclick={() => changeZoom(.5)} disabled={zoom >= 6}>＋</button><button aria-label="缩小地图" onclick={() => changeZoom(-.5)} disabled={zoom <= 1}>−</button><button aria-label="返回全景" onclick={home}>全景</button>
  </div>
  <div class="legend">
    {#if result?.stats.contoursTruncated || result?.stats.unresolvedPeaks}<div class="detail-note">{result.stats.contoursTruncated ? '概览已简化轮廓。' : ''}{result.stats.unresolvedPeaks ? '密集区域的子峰请展开山群查看。' : ''}</div>{/if}
    <div class="legend-row emphasis-legend"><span>◆ {dataset === 'meetings_knowledge' ? '核心' : '个人独有'}</span><span>● {dataset === 'meetings_knowledge' ? '支撑' : '其他 / 未知'}</span><span>相对高程 · 固定刻度</span></div>
    {#if dataset === 'meetings_knowledge'}
      <div>概览按山群聚合；放大或展开查看少量标记，全部知识见目录</div>
      <div class="legend-row kind-legend" aria-label="知识点类型">{#each knowledgeKinds as kind}<span><i style:background="var(--st-kind-{kind.id})"></i>{kind.name}</span>{/each}</div>
      <div>连线为抽取关系，山脊为地形</div>
    {/if}
  </div>
  <div class="view-hint">{view === '3d' ? '拖动旋转' : '拖动平移'} · {Math.round(zoom * 100)}%</div>
  {#if result && !result.visibleIds.length}<div class="map-empty">此范围内没有可展示的知识或索引候选。<small>调整日期或资料筛选后再试。</small></div>{/if}
</div>

<style>
  .terrain{--st-kind-entity:#607f95;--st-kind-concept:#857648;--st-kind-claim:#986978;--st-kind-event:#a66d43;--st-kind-narrative:#648477;position:relative;width:100%;height:100%;min-height:400px;overflow:hidden;background:var(--st-bg);isolation:isolate}
  canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab}canvas:active{cursor:grabbing}.hidden{display:none}.passive{pointer-events:none}
  .color-probe{position:absolute;visibility:hidden;pointer-events:none}.map-caption{position:absolute;top:22px;left:25px;max-width:calc(100% - 50px);pointer-events:none}.map-caption>span{font:10px/1.5 ui-monospace,monospace;letter-spacing:2px;color:var(--st-muted)}h1{font-size:21px;font-weight:400;margin:8px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .labels{position:absolute;inset:0;pointer-events:none}.map-label{position:absolute;transform:translate(-50%,-50%);height:46px;padding:5px 9px;border:0;border-radius:5px;background:var(--st-label);color:var(--st-ink);pointer-events:auto;text-align:center}.map-label>span{display:block;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.map-label small{display:block;font-size:11px;margin-top:3px;color:var(--st-muted)}.map-label.personal>span{font-weight:500}.map-label:hover{box-shadow:0 0 0 1px var(--st-green)}
  .map-controls{position:absolute;bottom:48px;right:17px;display:flex;flex-direction:column;gap:2px;padding:4px;background:var(--st-surface);border:1px solid var(--st-border);border-radius:8px}.map-controls button{height:31px;min-width:33px;padding:0 5px;border:0;background:none;color:var(--st-ink);font-size:14px}.map-controls button:hover{background:var(--ui-hover)}.map-controls button:disabled{opacity:.35}
  .legend{position:absolute;bottom:16px;left:24px;display:flex;flex-direction:column;gap:5px;max-width:calc(100% - 105px);font-size:11px;color:var(--st-muted);pointer-events:none;background:var(--st-label);padding:3px 7px;border-radius:3px}.legend-row{display:flex;flex-wrap:wrap;gap:12px}.kind-legend span{display:flex;align-items:center;gap:4px}.kind-legend i{width:7px;height:7px;border-radius:50%;display:inline-block}.view-hint{position:absolute;bottom:16px;right:22px;font-size:11px;color:var(--st-muted);background:var(--st-label);padding:3px 7px;border-radius:3px}.map-empty{position:absolute;top:46%;left:20px;right:20px;max-width:440px;margin:auto;padding:22px;text-align:center;background:var(--st-surface);border-radius:8px}.map-empty small{display:block;margin-top:8px;color:var(--st-muted)}
  @media(prefers-color-scheme:dark){.terrain{--st-kind-entity:#97b5c5;--st-kind-concept:#c5b57a;--st-kind-claim:#c99eaf;--st-kind-event:#d5ab80;--st-kind-narrative:#99baaa}}
  @media(max-width:650px){.legend{left:12px}.legend-row{gap:8px}.emphasis-legend span:last-child{display:none}.map-caption{left:17px}.map-caption h1{font-size:18px}.map-controls{right:12px}.view-hint{right:12px}}
</style>
