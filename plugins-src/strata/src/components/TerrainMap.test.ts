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
const flush = async () => {
  for (let i = 0; i < 3; i++) { await tick(); const pending = frames.splice(0); for (const frame of pending) frame(0) }
  await tick()
}
beforeEach(() => {
  vi.clearAllMocks()
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('Path2D', class {})
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  const noop = () => {}
  const context = { setTransform: noop, clearRect: noop, fillRect: noop, drawImage: noop, save: noop, translate: noop, scale: noop, stroke: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, arc: noop, fill: noop, putImageData: noop,
    measureText: () => ({ width: 80 }), getImageData: () => ({ data: new Uint8ClampedArray([120, 140, 100, 255]) }), createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }) }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
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
