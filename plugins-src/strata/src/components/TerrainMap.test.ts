// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import TerrainMap from './TerrainMap.svelte'
import type { TerrainBounds, TerrainResult } from '../lib/types-terrain'
import { createTerrain3D } from '../lib/terrain-renderer'

const three = vi.hoisted(() => ({ render: vi.fn(), project: vi.fn(() => ({ x: 0, y: 0, visible: false })), dispose: vi.fn() }))
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
const flush = async () => {
  for (let i = 0; i < 3; i++) { await tick(); const pending = frames.splice(0); for (const frame of pending) frame(0) }
  await tick()
}
beforeEach(() => {
  vi.clearAllMocks()
  frames = []; relationLines = []; markerColors = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('Path2D', class {})
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  const noop = () => {}
  let dashed = false, start: number[] = []
  const context = { fillStyle: '', setTransform: noop, clearRect: noop, fillRect: noop, drawImage: noop, save: noop, translate: noop, scale: noop, stroke: noop, restore: noop, beginPath: noop,
    setLineDash: (parts: number[]) => { dashed = !!parts.length }, moveTo: (x: number, y: number) => { start = [x, y] }, lineTo: (x: number, y: number) => { if (dashed) relationLines.push({ from: start, to: [x, y] }) },
    closePath: noop, arc: noop, fill() { markerColors.push(this.fillStyle) }, putImageData: noop,
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
  expect(document.querySelector('.legend')?.textContent).toContain('连线为抽取关系，山脊为地形')
  state.set('dataset', 'vault_index'); await flush()
  expect(document.querySelector('.map-label.personal')?.getAttribute('aria-label')).toBe('查看证据：个人材料中的支撑')
  expect(document.querySelector('.legend')?.textContent).toContain('个人独有')
  expect(document.querySelector('.kind-legend')).toBeNull()
})

it('counts imported cluster members as knowledge and uses all five muted kind colors only on markers', async () => {
  const data = meetingResult(), base = data.layout.nodes[0]
  data.layout.nodes = ['entity', 'concept', 'claim', 'event', 'narrative'].map((kind, i) => ({ ...base, id: kind, kind, x: .2 + i * .15, y: .5 }))
  data.visibleIds = data.layout.nodes.map(node => node.id)
  for (const cluster of [...data.layout.domains, ...data.layout.topics]) cluster.memberIds = data.visibleIds
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => ({ color: (element as HTMLElement).style.color } as CSSStyleDeclaration))
  component = mount(TerrainMap, { target: document.body, props: { result: data, dataset: 'meetings_knowledge', view: '2d', onfocus: vi.fn(), onselect: vi.fn(), onview: vi.fn(), onerror: vi.fn() } })
  await flush()
  expect(document.querySelector('.map-label small')?.textContent).toBe('5 条知识')
  expect(new Set(markerColors)).toEqual(new Set(['entity', 'concept', 'claim', 'event', 'narrative'].map(kind => `var(--st-kind-${kind})`)))
  expect(document.querySelectorAll('.kind-legend span')).toHaveLength(5)
})

it('draws every hyperedge participant to one directionless junction and skips incomplete relations', async () => {
  const data = meetingResult(), state = new SvelteMap<string, TerrainResult>([['result', data]])
  const relations = [{ source: 'support', target: 'core', participants: [{ nodeId: 'support', role: 'cause' }, { nodeId: 'core', role: 'action' }, { nodeId: 'third', role: 'result' }] }]
  component = mount(TerrainMap, { target: document.body, props: { get result() { return state.get('result')! }, dataset: 'meetings_knowledge', relations, showRelations: true, view: '2d', onfocus: vi.fn(), onselect: vi.fn(), onview: vi.fn(), onerror: vi.fn() } })
  await flush()
  expect(relationLines).toHaveLength(3)
  expect(relationLines.map(line => line.from)).toEqual([[270, 180], [630, 180], [450, 420]])
  for (const line of relationLines) { expect(line.to[0]).toBeCloseTo(450); expect(line.to[1]).toBeCloseTo(260) }
  expect(data.field.every(value => value === 0)).toBe(true)
  relationLines = []
  state.set('result', { ...data, visibleIds: ['support', 'core'] }); await flush()
  expect(relationLines).toHaveLength(0)
  state.set('result', { ...data, grid: { ...data.grid, bounds: { x: .2, y: .2, width: .6, height: .3 } } }); await flush()
  expect(relationLines).toHaveLength(0)
})

it('prioritizes selected-node relations within the 60-relation overlay budget', async () => {
  const data = meetingResult(), state = new SvelteMap<string, string>([['selected', 'third']])
  const relations = [...Array.from({ length: 60 }, () => ({ source: 'support', target: 'core' })), { source: 'core', target: 'third' }]
  component = mount(TerrainMap, { target: document.body, props: { result: data, dataset: 'meetings_knowledge', get selectedId() { return state.get('selected')! }, relations, showRelations: true, view: '2d', onfocus: vi.fn(), onselect: vi.fn(), onview: vi.fn(), onerror: vi.fn() } })
  await flush()
  expect(relationLines).toHaveLength(60)
  expect(relationLines[0]).toEqual({ from: [630, 180], to: [450, 420] })
  relationLines = []; state.set('selected', 'support'); await flush()
  expect(relationLines).toHaveLength(60)
  expect(relationLines[0]).toEqual({ from: [270, 180], to: [630, 180] })
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
