// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import App from './App.svelte'
import type { Snapshot } from './lib/types'
const mocks = vi.hoisted(() => ({ build: vi.fn(), render: vi.fn(), cancel: vi.fn(), dispose: vi.fn(), parseMeetings: vi.fn() }))
vi.mock('./lib/worker-client', () => ({ TerrainWorkerClient: class { build = mocks.build; render = mocks.render; cancel = mocks.cancel; dispose = mocks.dispose } }))
vi.mock('./lib/meetings-client', () => ({ parseMeetingSnapshot: mocks.parseMeetings }))
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

const chooseDataset = async (value: string) => {
  const select = document.querySelector<HTMLSelectElement>('[aria-label="数据集"]')!
  select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); await flush()
}
function meetingSnapshot(): Snapshot {
  return { ...snapshot('meetings'), meetings: { datasetKey: 'meetings-only', datasets: 1, missingKnowledge: 0, invalidFiles: 0, isolatedRecords: 0, relations: 0, rawRecords: 0, usableRecords: 0, dateExtent: range, diagnostics: [], diagnosticCount: 0 } }
}
it('isolates dataset layout and preferences and uses warm date filtering for meeting knowledge', async () => {
  mocks.parseMeetings.mockResolvedValue(meetingSnapshot())
  app = mount(App, { target: document.body }); await flush()
  await chooseDataset('meetings_knowledge')
  expect(request).toHaveBeenCalledWith('plugin.meetings.snapshot', {})
  expect(request).toHaveBeenCalledWith('plugin.meetings.atlas.load', { vaultKey: 'vault-fixture' })
  expect(request.mock.calls.some(c => c[0] === 'plugin.meetings.atlas.save')).toBe(true)
  expect(mocks.build.mock.calls.at(-1)![3]).toEqual(expect.objectContaining({ surface: 'meeting' }))
  expect(document.body.textContent).toContain('会议知识 ·')
  button('设置').click(); await tick()
  expect(document.body.textContent).not.toContain('开始深读')
  button('关闭设置')?.click()
  mocks.render.mockResolvedValue(await mocks.build.mock.results.at(-1)!.value)
  const from = document.querySelector<HTMLInputElement>('[aria-label="开始日期"]')!
  from.value = '2026-09-15'; from.dispatchEvent(new Event('input', { bubbles: true })); from.dispatchEvent(new Event('change', { bubbles: true })); await flush()
  expect(request.mock.calls.filter(c => c[0] === 'plugin.meetings.snapshot')).toHaveLength(1)
  expect(mocks.render).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-09-15' }), expect.objectContaining({ surface: 'meeting' }))
  await chooseDataset('vault_index')
  expect(mocks.build.mock.calls.at(-1)![3]).not.toHaveProperty('surface')
  expect(document.querySelector<HTMLInputElement>('[aria-label="开始日期"]')!.value).toBe('2026-09-01')
  await chooseDataset('meetings_knowledge')
  expect(document.querySelector<HTMLInputElement>('[aria-label="开始日期"]')!.value).toBe('2026-09-15')
  const saved = request.mock.calls.filter(c => c[0] === 'host.settings.set').at(-1)![1] as any
  expect(saved.key).toBe('datasets')
  expect(saved.value.preferences.vault_index.from).toBe('2026-09-01')
  expect(saved.value.preferences.meetings_knowledge.from).toBe('2026-09-15')
})
it('discards a late meeting dataset response after switching back to the index', async () => {
  let resolveMeeting: (input: unknown) => void = () => {}
  const base = request.getMockImplementation()!
  request.mockImplementation((method, params) => method === 'plugin.meetings.snapshot' ? new Promise(resolve => { resolveMeeting = resolve }) : base(method, params))
  mocks.parseMeetings.mockResolvedValue(meetingSnapshot())
  app = mount(App, { target: document.body }); await flush()
  await chooseDataset('meetings_knowledge'); await chooseDataset('vault_index')
  const builds = mocks.build.mock.calls.length
  resolveMeeting({}); await flush()
  expect(mocks.parseMeetings).not.toHaveBeenCalled()
  expect(mocks.build).toHaveBeenCalledTimes(builds)
  expect(document.body.textContent).not.toContain('会议知识 ·')
  expect(request.mock.calls.some(c => c[0] === 'plugin.meetings.atlas.save')).toBe(false)
})

it('does not restore a stale meeting terrain after the date becomes invalid', async () => {
  mocks.parseMeetings.mockResolvedValue(meetingSnapshot())
  app = mount(App, { target: document.body }); await flush(); await chooseDataset('meetings_knowledge')
  const oldTerrain = await mocks.build.mock.results.at(-1)!.value
  let resolveRender: (value: unknown) => void = () => {}
  mocks.render.mockImplementation(() => new Promise(resolve => { resolveRender = resolve }))
  const from = document.querySelector<HTMLInputElement>('[aria-label="开始日期"]')!
  const change = async (value: string) => { from.value = value; from.dispatchEvent(new Event('input', { bubbles: true })); from.dispatchEvent(new Event('change', { bubbles: true })); await flush() }
  await change('2026-09-10')
  const cancellations = mocks.cancel.mock.calls.length
  await change('2027-01-01')
  expect(mocks.cancel.mock.calls.length).toBeGreaterThan(cancellations)
  resolveRender(oldTerrain); await flush()
  expect(document.body.textContent).toContain('开始日期不能晚于结束日期')
  expect(document.querySelector('button[aria-controls="strata-directory"]')?.hasAttribute('disabled')).toBe(true)
})

