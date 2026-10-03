// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import App from './App.svelte'
import { difference, fixture, focusFixture, versions } from './lib/test-fixture'
import type { Snapshot, State } from './lib/types'

let app: ReturnType<typeof mount>
let current: State
let request: ReturnType<typeof vi.fn<(method: string, params?: unknown) => Promise<unknown>>>
const flush = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); await tick() } }
const button = (name: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === name)!
const mountApp = async () => { app = mount(App, { target: document.body }); await flush() }
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  current = { vaultKey: 'fixture', snapshot: fixture(), job: null, pending: false, historyAvailable: true }
  request = vi.fn(async (method, params) => {
    if (method === 'plugin.state') return current
    if (method === 'plugin.generate') return { id: 'job', state: 'running', phase: 'parsing', message: '正在解析材料', processed: 1, total: 10 }
    if (method === 'plugin.cancel') return { id: 'job', state: 'cancelled', phase: 'cancelled', message: '', processed: 1, total: 10 }
    if (method === 'plugin.history') return { versions }
    if (method === 'plugin.read_version') { const data = fixture((params as { commit: string }).commit); data.nodes[0].label = '纸船构思'; return { snapshot: data } }
    if (method === 'plugin.diff') return difference
    if (method === 'plugin.open_source') return { path: 'fixture/research.md', locator: { start: 7, end: 11 } }
    if (method === 'host.editor.open') return { ok: true }
    return null
  })
  window.notemd = { request }
})
afterEach(async () => { if (app) await unmount(app); document.body.innerHTML = ''; delete window.notemd; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('opens a genuine empty state without generating or injecting demo nodes', async () => {
  current.snapshot = null
  await mountApp()
  expect(document.body.textContent).toContain('从你的材料开始一座城')
  expect(document.body.textContent).not.toContain('纸船计划')
  expect(request).not.toHaveBeenCalledWith('plugin.generate', expect.anything())
})
it('starts a background parse only after a click and exposes cancellation', async () => {
  await mountApp(); button('重新解析').click(); await flush()
  expect(request).toHaveBeenCalledWith('plugin.generate', { windowDays: 30 })
  expect(document.body.textContent).toContain('正在解析材料')
  button('取消').click(); await flush()
  expect(request).toHaveBeenCalledWith('plugin.cancel', {})
  expect(document.body.textContent).toContain('本次解析已取消')
})
it('filters by alias and secondary topic without mutating the saved layout', async () => {
  const before = JSON.stringify(current.snapshot!.layout); await mountApp()
  const input = document.querySelector<HTMLInputElement>('[aria-label="搜索概念与别名"]')!
  input.value = 'Paperboat'; input.dispatchEvent(new Event('input', { bubbles: true })); await flush()
  expect(document.querySelectorAll('.node-row')).toHaveLength(1)
  expect(document.querySelector('.node-row')?.textContent).toContain('纸船计划')
  input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }))
  const select = document.querySelector<HTMLSelectElement>('[aria-label="筛选主题"]')!
  select.value = 't1'; select.dispatchEvent(new Event('change', { bubbles: true })); await flush()
  expect(document.querySelectorAll('.node-row')).toHaveLength(2)
  expect(JSON.stringify(current.snapshot!.layout)).toBe(before)
})
it('verifies an evidence locator before opening a source and withholds failed verification', async () => {
  await mountApp(); (document.querySelector('.node-row') as HTMLButtonElement).click(); await flush()
  const base = request.getMockImplementation()!
  request.mockImplementation((m, p) => m === 'plugin.open_source' ? Promise.reject(new Error('来源版本已变化')) : base(m, p))
  button('核对并打开原文 ↗').click(); await flush()
  expect(document.body.textContent).toContain('来源版本已变化')
  expect(request.mock.calls.some(c => c[0] === 'host.editor.open')).toBe(false)
  request.mockImplementation(base); button('核对并打开原文 ↗').click(); await flush()
  expect(request).toHaveBeenCalledWith('plugin.open_source', { evidenceId: 'e1' })
  expect(request).toHaveBeenCalledWith('host.editor.open', { path: 'fixture/research.md' })
})
it('opens historical snapshots read-only and compares semantic changes', async () => {
  await mountApp(); button('历史').click(); await flush()
  const rows = document.querySelectorAll<HTMLButtonElement>('.version-row'); rows[1].click(); await flush()
  expect(document.body.textContent).toContain('正在只读浏览历史')
  expect(document.body.textContent).toContain('纸船构思')
  button('查看结构变化').click(); await flush()
  expect(request).toHaveBeenCalledWith('plugin.diff', { fromCommit: 'commit-old' })
  expect(document.body.textContent).toContain('纸船构思 → 纸船计划')
  expect(document.body.textContent).toContain('地块变化 0')
  button('返回当前结构').click(); await flush()
  expect(document.querySelector('.historical-bar')).toBeNull()
  expect(request.mock.calls.some(c => ['host.vault.write', 'plugin.generate'].includes(c[0]))).toBe(false)
})
it('ignores a late history response after returning to current structure', async () => {
  let resolveOld: (value: { snapshot: Snapshot }) => void = () => {}
  const base = request.getMockImplementation()!
  request.mockImplementation((m, p) => m === 'plugin.read_version' ? new Promise(resolve => resolveOld = resolve) : base(m, p))
  await mountApp(); button('历史').click(); await flush(); document.querySelector<HTMLButtonElement>('.version-row')!.click(); await flush()
  button('当前结构').click(); await flush()
  const old = fixture('stale'); old.nodes[0].label = '不应出现的旧结果'; resolveOld({ snapshot: old }); await flush()
  expect(document.body.textContent).not.toContain('不应出现的旧结果')
  expect(document.querySelector('.historical-bar')).toBeNull()
})
it('discloses truncated history without implying that older Git versions were lost', async () => {
  const base = request.getMockImplementation()!
  let truncated = true
  request.mockImplementation((m, p) => m === 'plugin.history' ? Promise.resolve({ versions, truncated }) : base(m, p))
  await mountApp(); button('历史').click(); await flush()
  const notice = '这里只显示最近100个结构版本；更早版本仍保存在Vault的Git历史中'
  expect(document.body.textContent).toContain(notice)
  document.querySelector<HTMLButtonElement>('[aria-label="关闭历史"]')!.click(); truncated = false
  button('历史').click(); await flush()
  expect(document.body.textContent).not.toContain(notice)
})
it('retries pending persistence without generating over the previous result', async () => {
  current.pending = true; const base = request.getMockImplementation()!
  request.mockImplementation((m, p) => { if (m === 'plugin.retry_save') { current = { ...current, pending: false }; return Promise.resolve({ status: 'saved' }) } return base(m, p) })
  await mountApp(); button('重试保存').click(); await flush()
  expect(request).toHaveBeenCalledWith('plugin.retry_save', {})
  expect(request.mock.calls.some(c => c[0] === 'plugin.generate')).toBe(false)
  expect(document.body.textContent).not.toContain('尚未完成 Git 保存')
})
it('clears old Vault knowledge when access is no longer available', async () => {
  await mountApp(); const base = request.getMockImplementation()!
  request.mockImplementation((m, p) => m === 'plugin.state' ? Promise.reject(new Error('Vault 权限不可用')) : base(m, p))
  window.dispatchEvent(new Event('focus')); await flush()
  expect(document.body.textContent).not.toContain('纸船计划')
  expect(document.body.textContent).toContain('Vault 权限不可用')
})
it('archives a pending draft before starting a replacement parse', async () => {
  current.pending = true; const base = request.getMockImplementation()!
  request.mockImplementation((m, p) => { if (m === 'plugin.discard_pending') { current = { ...current, pending: false }; return Promise.resolve({ status: 'archived' }) } return base(m, p) })
  await mountApp(); button('保留草稿并重新解析').click(); await flush()
  const methods = request.mock.calls.map(c => c[0])
  expect(methods.indexOf('plugin.discard_pending')).toBeLessThan(methods.indexOf('plugin.generate'))
})
it('does not start a replacement parse in a Vault switched during draft recovery', async () => {
  current.pending = true; const base = request.getMockImplementation()!
  let finishArchive: (value: unknown) => void = () => {}
  request.mockImplementation((m, p) => m === 'plugin.discard_pending' ? new Promise(resolve => finishArchive = resolve) : base(m, p))
  await mountApp(); button('保留草稿并重新解析').click(); await flush()
  current = { ...current, vaultKey: 'different-vault', pending: false, snapshot: null }
  finishArchive({ status: 'archived' }); await flush()
  expect(request.mock.calls.some(c => c[0] === 'plugin.generate')).toBe(false)
  expect(document.body.textContent).not.toContain('纸船计划')
})
it('loads the saved result after the background job completes', async () => {
  vi.useFakeTimers()
  const base = request.getMockImplementation()!
  request.mockImplementation((m, p) => {
    if (m === 'plugin.job') { const next = fixture('next'); next.nodes[0].label = '解析后的新结果'; current = { ...current, snapshot: next, job: { id: 'job', state: 'complete', phase: 'saved', message: '完成', processed: 10, total: 10 } }; return Promise.resolve(current.job) }
    return base(m, p)
  })
  await mountApp(); button('重新解析').click(); await flush()
  await vi.advanceTimersByTimeAsync(1500); await flush()
  expect(document.body.textContent).toContain('解析后的新结果')
  expect(document.querySelector('.job-bar')).toBeNull()
})
it('keeps an unsaved preview separate from current and historical versions', async () => {
  const preview = fixture('preview'); preview.nodes[0].label = '尚未保存的新结构'
  current.preview = preview
  await mountApp(); expect(document.body.textContent).not.toContain('尚未保存的新结构')
  button('查看未保存预览').click(); await flush()
  expect(document.body.textContent).toContain('尚未保存的新结构')
  expect(document.querySelector('.historical-bar')?.textContent).toContain('未保存预览')
  document.querySelector<HTMLButtonElement>('.node-row')!.click(); await flush()
  button('核对并打开原文 ↗').click(); await flush()
  expect(request).toHaveBeenCalledWith('plugin.open_source', { evidenceId: 'e1', preview: true })
  button('返回当前结构').click(); await flush()
  expect(document.querySelector('.node-row')?.textContent).toContain('纸船计划')
})
it('labels the local read-only preview and never pretends to open a source', async () => {
  current = { ...current, snapshot: null, preview: fixture(), historyAvailable: false, readOnlyPreview: true }
  const base = request.getMockImplementation()!
  request.mockImplementation((m, p) => m === 'plugin.open_source' ? Promise.reject(new Error('本地预览仅显示来源路径和定位信息')) : base(m, p))
  await mountApp()
  expect(document.querySelector('.historical-bar')?.textContent).toContain('只读预览 · 未存入 Vault')
  expect(document.querySelector('.node-row')?.textContent).toContain('纸船计划')
  expect(button('历史').disabled).toBe(false)
  document.querySelector<HTMLButtonElement>('.node-row')!.click(); await flush()
  button('核对并打开原文 ↗').click(); await flush()
  expect(document.body.textContent).toContain('本地预览仅显示来源路径和定位信息')
  expect(request.mock.calls.some(c => c[0] === 'host.editor.open')).toBe(false)
})

