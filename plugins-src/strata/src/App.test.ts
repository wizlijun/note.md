// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import App from './App.svelte'
import type { Snapshot } from './lib/types'
const mocks = vi.hoisted(() => ({ build: vi.fn(), render: vi.fn(), cancel: vi.fn(), dispose: vi.fn() }))
vi.mock('./lib/worker-client', () => ({ TerrainWorkerClient: class { build = mocks.build; render = mocks.render; cancel = mocks.cancel; dispose = mocks.dispose } }))
const range = { from: '2026-09-01', to: '2026-09-30' }
function snapshot(id = 'fixture'): Snapshot { return { schema: 'notemd.strata/snapshot/v1', vaultKey: 'vault-fixture', snapshotId: id, configHash: 'config', asOf: '2026-09-30', range, nodes: [], relations: [], files: [], coverage: { indexed: 0, selected: 0, processed: 0, candidate: 0, excluded: 0, stale: 0, proofDeferred: 0, dateInferred: 0, confidential: 0, unknownConfidentiality: 0 }, job: null } }
let app: ReturnType<typeof mount>
let request: ReturnType<typeof vi.fn<(method: string, params?: unknown) => Promise<any>>>
const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await tick() } }
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  mocks.build.mockImplementation(async (nodes, epoch) => ({ field: new Float32Array(4), grid: { width: 2, height: 2, bounds: { x: 0, y: 0, width: 1, height: 1 } }, contours: [], levels: [], peakAnchors: [], layout: { version: 'v1', epoch, worldSize: 1, nodes, domains: [], topics: [], idf: {}, diagnostics: { graphEdges: 0, crowdedNodes: 0, rebuildSuggested: false, elapsedMs: 0 } }, visibleIds: nodes.map((n: { id: string }) => n.id), masses: new Float32Array(nodes.length), stats: { contoursTruncated: false, unresolvedPeaks: 0 } }))
  request = vi.fn(async (method: string) => {
    if (method === 'host.settings.get') return { settings: { browser: { ...range, view: '2d' } } }
    if (method === 'host.agent.providers') return { providers: [{ id: 'mock', name: 'Fixture Agent', harness: { ok: true, capabilities: { tasks: ['strata-extract-v1'], terminal_result: true, input_only_isolation: true } } }], default: 'mock' }
    if (method === 'plugin.snapshot') return snapshot()
    if (method === 'plugin.atlas.load') return { atlas: null }
    if (method === 'host.index.status') return { valid: true }
    if (method === 'plugin.extract') return { id: 'job', state: 'running', processed: 0, selected: 1 }
    return {}
  })
  window.notemd = { request }
})
afterEach(async () => { if (app) await unmount(app); document.body.innerHTML = ''; delete window.notemd; vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('opens metadata without sending source text and starts only an explicit scoped budget', async () => {
  app = mount(App, { target: document.body }); await flush()
  expect(request.mock.calls.filter(c => c[0] === 'plugin.extract')).toHaveLength(0)
  button('设置').click(); await tick(); button('开始深读').click(); await flush()
  expect(request).toHaveBeenCalledWith('plugin.extract', { ...range, harness: 'mock', budget: { maxFiles: 120, maxBytes: 2097152, maxSeconds: 1800 }, includeConfidential: false })
})
it('strips quotes and evidence before worker and atlas persistence', async () => {
  const data = snapshot(); data.nodes = [{ id: 'n', title: 'fixture', state: 'verified', kind: 'insight', features: ['fixture'], links: [], ownerSpecificity: 'owner_specific', confidentiality: 'unknown', classificationReason: 'private reason', epistemic: 'reported', speaker: null, conditions: [], limits: [], sourceGroups: [{ groupId: 'g', groupVersion: 'v', priority: 1, dates: [range.to] }], evidence: [{ id: 'e', sourceId: 's', path: 'private.md', contentHash: 'h', blockKey: 'b', lineStart: 1, lineEnd: 1, quote: 'do not persist in layout' }] }]
  const base = request.getMockImplementation()!; request.mockImplementation((m: string) => m === 'plugin.snapshot' ? Promise.resolve(data) : base(m))
  app = mount(App, { target: document.body }); await flush()
  expect(mocks.build.mock.calls[0][0][0]).not.toHaveProperty('evidence')
  expect(JSON.stringify(request.mock.calls.find(c => c[0] === 'plugin.atlas.save'))).not.toContain('do not persist')
})
it('rejects a reversed date before requesting a new snapshot', async () => {
  app = mount(App, { target: document.body }); await flush(); const count = request.mock.calls.filter(c => c[0] === 'plugin.snapshot').length
  const from = document.querySelector<HTMLInputElement>('[aria-label="开始日期"]')!; from.value = '2026-10-01'; from.dispatchEvent(new Event('input', { bubbles: true })); from.dispatchEvent(new Event('change', { bubbles: true })); await flush()
  expect(request.mock.calls.filter(c => c[0] === 'plugin.snapshot')).toHaveLength(count)
  expect(document.body.textContent).toContain('开始日期不能晚于结束日期')
})
it('clears prior knowledge when permission is withdrawn on window focus', async () => {
  app = mount(App, { target: document.body }); await flush()
  const base = request.getMockImplementation()!; request.mockImplementation((m: string) => m === 'host.index.status' ? Promise.resolve({ valid: false, reason: 'CAPABILITY_DENIED' }) : base(m))
  window.dispatchEvent(new Event('focus')); await flush()
  expect(document.body.textContent).toContain('索引访问权限已撤回')
  expect(document.querySelector('button[aria-controls="strata-directory"]')?.hasAttribute('disabled')).toBe(true)
  expect(mocks.cancel).toHaveBeenCalled()
})
it('ignores an older snapshot response after the user changes dates again', async () => {
  app = mount(App, { target: document.body }); await flush()
  const pending: ((value: Snapshot) => void)[] = [], base = request.getMockImplementation()!
  request.mockImplementation((m: string) => m === 'plugin.snapshot' ? new Promise<Snapshot>(resolve => pending.push(resolve)) : base(m))
  const from = document.querySelector<HTMLInputElement>('[aria-label="开始日期"]')!
  const change = async (value: string) => { from.value = value; from.dispatchEvent(new Event('input', { bubbles: true })); from.dispatchEvent(new Event('change', { bubbles: true })); await flush() }
  await change('2026-09-10'); await change('2026-09-20')
  expect(pending).toHaveLength(2)
  pending[1](snapshot('new')); await flush(); const count = mocks.build.mock.calls.length
  pending[0](snapshot('old')); await flush()
  expect(mocks.build.mock.calls).toHaveLength(count)
  expect(mocks.build.mock.calls.at(-1)?.[2].from).toBe('2026-09-20')
})
it('does not let an older atlas-load rejection overwrite a newer date result', async () => {
  let rejectOld: (reason: Error) => void = () => {}, count = 0
  const base = request.getMockImplementation()!
  request.mockImplementation((m: string) => m === 'plugin.atlas.load' && count++ === 0 ? new Promise((_resolve, reject) => { rejectOld = reject }) : base(m))
  app = mount(App, { target: document.body }); await flush()
  const from = document.querySelector<HTMLInputElement>('[aria-label="开始日期"]')!
  from.value = '2026-09-20'; from.dispatchEvent(new Event('input', { bubbles: true })); from.dispatchEvent(new Event('change', { bubbles: true })); await flush()
  const builds = mocks.build.mock.calls.length
  rejectOld(new Error('old layout failed')); await flush()
  expect(mocks.build.mock.calls).toHaveLength(builds)
  expect(mocks.build.mock.calls.at(-1)?.[2].from).toBe('2026-09-20')
  expect(document.body.textContent).not.toContain('old layout failed')
})

it('clears a prior layout-save warning after a successful retry', async () => {
  const base = request.getMockImplementation()!; let failSave = true
  request.mockImplementation((m: string) => m === 'plugin.atlas.save' && failSave ? Promise.reject(new Error('layout save failed')) : base(m))
  app = mount(App, { target: document.body }); await flush()
  expect(document.body.textContent).toContain('地图布局未保存')
  failSave = false; button('刷新').click(); await flush()
  expect(document.body.textContent).not.toContain('地图布局未保存')
})
it('clears the index-refresh notice after the replacement terrain is ready', async () => {
  app = mount(App, { target: document.body }); await flush()
  const base = request.getMockImplementation()!
  request.mockImplementation((m: string) => m === 'host.index.status' ? Promise.resolve({ valid: false, reason: 'SOURCE_CHANGED' }) : base(m))
  window.dispatchEvent(new Event('focus')); await flush()
  expect(mocks.build).toHaveBeenCalledTimes(2)
  expect(document.body.textContent).not.toContain('正在更新地图')
})