it.each(['dataset', 'date', 'view'] as const)('does not overwrite an early %s choice when bootstrap settings arrive late', async choice => {
  let resolveSettings: (value: unknown) => void = () => {}
  const base = request.getMockImplementation()!
  request.mockImplementation((method, params) => method === 'host.settings.get' ? new Promise(resolve => { resolveSettings = resolve }) : base(method, params))
  mocks.parseMeetings.mockResolvedValue(meetingSnapshot())
  app = mount(App, { target: document.body }); await flush()
  if (choice === 'dataset') await chooseDataset('meetings_knowledge')
  else if (choice === 'date') {
    const from = document.querySelector<HTMLInputElement>('[aria-label="开始日期"]')!
    from.value = '2026-09-15'; from.dispatchEvent(new Event('input', { bubbles: true })); from.dispatchEvent(new Event('change', { bubbles: true })); await flush()
  } else { button('等高线').click(); await flush() }
  const builds = mocks.build.mock.calls.length
  resolveSettings({ settings: { browser: { ...range, view: '3d' }, datasets: { active: 'vault_index', preferences: { vault_index: { ...range, view: '3d' } } } } }); await flush()
  if (choice === 'dataset') {
    expect(document.querySelector<HTMLSelectElement>('[aria-label="数据集"]')!.value).toBe('meetings_knowledge')
    expect(request.mock.calls.some(call => call[0] === 'plugin.snapshot')).toBe(false)
  } else if (choice === 'date') expect(document.querySelector<HTMLInputElement>('[aria-label="开始日期"]')!.value).toBe('2026-09-15')
  else expect(button('等高线').getAttribute('aria-pressed')).toBe('true')
  expect(mocks.build).toHaveBeenCalledTimes(choice === 'view' ? 1 : builds)
  expect(request).toHaveBeenCalledWith('host.agent.providers', {})
})

function relationsOnlySnapshot(): Snapshot {
  const data = meetingSnapshot()
  data.files = ['2026-09-05', '2026-09-25'].map((date, i) => ({ fileKey: 'f' + i, path: `ssot/meetings/m${i}/knowledge.json`, contentHash: 'h' + i,
    tags: [], docDate: date, dateInferred: false, indexOrigin: 'derived', humanVerified: false, attentionMinutes: 0, filePriority: 1, confidentiality: 'unknown', links: [] }))
  data.relations = Array.from({ length: 715 }, (_, i) => ({ id: 'relation-' + i, source: '', target: '', type: 'related_to', title: i === 714 ? '新会议关系' : `历史关系 ${i + 1}`, evidence: [],
    participants: [{ nodeId: 's1', role: 'source' }, { nodeId: 's2', role: 'target' }],
    meeting: { datasetPath: data.files[i === 714 ? 1 : 0].path, contentHash: 'h', datasetId: 'ks_test', localId: 'r1', kind: 'relations',
      record: { id: 'r1', i: 1, why: '支持会议结构', ev: [], p: 0, type: 'related_to', args: { source: 's1', target: 's2' } },
      generated: { by: 'test', at: '2026-09-30', rule: 'relation-schema-extractor/3.1.1', types: '1.0.0' }, scope: { purpose: '分页回归', questions: [] }, evidence: [], references: [] } }))
  data.meetings!.datasets = 2; data.meetings!.relations = 715
  return data
}

it('keeps terrain detail notices in the meeting legend flow', async () => {
  mocks.parseMeetings.mockResolvedValue(meetingSnapshot())
  const build = mocks.build.getMockImplementation()!
  mocks.build.mockImplementation(async (...args) => {
    const result = await build(...args)
    return { ...result, stats: { ...result.stats, contoursTruncated: true, unresolvedPeaks: 8 } }
  })
  app = mount(App, { target: document.body }); await flush(); await chooseDataset('meetings_knowledge')
  expect(document.querySelectorAll('.detail-note')).toHaveLength(1)
  expect(document.querySelector('.legend')?.firstElementChild?.textContent).toBe('概览已简化轮廓。')
  expect(document.querySelector('.legend')?.textContent).toContain('标题为当前范围的代表词')
  expect(document.querySelectorAll('.kind-legend span')).toHaveLength(5)
})

