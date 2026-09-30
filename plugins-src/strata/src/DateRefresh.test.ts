// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import App from './App.svelte'
import { buildAtlas } from './lib/atlas'
import { TerrainEngine } from './lib/terrain'
import type { Snapshot } from './lib/types'
import type { Atlas, TerrainInputNode, TerrainSelection } from './lib/types-terrain'
const mocks = vi.hoisted(() => ({ build: vi.fn(), render: vi.fn(), draw3D: vi.fn(), draw2D: vi.fn() }))
vi.mock('./lib/worker-client', () => ({ TerrainWorkerClient: class { build = mocks.build; render = mocks.render; cancel() {} dispose() {} } }))
vi.mock('./lib/terrain-renderer', () => ({ createTerrain3D: () => ({ render: mocks.draw3D, project: (p: { x: number; y: number }) => ({ x: p.x * 900, y: p.y * 600, visible: true }), dispose() {} }) }))
let app: ReturnType<typeof mount> | undefined
let frames: FrameRequestCallback[] = []
const flush = async () => {
  for (let i = 0; i < 12; i++) { await Promise.resolve(); await tick(); for (const callback of frames.splice(0)) callback(0) }
  await tick()
}
beforeEach(() => {
  vi.clearAllMocks(); vi.setSystemTime(new Date('2026-09-30T12:00:00Z')); frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('Path2D', class { moveTo() {} lineTo() {} closePath() {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  const noop = () => {}
  const context = { setTransform: noop, clearRect: noop, fillRect: noop, drawImage: mocks.draw2D, save: noop, translate: noop, scale: noop, stroke: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, arc: noop, fill: noop, putImageData: noop,
    measureText: () => ({ width: 80 }), getImageData: () => ({ data: new Uint8ClampedArray([120, 140, 100, 255]) }), createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }) }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  const range = { from: '2026-09-01', to: '2026-09-30' }
  const nodes = Array.from({ length: 8 }, (_, i) => ({ id: 'n' + i, title: '知识' + i, state: 'candidate' as const, kind: 'document', features: ['日期山群'], links: [], ownerSpecificity: 'unknown' as const, confidentiality: 'unknown' as const, classificationReason: '', epistemic: 'reported' as const, speaker: null, conditions: [], limits: [], evidence: [],
    sourceGroups: [{ groupId: 'g' + i, groupVersion: '1', priority: 1, dates: [i < 2 ? '2026-09-29' : '2026-09-10'] }] }))
  const snapshot: Snapshot = { schema: 'notemd.strata/snapshot/v1', vaultKey: 'vault-fixture', snapshotId: 'snapshot', configHash: 'config', asOf: range.to, range, nodes, relations: [], files: [], job: null,
    coverage: { indexed: 8, selected: 8, processed: 0, candidate: 8, excluded: 0, stale: 0, proofDeferred: 0, dateInferred: 0, confidential: 0, unknownConfidentiality: 8 } }
  window.notemd = { request: vi.fn(async (method: string) => {
    if (method === 'host.settings.get') return { settings: { browser: { ...range, view: '3d' } } }
    if (method === 'host.agent.providers') return { providers: [] }
    if (method === 'plugin.snapshot') return snapshot
    if (method === 'plugin.atlas.load') return { atlas: null }
    if (method === 'host.index.status') return { valid: true }
    return {}
  }) }
  let engine: TerrainEngine
  mocks.build.mockImplementation(async (input: TerrainInputNode[], epoch: string, selection: TerrainSelection, _options: unknown, previous?: Atlas) => {
    engine = new TerrainEngine(buildAtlas(input, epoch, previous)); return engine.render(selection, { width: 64, height: 64, contourStep: 12 })
  })
  mocks.render.mockImplementation(async (selection: TerrainSelection) => engine.render(selection, { width: 64, height: 64, contourStep: 12 }))
})
afterEach(async () => { if (app) await unmount(app); app = undefined; document.body.innerHTML = ''; delete window.notemd; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('redraws the field and cluster counts after near-30 → near-7, and paints when switching 3D → 2D without camera input', async () => {
  app = mount(App, { target: document.body }); await flush()
  expect(document.querySelector('.map-label small')?.textContent).toBe('8 个索引候选')
  const firstField = mocks.draw3D.mock.calls.at(-1)?.[0].field
  const shortcut = document.querySelector<HTMLSelectElement>('[aria-label="日期快捷范围"]')!
  shortcut.value = '7'; shortcut.dispatchEvent(new Event('change', { bubbles: true })); await flush()
  expect(mocks.build.mock.calls.at(-1)?.[2]).toMatchObject({ from: '2026-09-24', to: '2026-09-30' })
  expect(document.querySelector('.status')?.textContent).toContain('2 篇')
  expect(document.querySelector('.map-label small')?.textContent).toBe('2 个索引候选')
  expect(mocks.draw3D.mock.calls.at(-1)?.[0].field).not.toEqual(firstField)
  const draws = mocks.draw2D.mock.calls.length
  ;[...document.querySelectorAll('button')].find(button => button.textContent === '等高线')!.click(); await flush()
  expect(mocks.draw2D.mock.calls.length).toBeGreaterThan(draws)
})
