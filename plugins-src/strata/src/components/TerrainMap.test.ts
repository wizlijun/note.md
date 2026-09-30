// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import TerrainMap from './TerrainMap.svelte'
import type { TerrainBounds, TerrainResult } from '../lib/types-terrain'
import { createTerrain3D } from '../lib/terrain-renderer'

const three = vi.hoisted(() => ({ render: vi.fn(), project: vi.fn((_position: { x: number; y: number }) => ({ x: 0, y: 0, visible: false })), dispose: vi.fn() }))
vi.mock('../lib/terrain-renderer', () => ({ createTerrain3D: vi.fn(() => three) }))

const full = { x: 0, y: 0, width: 1, height: 1 }
function result(epoch = 'first', domain = 'domain', bounds: TerrainBounds = full): TerrainResult {
  const node = { id: 'node', title: '知识点', sourceGroups: [], x: .5, y: .5, radius: .02, parentDomain: domain, parentTopic: 'topic', crowded: false }
  const cluster = { id: domain, name: '测试山群', x: .5, y: .5, radius: .1, memberIds: ['node'] }
  return {
    field: new Float32Array(16), grid: { width: 4, height: 4, bounds }, contours: [], levels: [], peakAnchors: [], visibleIds: ['node'], masses: new Float32Array(1),
    layout: { version: 'strata-atlas/1', epoch, worldSize: 4096, nodes: [node], domains: [cluster], topics: [{ ...cluster, id: 'topic', parentId: domain }], idf: {}, diagnostics: { graphEdges: 0, crowdedNodes: 0, rebuildSuggested: false, elapsedMs: 0 } },
    stats: { elapsedMs: 0, selectedNodes: 1, totalMass: 0, fieldIntegral: 0, kernelBytes: 0, contourVertices: 0, contoursTruncated: false, unresolvedPeaks: 0 },
  }
}
let component: TerrainMap | undefined
let frames: FrameRequestCallback[]
let relationLines: { from: number[]; to: number[] }[]
let markerColors: string[]
let markerPositions: { x: number; y: number }[]
let selectionRings: { x: number; y: number }[]
const flush = async () => {
  for (let i = 0; i < 3; i++) { await tick(); const pending = frames.splice(0); for (const frame of pending) frame(0) }
  await tick()
}
beforeEach(() => {
  vi.clearAllMocks()
  frames = []; relationLines = []; markerColors = []; markerPositions = []; selectionRings = []
  three.project.mockImplementation(() => ({ x: 0, y: 0, visible: false }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('Path2D', class {})
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  const noop = () => {}
  let dashed = false, start: number[] = []
  let vertices: { x: number; y: number }[] = [], circle: { x: number; y: number; r: number } | null = null
  const context = { fillStyle: '', setTransform: noop, clearRect: noop, fillRect: noop, drawImage: noop, save: noop, translate: noop, scale: noop,
    stroke() { if (circle?.r === 8) selectionRings.push({ x: circle.x, y: circle.y }) }, restore: noop, beginPath() { vertices = []; circle = null },
    setLineDash: (parts: number[]) => { dashed = !!parts.length }, moveTo: (x: number, y: number) => { start = [x, y]; vertices.push({ x, y }) }, lineTo: (x: number, y: number) => { vertices.push({ x, y }); if (dashed) relationLines.push({ from: start, to: [x, y] }) },
    closePath: noop, arc: (x: number, y: number, r: number) => { circle = { x, y, r } }, fill() { markerColors.push(this.fillStyle); markerPositions.push(circle ? { x: circle.x, y: circle.y } : { x: vertices.reduce((sum, p) => sum + p.x, 0) / vertices.length, y: vertices.reduce((sum, p) => sum + p.y, 0) / vertices.length }) }, putImageData: noop,
    measureText: () => ({ width: 80 }), getImageData: () => ({ data: new Uint8ClampedArray([120, 140, 100, 255]) }), createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }) }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
})