it('browses keyword communities without listing sources or topic containers as keywords', async () => {
  const snapshot = current.snapshot!
  snapshot.meta.algorithm.version = 'habitat-keyword/2'
  snapshot.nodes[0].nodeType = snapshot.nodes[1].nodeType = 'keyword'
  snapshot.memberships = [{ id: 'm', node: 'n1', topic: 't1', role: 'primary', score: 1 }]
  snapshot.edges[0].edgeType = 'co_occurs'; snapshot.edges[0].status = 'statistical'
  await mountApp()
  expect(document.querySelectorAll('.node-row')).toHaveLength(2)
  expect(document.querySelector('.section-title')?.textContent).toContain('2 个关键词')
  document.querySelector<HTMLButtonElement>('.node-row')!.click(); await flush()
  expect(document.querySelector('.detail-panel')?.textContent).toContain('统计共现')
  expect(document.querySelector('.detail-panel')?.textContent).toContain('不自动推断因果')
  document.querySelector<HTMLButtonElement>('.memberships button')!.click(); await flush()
  expect(document.querySelectorAll('.node-row')).toHaveLength(1)
  expect(document.querySelector('.node-row')?.textContent).toContain('纸船计划')
  expect(document.querySelector('.detail-panel')).toBeNull()
})

it('defaults to recent attention, ranks by score and explains dated observations without claiming mastery', async () => {
  current.snapshot = focusFixture()
  await mountApp()
  const rows = document.querySelectorAll<HTMLButtonElement>('.node-row')
  expect(rows).toHaveLength(2)
  expect(rows[0].textContent).toContain('观察与反馈')
  expect(rows[1].classList.contains('context-word')).toBe(true)
  expect(document.body.textContent).toContain('最近 30 天')
  expect(document.body.textContent).not.toContain('十年前的旧主题')
  rows[0].click(); await flush()
  expect(document.querySelector('.attention-detail')?.textContent).toContain('5 个活跃日 · 7 次记录事件')
  expect(document.querySelector('.attention-detail')?.textContent).toContain('不表示掌握程度')
  expect(document.querySelector('.evidence-date')?.textContent).toContain('2026-10-01')
  expect(document.querySelector('.evidence-date')?.textContent).toContain('本人笔记')
  button('历史结构').click(); await flush()
  expect(document.querySelectorAll('.node-row')).toHaveLength(3)
  expect(document.body.textContent).toContain('十年前的旧主题')
  expect(document.querySelector('.detail-panel')).toBeNull()
  button('近期关注').click(); await flush()
  expect(document.querySelectorAll('.node-row')).toHaveLength(2)
  expect(request.mock.calls.some(call => call[0] === 'plugin.generate')).toBe(false)
})
it('changes the next generation window without relabelling the saved attention window', async () => {
  current.snapshot = focusFixture()
  await mountApp()
  const select = document.querySelector<HTMLSelectElement>('[aria-label="下次解析关注范围"]')!
  select.value = '7'; select.dispatchEvent(new Event('change', { bubbles: true })); await flush()
  expect(document.querySelector('.focus-window')?.textContent).toContain('最近 30 天')
  button('重新解析').click(); await flush()
  expect(request).toHaveBeenCalledWith('plugin.generate', { windowDays: 7 })
})
it('keeps old snapshots explicit and does not treat a computed empty focus as missing history', async () => {
  current.snapshot = focusFixture(); current.snapshot.attention = []
  await mountApp()
  expect(document.querySelectorAll('.node-row')).toHaveLength(0)
  expect(document.body.textContent).toContain('这段时间还没有足够的关注线索')
  button('历史结构').click(); await flush()
  expect(document.querySelectorAll('.node-row')).toHaveLength(3)
})