it.each(['date', 'reload'] as const)('returns a relation-only directory to page one after %s reduces 715 records to one', async change => {
  const data = relationsOnlySnapshot()
  mocks.parseMeetings.mockResolvedValue(data)
  app = mount(App, { target: document.body }); await flush(); await chooseDataset('meetings_knowledge')
  mocks.render.mockResolvedValue(await mocks.build.mock.results.at(-1)!.value)
  button('目录').click(); await tick(); button('关系 · 715').click(); await tick(); button('下一页').click(); await tick()
  expect(document.querySelector('.directory-items')?.textContent).toContain('历史关系 51')
  if (change === 'date') {
    const from = document.querySelector<HTMLInputElement>('[aria-label="开始日期"]')!
    from.value = '2026-09-20'; from.dispatchEvent(new Event('input', { bubbles: true })); from.dispatchEvent(new Event('change', { bubbles: true }))
  } else {
    mocks.parseMeetings.mockResolvedValue({ ...data, files: [data.files[1]], relations: [data.relations[714]] })
    button('刷新').click()
  }
  await flush()
  expect(document.querySelectorAll('.directory-items button')).toHaveLength(1)
  expect(document.querySelector('.directory-items')?.textContent).toContain('新会议关系')
  expect(document.querySelector('.pagination')).toBeNull()
  button('新会议关系related_to').click(); await tick()
  expect(document.querySelector('[aria-label="会议关系详情"]')?.textContent).toContain('新会议关系')
  expect(request.mock.calls.filter(call => call[0] === 'plugin.meetings.snapshot')).toHaveLength(change === 'date' ? 1 : 2)
})


it.each([false, true])('migrates only old meeting layouts and preserves a current semantic layout (current=%s)', async current => {
  const data = meetingSnapshot()
  data.nodes = [{ id: 'concept', title: '概念原词', kind: 'concept', state: 'imported', topicTerms: ['概念原词'], topicSourceId: 'meeting-source', features: ['概念原词'], links: [], sourceGroups: [] } as unknown as Snapshot['nodes'][number]]
  mocks.parseMeetings.mockResolvedValue(data)
  const epoch = current ? 'vault-fixture:meetings_knowledge:concepts-v1:123' : 'vault-fixture:meetings_knowledge:1'
  const saved = { version: 'strata-atlas/2', epoch, nodes: [], domains: [], topics: [] }
  const base = request.getMockImplementation()!
  request.mockImplementation((method, params) => method === 'plugin.meetings.atlas.load' ? Promise.resolve({ atlas: saved }) : base(method, params))
  app = mount(App, { target: document.body }); await flush(); await chooseDataset('meetings_knowledge')
  const build = mocks.build.mock.calls.at(-1)!
  expect(build[0][0]).toEqual(expect.objectContaining({ topicTerms: ['概念原词'], topicSourceId: 'meeting-source' }))
  expect(build[1]).toBe(current ? epoch : 'vault-fixture:meetings_knowledge:concepts-v1:1')
  expect(build[4]).toEqual(current ? saved : undefined)
  if (!current) expect(button('关系').getAttribute('aria-pressed')).toBe('true')
  await chooseDataset('vault_index')
  expect(mocks.build.mock.calls.at(-1)![1]).toBe('vault-fixture:vault_index:1')
})

it('renames meeting groups from the visible date range without changing cached layout names', async () => {
  const data = meetingSnapshot()
  data.nodes = ['历史主题', '当前概念'].map((title, i) => ({ id: `c${i}`, title, kind: 'concept', state: 'imported', topicTerms: [title], topicSourceId: `m${i}`, features: [title], links: [],
    sourceGroups: [{ groupId: `g${i}`, groupVersion: 'v', priority: 1, dates: [i ? '2026-09-25' : '2026-09-05'] }] } as unknown as Snapshot['nodes'][number]))
  mocks.parseMeetings.mockResolvedValue(data)
  const build = mocks.build.getMockImplementation()!
  mocks.build.mockImplementation(async (...args) => {
    const output = await build(...args)
    return { ...output, layout: { ...output.layout, domains: [{ id: 'd', name: '全量历史缓存名称', memberIds: ['c0', 'c1'] }], topics: [] } }
  })
  app = mount(App, { target: document.body }); await flush(); await chooseDataset('meetings_knowledge')
  const original = await mocks.build.mock.results.at(-1)!.value
  mocks.render.mockResolvedValue({ ...original, visibleIds: ['c1'], clusterNames: { d: '当前概念' } })
  const from = document.querySelector<HTMLInputElement>('[aria-label="开始日期"]')!
  from.value = '2026-09-15'; from.dispatchEvent(new Event('input', { bubbles: true })); from.dispatchEvent(new Event('change', { bubbles: true })); await flush()
  button('目录').click(); await flush()
  expect(document.querySelector('.directory-items')?.textContent).toContain('当前概念')
  expect(document.querySelector('.directory-items')?.textContent).not.toContain('历史主题')
  expect(original.layout.domains[0].name).toBe('全量历史缓存名称')
  const saved = request.mock.calls.find(call => call[0] === 'plugin.meetings.atlas.save')![1] as any
  expect(saved.atlas.domains[0].name).toBe('全量历史缓存名称')
})