function meetingResult(): TerrainResult {
  const data = result(), base = data.layout.nodes[0]
  data.layout.nodes = [
    { ...base, id: 'support', title: '个人材料中的支撑', kind: 'entity', state: 'imported', importance: 1, ownerSpecificity: 'owner_specific', x: .3, y: .3 },
    { ...base, id: 'core', title: '会议核心事实', kind: 'claim', state: 'imported', importance: 0, ownerSpecificity: 'general', x: .7, y: .3 },
    { ...base, id: 'third', title: '会议支撑事实', kind: 'event', state: 'imported', importance: 1, x: .5, y: .7 },
  ]
  data.visibleIds = data.layout.nodes.map(node => node.id)
  for (const cluster of [...data.layout.domains, ...data.layout.topics]) cluster.memberIds = data.visibleIds
  data.masses = new Float32Array(3)
  return data
}

it('uses meeting importance and imported labels, then invalidates emphasis when switching datasets', async () => {
  const data = meetingResult(), state = new SvelteMap<string, 'vault_index' | 'meetings_knowledge'>([['dataset', 'meetings_knowledge']])
  component = mount(TerrainMap, { target: document.body, props: { result: data, get dataset() { return state.get('dataset')! }, view: '2d', level: 'knowledge', onfocus: vi.fn(), onselect: vi.fn(), onview: vi.fn(), onerror: vi.fn() } })
  await flush()
  expect(document.querySelector('.map-label.personal')?.getAttribute('aria-label')).toBe('查看知识：会议核心事实')
  expect([...document.querySelectorAll('.map-label small')].every(label => label.textContent === '已提取知识')).toBe(true)
  expect(document.querySelector('.legend')?.textContent).toContain('◆ 核心')
  expect(document.querySelector('.legend')?.textContent).toContain('● 支撑')
  expect(document.querySelector('.legend')?.textContent).toContain('近邻表示主题聚合；连线表示已有关系')
  state.set('dataset', 'vault_index'); await flush()
  expect(document.querySelector('.map-label.personal')?.getAttribute('aria-label')).toBe('查看证据：个人材料中的支撑')
  expect(document.querySelector('.legend')?.textContent).toContain('个人独有')
  expect(document.querySelector('.kind-legend')).toBeNull()
})

it('counts imported cluster members as knowledge and uses all five muted kind colors only on markers', async () => {
  const data = meetingResult(), base = data.layout.nodes[0]
  data.layout.nodes = ['entity', 'concept', 'claim', 'event', 'narrative'].map((kind, i) => ({ ...base, id: kind, kind, x: .36 + i * .07, y: .5 }))
  data.visibleIds = data.layout.nodes.map(node => node.id)
  for (const cluster of [...data.layout.domains, ...data.layout.topics]) cluster.memberIds = data.visibleIds
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => ({ color: (element as HTMLElement).style.color } as CSSStyleDeclaration))
  component = mount(TerrainMap, { target: document.body, props: { result: data, dataset: 'meetings_knowledge', view: '2d', onfocus: vi.fn(), onselect: vi.fn(), onview: vi.fn(), onerror: vi.fn() } })
  await flush()
  expect(document.querySelector('.map-label small')?.textContent).toBe('5 条知识')
  expect(markerColors).toHaveLength(0)
  const zoom = document.querySelector<HTMLButtonElement>('[aria-label="放大地图"]')!
  zoom.click(); zoom.click(); zoom.click(); await flush()
  expect(new Set(markerColors)).toEqual(new Set(['entity', 'concept', 'claim', 'event', 'narrative'].map(kind => `var(--st-kind-${kind})`)))
  expect(document.querySelectorAll('.kind-legend span')).toHaveLength(5)
})