it('names recent membership chips from visible concepts while retaining the original community identity', async () => {
  current.snapshot = focusFixture()
  current.snapshot.memberships = [{ id: 'm', node: 'n2', topic: 't1', role: 'primary', score: 1 }]
  await mountApp(); document.querySelector<HTMLButtonElement>('.node-row')!.click(); await flush()
  const chip = document.querySelector<HTMLButtonElement>('.memberships button')!
  expect(chip.textContent).toContain('观察与反馈')
  expect(chip.title).toBe('原社区：研究方法')
  button('历史结构').click(); await flush()
  ;[...document.querySelectorAll<HTMLButtonElement>('.node-row')].find(row => row.textContent?.includes('观察与反馈'))!.click(); await flush()
  expect(document.querySelector('.memberships button')?.textContent).toContain('研究方法')
})

it('shows evidence-derived building level independently from the recent attention score', async () => {
  current.snapshot = focusFixture()
  current.snapshot.attention![1].score = 1
  await mountApp()
  const row = [...document.querySelectorAll<HTMLButtonElement>('.node-row')].find(row => row.textContent?.includes('观察与反馈'))!
  row.click(); await flush()
  expect(document.querySelector('.growth-badge')?.textContent).toContain('茅草屋')
  expect(document.querySelectorAll('.growth-meter .filled')).toHaveLength(1)
  expect(document.querySelector('[aria-label="建筑成长依据"]')?.textContent).toContain('0 组含本人主动记录')
  expect(document.querySelector('[aria-label="近期关注依据"]')?.textContent).toContain('100 / 100')
  button('历史结构').click(); await flush()
  ;[...document.querySelectorAll<HTMLButtonElement>('.node-row')].find(row => row.textContent?.includes('观察与反馈'))!.click(); await flush()
  expect(document.querySelectorAll('.growth-meter .filled')).toHaveLength(1)
})