function denseMeetingResult(): TerrainResult {
  const data = meetingResult(), base = data.layout.nodes[0]
  data.layout.nodes = Array.from({ length: 300 }, (_, i) => ({ ...base, id: `dense-${i}`, title: `会议知识 ${i}`, importance: i % 4 === 0 ? 0 as const : 1 as const,
    x: .3 + (i % 20) * .019, y: .31 + Math.floor(i / 20) * .02 }))
  data.visibleIds = data.layout.nodes.map(node => node.id)
  for (const cluster of [...data.layout.domains, ...data.layout.topics]) cluster.memberIds = data.visibleIds
  data.masses = new Float32Array(data.visibleIds.length)
  return data
}

it.each(['2d', '3d'] as const)('shows mountain groups without a point cloud, then spaces only readable knowledge marks in %s', async view => {
  const data = denseMeetingResult()
  three.project.mockImplementation((position: { x: number; y: number }) => ({ x: position.x * 900, y: position.y * 600, visible: true }))
  component = mount(TerrainMap, { target: document.body, props: { result: data, dataset: 'meetings_knowledge', personal: false, view, onfocus: vi.fn(), onselect: vi.fn(), onview: vi.fn(), onerror: vi.fn() } })
  await flush()
  expect(markerPositions).toHaveLength(0)
  expect(document.querySelector('.map-label small')?.textContent).toBe('300 条知识')
  expect(document.querySelector('.legend')?.textContent).toContain('标题为当前范围的代表词')
  expect(document.querySelector('.legend')?.textContent).toContain('全部知识见目录')
  const zoom = document.querySelector<HTMLButtonElement>('[aria-label="放大地图"]')!
  zoom.click(); zoom.click(); zoom.click(); await flush()
  const shown = document.querySelectorAll('.map-label[aria-label^="查看知识："]')
  expect(shown.length).toBeGreaterThan(1)
  expect(shown.length).toBeLessThanOrEqual(24)
  expect(markerPositions).toHaveLength(shown.length)
  for (let i = 0; i < markerPositions.length; i++) for (let j = i + 1; j < markerPositions.length; j++) {
    expect(Math.hypot(markerPositions[i].x - markerPositions[j].x, markerPositions[i].y - markerPositions[j].y)).toBeGreaterThanOrEqual(56)
  }
  expect(document.querySelector('.map-label.personal')).toBeNull()
  expect(document.querySelector('.legend')?.textContent).toContain('◆ 核心')
  expect(data.visibleIds).toHaveLength(300)
  expect(data.layout.nodes).toHaveLength(300)
  expect(data.field.every(value => value === 0)).toBe(true)
})

it.each(['2d', '3d'] as const)('locates a selected meeting knowledge with one ring and no overlapping dot in %s', async view => {
  const data = meetingResult(), state = new SvelteMap<string, TerrainResult>([['result', data]])
  three.project.mockImplementation((position: { x: number; y: number }) => ({ x: position.x * 900, y: position.y * 600, visible: true }))
  component = mount(TerrainMap, { target: document.body, props: { get result() { return state.get('result')! }, dataset: 'meetings_knowledge', selectedId: 'core', level: 'knowledge', view, onfocus: vi.fn(), onselect: vi.fn(), onview: vi.fn(), onerror: vi.fn() } })
  await flush()
  expect(selectionRings).toEqual([{ x: 630, y: 180 }])
  expect(markerPositions.some(p => p.x === 630 && p.y === 180)).toBe(false)
  selectionRings = []
  state.set('result', { ...data, visibleIds: ['support', 'third'] }); await flush()
  expect(selectionRings).toHaveLength(0)
  state.set('result', { ...data, grid: { ...data.grid, bounds: { x: 0, y: 0, width: .4, height: .4 } } }); await flush()
  expect(selectionRings).toHaveLength(0)
})

it('retains index overview marker behavior', async () => {
  const data = denseMeetingResult()
  component = mount(TerrainMap, { target: document.body, props: { result: data, dataset: 'vault_index', view: '2d', onfocus: vi.fn(), onselect: vi.fn(), onview: vi.fn(), onerror: vi.fn() } })
  await flush()
  expect(markerPositions).toHaveLength(300)
  expect(document.querySelector('.legend')?.textContent).not.toContain('标题为当前范围的代表词')
})