it('loads both frozen versions for genuine rebuilding and removes that state in another version', async () => {
  const after = focusFixture(), before = focusFixture()
  before.meta.snapshotId = 'old'
  after.memberships = [{ id:'m', node:'n2', topic:'t1', role:'primary', score:1 }]
  before.nodes.push({ id:'t0', key:'t0', label:'先前社区', nodeType:'topic', status:'observed' })
  before.memberships = [{ id:'m', node:'n2', topic:'t0', role:'primary', score:1 }]
  current.snapshot = after
  const base = request.getMockImplementation()!
  request.mockImplementation((method, params) => method === 'plugin.read_version'
    ? Promise.resolve({ snapshot: (params as { commit:string }).commit === 'commit-old' ? before : after }) : base(method, params))
  await mountApp()
  ;[...document.querySelectorAll<HTMLButtonElement>('.node-row')].find(row => row.textContent?.includes('观察与反馈'))!.click(); await flush()
  button('历史').click(); await flush(); button('查看结构变化').click(); await flush()
  expect(document.querySelector('.growth-badge')?.textContent).toContain('结构重建')
  expect(document.querySelector('[aria-label="版本差异"]')?.textContent).toContain('建筑的生长与重建')
  document.querySelectorAll<HTMLButtonElement>('.version-row')[1].click(); await flush()
  expect(document.querySelector('.growth-badge')?.textContent).not.toContain('结构重建')
  expect(request.mock.calls.some(c => ['plugin.generate','host.vault.write'].includes(c[0]))).toBe(false)
})

function conceptSnapshot() {
  const data = focusFixture(); data.meta.algorithm.version = 'habitat-focus/4'
  data.nodes[0] = { ...data.nodes[0], nodeType: 'project', status: 'observed', intentStatus: 'declared_project' }
  data.nodes.push({ id:'person', key:'person', nodeType:'person', label:'原文中的人物', status:'observed', evidence:['e1'] }, { id:'tool', key:'tool', nodeType:'tool', label:'原文中的工具', status:'observed', evidence:['e1'] })
  data.attention!.push({ ...data.attention![0], node:'person', score:1 }, { ...data.attention![0], node:'tool', score:.9 })
  data.edges = [
    { ...data.edges[0], id:'statement', edgeType:'depends_on', status:'asserted', evidence:['e2'], participants:[{node:'n2',role:'subject'},{node:'n1',role:'object'}] },
    { ...data.edges[0], id:'statistics', edgeType:'co_discussed', status:'statistical' },
    { ...data.edges[0], id:'person-link', participants:[{node:'n2',role:'source'},{node:'person',role:'target'}] },
    { ...data.edges[0], id:'imported-claim', edgeType:'is_a', status:'imported' },
  ]
  return data
}

it.each([4, 5, 6])('defaults focus/%i to concepts and projects and exposes background sources without reclassification', async version => {
  current.snapshot = conceptSnapshot(); current.snapshot.meta.algorithm.version = `habitat-focus/${version}`; const original = JSON.stringify(current.snapshot)
  await mountApp()
  expect([...document.querySelectorAll('.node-row strong')].map(n=>n.textContent)).toEqual(['观察与反馈','纸船计划'])
  expect(document.querySelector('.section-title')?.textContent).toContain('个概念 / 项目')
  expect(document.querySelector('.focus-window')?.textContent).not.toContain('历史概念为自动识别结果')
  const project = [...document.querySelectorAll<HTMLButtonElement>('.node-row')].find(n=>n.textContent?.includes('纸船计划'))!
  expect(project.textContent).toContain('项目 · 2 天')
  expect(project.classList.contains('context-word')).toBe(false)
  project.click(); await flush()
  expect(document.querySelector('.detail-panel')?.textContent).toContain('明确项目声明')
  const layer = document.querySelector<HTMLSelectElement>('[aria-label="知识层"]')!
  layer.value='background'; layer.dispatchEvent(new Event('change',{bubbles:true})); await flush()
  expect(document.querySelector('.detail-panel')).toBeNull()
  expect([...document.querySelectorAll('.node-row strong')].map(n=>n.textContent)).toEqual(['原文中的人物','原文中的工具'])
  document.querySelector<HTMLButtonElement>('.node-row')!.click(); await flush()
  expect(document.querySelector('.detail-panel')?.textContent).toContain('背景层 · 人物')
  expect(document.querySelector('.growth-badge')).toBeNull()
  button('核对并打开原文 ↗').click(); await flush()
  expect(request).toHaveBeenCalledWith('plugin.open_source', {evidenceId:'e1'})
  expect(request).toHaveBeenCalledWith('host.editor.open', {path:'fixture/research.md'})
  layer.value='all'; layer.dispatchEvent(new Event('change',{bubbles:true})); await flush()
  expect(document.querySelectorAll('.node-row')).toHaveLength(4)
  button('历史结构').click(); await flush()
  expect(document.querySelectorAll('.node-row')).toHaveLength(5)
  expect(document.querySelector('.focus-window')?.textContent).toBe('历史概念为自动识别结果，可回源核对。')
  expect(JSON.stringify(current.snapshot)).toBe(original)
})