it('draws every hyperedge participant to one directionless junction and skips incomplete relations', async () => {
  const data = meetingResult(), state = new SvelteMap<string, TerrainResult>([['result', data]])
  const relations = [{ source: 'support', target: 'core', participants: [{ nodeId: 'support', role: 'cause' }, { nodeId: 'core', role: 'action' }, { nodeId: 'third', role: 'result' }] }]
  component = mount(TerrainMap, { target: document.body, props: { get result() { return state.get('result')! }, dataset: 'meetings_knowledge', level: 'knowledge', relations, showRelations: true, view: '2d', onfocus: vi.fn(), onselect: vi.fn(), onview: vi.fn(), onerror: vi.fn() } })
  await flush()
  expect(relationLines).toHaveLength(3)
  expect(relationLines.map(line => line.from)).toEqual(expect.arrayContaining([[270, 180], [630, 180], [450, 420]]))
  for (const line of relationLines) { expect(line.to[0]).toBeCloseTo(450); expect(line.to[1]).toBeCloseTo(260) }
  expect(data.field.every(value => value === 0)).toBe(true)
  relationLines = []
  state.set('result', { ...data, visibleIds: ['support', 'core'] }); await flush()
  expect(relationLines).toHaveLength(0)
  state.set('result', { ...data, grid: { ...data.grid, bounds: { x: .2, y: .2, width: .6, height: .3 } } }); await flush()
  expect(relationLines).toHaveLength(0)
})

it('shows only selected-node relations and aggregates repeated connections', async () => {
  const data = meetingResult(), state = new SvelteMap<string, string>([['selected', 'third']])
  const relations = [...Array.from({ length: 60 }, () => ({ source: 'support', target: 'core' })), { source: 'core', target: 'third' }]
  component = mount(TerrainMap, { target: document.body, props: { result: data, dataset: 'meetings_knowledge', level: 'knowledge', get selectedId() { return state.get('selected')! }, relations, showRelations: true, view: '2d', onfocus: vi.fn(), onselect: vi.fn(), onview: vi.fn(), onerror: vi.fn() } })
  await flush()
  expect(relationLines).toHaveLength(1)
  expect(relationLines[0]).toEqual({ from: [630, 180], to: [450, 420] })
  relationLines = []; state.set('selected', 'support'); await flush()
  expect(relationLines).toHaveLength(1)
  expect(relationLines[0]).toEqual({ from: [630, 180], to: [270, 180] })
})
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('preserves focus across a same-epoch date load, but resets it on the next atlas epoch', async () => {
  const state = new SvelteMap<string, TerrainResult | null>([['result', result()]])
  const onfocus = vi.fn()
  component = mount(TerrainMap, { target: document.body, props: { get result() { return state.get('result')! }, view: '2d', onfocus, onselect: vi.fn(), onview: vi.fn(), onerror: vi.fn() } })
  await flush(); component.focus('domain'); await flush()
  const bounds = onfocus.mock.calls[0][0] as TerrainBounds
  state.set('result', null); await flush()
  state.set('result', result('first', 'domain', bounds)); await flush()
  expect(document.querySelector('h1')?.textContent).toBe('测试山群')
  expect(onfocus).toHaveBeenCalledTimes(1)
  state.set('result', null); await flush()
  state.set('result', result('second')); await flush()
  expect(document.querySelector('h1')?.textContent).toBe('每一座山，都有你的来处。')
  expect(document.querySelector('[aria-label="展开山群：测试山群"]')).not.toBeNull()
  expect(onfocus).toHaveBeenCalledTimes(1)
})

it('requests the full terrain when the focused cluster disappears in the same epoch', async () => {
  const state = new SvelteMap<string, TerrainResult | null>([['result', result()]])
  const onfocus = vi.fn()
  component = mount(TerrainMap, { target: document.body, props: { get result() { return state.get('result')! }, view: '2d', onfocus, onselect: vi.fn(), onview: vi.fn(), onerror: vi.fn() } })
  await flush(); component.focus('domain'); await flush()
  state.set('result', result('first', 'replacement', onfocus.mock.calls[0][0])); await flush()
  expect(document.querySelector('h1')?.textContent).toBe('每一座山，都有你的来处。')
  expect(onfocus).toHaveBeenLastCalledWith(undefined)
  expect(onfocus).toHaveBeenCalledTimes(2)
})