it('starts roads with textual statements, optionally adds statistics and preserves selected concept evidence', async () => {
  current.snapshot = conceptSnapshot(); await mountApp()
  expect(document.querySelector('.directory-footer')?.textContent).toContain('1 条关系')
  document.querySelector<HTMLButtonElement>('.node-row')!.click(); await flush()
  const cards = [...document.querySelectorAll('.relation-card')]
  expect(cards[0].textContent).toContain('原文陈述')
  expect(cards[0].textContent).toContain('观察与反馈 → 依赖 → 纸船计划')
  expect(cards[0].textContent).toContain('不等于已核实的客观事实')
  expect(cards.find(card => card.textContent?.includes('重复共同讨论'))?.textContent).toContain('统计关联')
  expect(cards[3].textContent).toContain('导入候选')
  expect(document.querySelector('.detail-panel')?.textContent).not.toContain('subject')
  button('核对关系原文 ↗').click(); await flush()
  expect(request).toHaveBeenCalledWith('plugin.open_source', {evidenceId:'e2'})
  const statistics=document.querySelector<HTMLInputElement>('[aria-label="包含统计关联"]')!
  expect(statistics.checked).toBe(false); statistics.click(); await flush()
  expect(document.querySelector('.directory-footer')?.textContent).toContain('2 条关系')
  expect(document.querySelector('.detail-panel h2')?.textContent).toBe('观察与反馈')
  button('历史结构').click(); await flush()
  expect(document.querySelector('.detail-panel h2')?.textContent).toBe('观察与反馈')
  const personLink=[...document.querySelectorAll<HTMLButtonElement>('.relation-card button')].find(n=>n.textContent?.includes('原文中的人物'))!
  personLink.click(); await flush()
  expect(document.querySelector('.detail-panel h2')?.textContent).toBe('原文中的人物')
  expect(document.querySelector('.evidence-path')?.textContent).toBe('fixture/research.md')
  expect(document.querySelectorAll('.node-row')).toHaveLength(3)
})

it('does not add concept-layer or road-certainty controls to an older keyword snapshot', async () => {
  current.snapshot=focusFixture(); await mountApp()
  expect(document.querySelector('[aria-label="知识层"]')).toBeNull()
  expect(document.querySelector('[aria-label="包含统计关联"]')).toBeNull()
  expect(document.querySelector('.section-title')?.textContent).toContain('2 个关键词')
})

it('handles empty and single background layers across recent and history without losing source access', async () => {
  const data=focusFixture();data.meta.algorithm.version='habitat-focus/4'
  data.nodes.push({id:'person',key:'person',nodeType:'person',label:'历史人物条目',status:'observed',evidence:['e1']})
  current.snapshot=data;await mountApp()
  const layer=document.querySelector<HTMLSelectElement>('[aria-label="知识层"]')!
  layer.value='background';layer.dispatchEvent(new Event('change',{bubbles:true}));await flush()
  expect(document.querySelectorAll('.node-row')).toHaveLength(0)
  expect(document.querySelector('.empty-overlay')?.textContent).toContain('本层近期没有足够的关注线索')
  button('历史结构').click();await flush()
  expect(document.querySelectorAll('.node-row')).toHaveLength(1)
  expect(document.querySelector('.empty-overlay')).toBeNull()
  document.querySelector<HTMLButtonElement>('.node-row')!.click();await flush()
  expect(document.querySelector('.detail-panel h2')?.textContent).toBe('历史人物条目')
  expect(document.querySelector('.growth-badge')).toBeNull()
  button('核对并打开原文 ↗').click();await flush()
  expect(request).toHaveBeenCalledWith('plugin.open_source',{evidenceId:'e1'})
  const search=document.querySelector<HTMLInputElement>('[aria-label="搜索节点与别名"]')!
  search.value='不存在的搜索词';search.dispatchEvent(new Event('input',{bubbles:true}));await flush()
  expect(document.querySelector('.empty-overlay')?.textContent).toContain('本层没有匹配的节点')
  layer.value='main';layer.dispatchEvent(new Event('change',{bubbles:true}));await flush()
  expect(document.querySelectorAll('.node-row')).toHaveLength(3)
  expect(document.querySelector('.detail-panel')).toBeNull()
  button('近期关注').click();await flush()
  expect(document.querySelectorAll('.node-row')).toHaveLength(2)
})