it('reuses the 3D renderer through an empty date-refresh state and disposes only on unmount', async () => {
  const state = new SvelteMap<string, TerrainResult | null>([['result', result()]])
  const onview = vi.fn()
  component = mount(TerrainMap, { target: document.body, props: { get result() { return state.get('result')! }, view: '3d', onfocus: vi.fn(), onselect: vi.fn(), onview, onerror: vi.fn() } })
  await flush()
  expect(createTerrain3D).toHaveBeenCalledTimes(1)
  expect(three.render).toHaveBeenCalled()
  const rendered = three.render.mock.calls.length
  state.set('result', null); await flush()
  expect(three.dispose).not.toHaveBeenCalled()
  expect(three.render).toHaveBeenCalledTimes(rendered)
  expect(document.querySelector('[aria-label="三维知识山体"]')?.classList.contains('hidden')).toBe(true)
  const next = result()
  state.set('result', next); await flush()
  expect(createTerrain3D).toHaveBeenCalledTimes(1)
  expect(three.render).toHaveBeenLastCalledWith(expect.objectContaining({ field: next.field }))
  expect(three.dispose).not.toHaveBeenCalled()
  expect(onview).not.toHaveBeenCalled()
  await unmount(component); component = undefined
  expect(three.dispose).toHaveBeenCalledTimes(1)
})


it.each(['2d', '3d'] as const)('connects readable overview concept groups without drawing the underlying node web in %s', async view => {
  const data = meetingResult()
  data.layout.nodes = data.layout.nodes.map((node, i) => ({ ...node, parentDomain: `d${i}`, topicTerms: [`概念${i}`] }))
  data.layout.domains = data.layout.nodes.map((node, i) => ({ id: node.parentDomain, name: `概念${i}`, x: node.x, y: node.y, radius: .1, memberIds: [node.id] }))
  const relations = Array.from({ length: 60 }, () => ({ source: 'support', target: 'core' }))
  three.project.mockImplementation((position: { x: number; y: number }) => ({ x: position.x * 900, y: position.y * 600, visible: true }))
  component = mount(TerrainMap, { target: document.body, props: { result: data, dataset: 'meetings_knowledge', level: 'domain', relations, showRelations: true, view, onfocus: vi.fn(), onselect: vi.fn(), onview: vi.fn(), onerror: vi.fn() } })
  await flush()
  expect(document.querySelector('h1')?.textContent).toBe('概念与范畴')
  expect(document.querySelectorAll('.map-label')).toHaveLength(3)
  expect(markerPositions).toHaveLength(0)
  expect(relationLines).toHaveLength(1)
  expect(relationLines[0]).toEqual({ from: [270, 180], to: [630, 180] })
})


it('starts meeting overview at the more specific topic vocabulary while preserving the index domain view', async () => {
  const data = meetingResult(), state = new SvelteMap<string, 'vault_index' | 'meetings_knowledge'>([['dataset', 'meetings_knowledge']])
  data.layout.domains[0].name = '宽泛山群'; data.layout.topics[0].name = '具体概念'
  component = mount(TerrainMap, { target: document.body, props: { result: data, get dataset() { return state.get('dataset')! }, view: '2d', onfocus: vi.fn(), onselect: vi.fn(), onview: vi.fn(), onerror: vi.fn() } })
  await flush()
  expect(document.querySelector('[aria-label="展开山群：具体概念"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="展开山群：宽泛山群"]')).toBeNull()
  state.set('dataset', 'vault_index'); await flush()
  expect(document.querySelector('[aria-label="展开山群：宽泛山群"]')).not.toBeNull()
})
