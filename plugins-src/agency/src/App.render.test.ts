// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import { batchFixture, practicalBatchFixture, practicalEpisode, signal } from './lib/fixtures.test-support'
import type { Job, Scan, Snapshot } from './lib/types'
import { api } from './lib/bridge'

let component: ReturnType<typeof mount> | null = null
const providers = { providers: [{ id: 'notemd.codex-agent', name: 'Codex', harness: { ok: true, capabilities: { terminal_result: true, input_only_isolation: true, tasks: ['agency-observe-v1'] } } }], default: 'notemd.codex-agent' }
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text)
async function settle() { for (let i = 0; i < 5; i++) { await Promise.resolve(); await tick(); flushSync() } }
async function render(request: (method: string, params?: any) => Promise<any>) {
  window.notemd = { request }
  const { default: App } = await import('./App.svelte')
  component = mount(App, { target: document.body }); flushSync(); await settle()
}
afterEach(async () => { if (component) await unmount(component); component = null; document.body.innerHTML = ''; localStorage.clear(); vi.useRealTimers() })

describe('Agency review UI', () => {
  it('discovers a CLI queue from an idle open window and refreshes only changed results through its terminal state', async () => {
    vi.useFakeTimers()
    let current: Job | null = null
    const request = vi.fn(async (method: string) => {
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.scan') return batchFixture().scan
      if (method === 'plugin.job') return current
      return { batch: current?.state === 'cancelled' ? practicalBatchFixture() : null, history: [], job: current }
    })
    await render(request)
    await vi.advanceTimersByTimeAsync(2000); await settle()
    expect(request.mock.calls.filter(([method]) => method === 'plugin.job')).toHaveLength(1)
    expect(request.mock.calls.filter(([method]) => method === 'plugin.snapshot')).toHaveLength(1)
    current = { id: 'cli-queue', date: '2026-09-20', start_date: '2026-09-20', end_date: '2026-09-21', state: 'running', message: 'CLI 启动', items: [{ date: '2026-09-20', state: 'running', message: '运行中' }, { date: '2026-09-21', state: 'pending', message: '等待' }] }
    await vi.advanceTimersByTimeAsync(2000); await settle()
    expect(document.querySelector('[aria-label=生成任务]')?.textContent).toContain('CLI 启动')
    expect(button('完成当前后停止')).toBeTruthy()
    expect(request.mock.calls.filter(([method]) => method === 'plugin.snapshot')).toHaveLength(2)
    current = { ...current, message: '仅文字进度更新' }
    await vi.advanceTimersByTimeAsync(2000); await settle()
    expect(request.mock.calls.filter(([method]) => method === 'plugin.snapshot')).toHaveLength(2)
    current = { ...current, state: 'cancelled', stop_requested: true, message: 'CLI 已停止', items: [{ date: '2026-09-20', state: 'done', message: '已完成' }, { date: '2026-09-21', state: 'cancelled', message: '已取消' }] }
    await vi.advanceTimersByTimeAsync(2000); await settle()
    expect(document.querySelector('[aria-label=生成任务]')?.textContent).toContain('CLI 已停止')
    expect(document.querySelector('#review-title')?.textContent).toBe('协作复盘')
    expect(request.mock.calls.filter(([method]) => method === 'plugin.snapshot')).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(4000); await settle()
    expect(request.mock.calls.filter(([method]) => method === 'plugin.snapshot')).toHaveLength(3)
    expect(request.mock.calls.some(([method]) => method === 'plugin.observe_range' || method === 'plugin.observe')).toBe(false)
  })
  it('restores a persisted one-day job as single-day mode even when it has range fields', async () => {
    await render(async method => {
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.scan') return batchFixture().scan
      return { batch: null, history: [], job: { id: 'single', date: '2026-09-22', start_date: '2026-09-22', end_date: '2026-09-22', state: 'running', message: '生成中' } }
    })
    expect(document.querySelector<HTMLSelectElement>('select[aria-label=生成范围]')?.value).toBe('single')
    expect(document.querySelector('input[aria-label=开始日期]')).toBeNull()
    expect(button('生成观察')?.disabled).toBe(true)
  })
  it('validates inclusive ranges, keeps report date independent, and submits one exact batch payload', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 23, 12))
    let resolveStart!: (job: Job) => void
    const request = vi.fn(async (method: string, _params?: any) => {
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.scan') return batchFixture().scan
      if (method === 'plugin.observe_range') return new Promise<Job>(resolve => { resolveStart = resolve })
      return { batch: practicalBatchFixture(), history: [], job: null }
    })
    await render(request)
    const mode = document.querySelector<HTMLSelectElement>('select[aria-label=生成范围]')!
    mode.value = 'range'; mode.dispatchEvent(new Event('change', { bubbles: true })); await settle()
    expect(mode.value).toBe('range')
    expect(document.body.textContent).toContain('开始日期')
    const start = document.querySelector<HTMLInputElement>('input[aria-label=开始日期]')!
    const end = document.querySelector<HTMLInputElement>('input[aria-label=结束日期]')!
    expect(start.value).toBe('2026-09-16'); expect(end.value).toBe('2026-09-22')
    expect(button('批量生成 7 天')?.disabled).toBe(false)
    start.value = '2026-09-23'; start.dispatchEvent(new Event('input', { bubbles: true })); await settle()
    expect(button('批量生成')?.disabled).toBe(true)
    expect(document.body.textContent).toContain('结束日期不能早于开始日期')
    start.value = '2026-08-22'; start.dispatchEvent(new Event('input', { bubbles: true })); await settle()
    expect(button('批量生成')?.disabled).toBe(true)
    expect(document.body.textContent).toContain('一次最多生成 31 天')
    expect(request.mock.calls.some(([method]) => method === 'plugin.observe_range')).toBe(false)
    start.value = '2026-08-23'; start.dispatchEvent(new Event('input', { bubbles: true })); await settle()
    const reportDate = document.querySelector<HTMLInputElement>('input[aria-label=观察日期]')!
    reportDate.value = '2026-09-20'; reportDate.dispatchEvent(new Event('change', { bubbles: true })); await settle()
    expect(start.value).toBe('2026-08-23'); expect(end.value).toBe('2026-09-22')
    const generate = button('批量生成 31 天')!
    generate.click(); generate.click(); await settle()
    expect(request.mock.calls.filter(([method]) => method === 'plugin.observe_range')).toEqual([
      ['plugin.observe_range', { start_date: '2026-08-23', end_date: '2026-09-22', harness: 'notemd.codex-agent' }],
    ])
    expect(request.mock.calls.some(([method]) => method === 'plugin.observe')).toBe(false)
    resolveStart({ id: 'range', date: '2026-08-23', start_date: '2026-08-23', end_date: '2026-09-22', state: 'running', message: '队列运行中', items: [{ date: '2026-08-23', state: 'running', message: '处理第一天' }] }); await settle()
    expect(start.disabled).toBe(true); expect(end.disabled).toBe(true)
    expect(document.querySelector<HTMLSelectElement>('select[aria-label=Agent]')?.disabled).toBe(true)
    expect(generate.disabled).toBe(true)
    expect(reportDate.disabled).toBe(false)
  })
  it('shows mixed queue outcomes and stops only unstarted days after the current day finishes', async () => {
    vi.useFakeTimers()
    let current: Job = { id: 'mixed', date: '2026-09-20', start_date: '2026-09-16', end_date: '2026-09-22', state: 'running', message: '正在处理第五天', items: [
      { date: '2026-09-16', state: 'done', message: '已保存', episodes: 2 },
      { date: '2026-09-17', state: 'reused', message: '来源未变化' },
      { date: '2026-09-18', state: 'skipped', message: '无来源' },
      { date: '2026-09-19', state: 'failed', message: '生成失败', error: '输出不完整' },
      { date: '2026-09-20', state: 'running', message: '模型运行中' },
      { date: '2026-09-21', state: 'pending', message: '排队中' },
      { date: '2026-09-22', state: 'pending', message: '排队中' },
    ] }
    let resolveStop!: (job: Job) => void
    const request = vi.fn(async (method: string, _params?: any) => {
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.scan') return batchFixture().scan
      if (method === 'plugin.job') return current
      if (method === 'plugin.stop_queue') return new Promise<Job>(resolve => { resolveStop = resolve })
      return { batch: practicalBatchFixture(), history: [], job: current }
    })
    await render(request)
    const panel = document.querySelector('[aria-label=生成任务]')!
    expect(panel.textContent).toContain('进度 4/7 天已结束')
    for (const label of ['已生成', '已复用', '已跳过', '输出不完整', '正在生成', '等待中']) expect(panel.textContent).toContain(label)
    expect(panel.textContent).toContain('某一天失败不会阻止后续日期')
    const stop = button('完成当前后停止')!
    stop.click(); stop.click(); await settle()
    expect(request.mock.calls.filter(([method]) => method === 'plugin.stop_queue')).toHaveLength(1)
    current = { ...current, stop_requested: true }
    resolveStop(current); await settle()
    expect(button('已请求停止')?.disabled).toBe(true)
    expect(panel.textContent).toContain('当前生成会继续到结束')
    expect([...panel.querySelectorAll('.item-state')].map(item => item.textContent)).toEqual(['已生成', '已复用', '已跳过', '失败', '正在生成', '已取消', '已取消'])
    panel.querySelector<HTMLButtonElement>('[aria-label="查看 2026-09-17 的报告"]')!.click(); await settle()
    expect(document.querySelector<HTMLInputElement>('input[aria-label=观察日期]')?.value).toBe('2026-09-17')
    current = { ...current, state: 'partial', message: '已结束，保留完成结果', items: current.items!.map(item => item.state === 'running' ? { ...item, state: 'done' } : item.state === 'pending' ? { ...item, state: 'cancelled' } : item) }
    const snapshotCount = request.mock.calls.filter(([method]) => method === 'plugin.snapshot').length
    await vi.advanceTimersByTimeAsync(2000); await settle()
    expect(request.mock.calls.filter(([method]) => method === 'plugin.snapshot')).toHaveLength(snapshotCount + 1)
    expect(panel.textContent).toContain('部分完成')
    expect(panel.textContent).toContain('进度 7/7 天已结束')
    expect(button('完成当前后停止')).toBeUndefined()
    expect(document.querySelector<HTMLInputElement>('input[aria-label=开始日期]')?.disabled).toBe(false)
    expect(request.mock.calls.some(([method]) => method === 'plugin.observe_range' || method === 'plugin.observe')).toBe(false)
  })
  it('refreshes completed days once without resetting selected details and restores the persisted queue after reopening', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 23, 12))
    const batch = practicalBatchFixture()
    batch.episodes = Array.from({ length: 5 }, (_, i) => ({ ...practicalEpisode(`item-${i}`), title: `报告片段 ${i + 1}` }))
    let current: Job = { id: 'persisted', date: '2026-09-20', start_date: '2026-09-20', end_date: '2026-09-22', state: 'running', message: '继续生成', items: [
      { date: '2026-09-20', state: 'running', message: '运行中' }, { date: '2026-09-21', state: 'pending', message: '' }, { date: '2026-09-22', state: 'pending', message: '' },
    ] }
    const request = vi.fn(async (method: string) => {
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.scan') return batch.scan
      if (method === 'plugin.job') return current
      return { batch, history: current.items![0].state === 'done' ? [{ date: '2026-09-20', batch_id: 'finished', episodes: 1, observed: 1, excluded: 0, created_at: '' }] : [], job: current }
    })
    await render(request)
    document.querySelector<HTMLButtonElement>('[data-column=progress] .show-more')!.click(); await settle()
    const last = [...document.querySelectorAll<HTMLButtonElement>('[data-column=progress] .finding')].find(item => item.textContent?.includes('报告片段 5'))!
    last.click(); await settle()
    current = { ...current, items: [{ date: '2026-09-20', state: 'done', message: '已保存', episodes: 1 }, { date: '2026-09-21', state: 'running', message: '正在处理' }, { date: '2026-09-22', state: 'pending', message: '' }] }
    await vi.advanceTimersByTimeAsync(2000); await settle()
    expect(request.mock.calls.filter(([method]) => method === 'plugin.snapshot')).toHaveLength(2)
    expect(request.mock.calls.filter(([method]) => method === 'plugin.scan')).toHaveLength(1)
    expect(document.querySelector('#episode-detail h2')?.textContent).toBe('报告片段 5')
    expect(document.querySelectorAll('[data-column=progress] .finding')).toHaveLength(5)
    const dateButton = [...document.querySelectorAll<HTMLButtonElement>('nav[aria-label=最近七天] button')].find(item => item.textContent?.includes('2026-09-20'))!
    expect(dateButton.textContent).toContain('已生成')
    current = { ...current, message: '仅进度文案改变' }
    await vi.advanceTimersByTimeAsync(2000); await settle()
    expect(request.mock.calls.filter(([method]) => method === 'plugin.snapshot')).toHaveLength(2)
    await unmount(component!); component = null; document.body.innerHTML = ''
    await render(request)
    expect(document.querySelector<HTMLSelectElement>('select[aria-label=生成范围]')?.value).toBe('range')
    expect(document.querySelector<HTMLInputElement>('input[aria-label=开始日期]')?.value).toBe('2026-09-20')
    expect(document.querySelector<HTMLInputElement>('input[aria-label=结束日期]')?.value).toBe('2026-09-22')
    expect(document.querySelector('[aria-label=生成任务]')?.textContent).toContain('进度 1/3 天已结束')
    expect(button('批量生成 3 天')?.disabled).toBe(true)
    expect(request.mock.calls.some(([method]) => method === 'plugin.observe_range')).toBe(false)
  })
  it.each(['done', 'partial', 'failed', 'cancelled'] as const)('refreshes report and history after terminal state %s', async state => {
    vi.useFakeTimers()
    let terminal = false
    const request = vi.fn(async (method: string) => {
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.scan') return batchFixture().scan
      if (method === 'plugin.job') { terminal = true; return { id: 'job', date: '2026-09-22', state, message: '已结束' } }
      return { batch: terminal ? practicalBatchFixture() : null, history: [], job: { id: 'job', date: '2026-09-22', state: terminal ? state : 'running', message: '生成中' } }
    })
    await render(request)
    await vi.advanceTimersByTimeAsync(2000); await settle()
    expect(request.mock.calls.filter(([method]) => method === 'plugin.snapshot')).toHaveLength(2)
    expect(document.querySelector('#review-title')?.textContent).toBe('协作复盘')
  })
  it('keeps the general date limitation visible and folds all detailed coverage warnings without discarding them', async () => {
    const scan = { ...batchFixture().scan, warnings: ['日期范围来自会话起止时间，不能精确分日。', '跨日来源：agent-sessions/first.md', '覆盖提醒：agent-sessions/second.md'] }
    await render(async method => {
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.scan') return scan
      return { batch: practicalBatchFixture(), history: [], job: null }
    })
    const coverage = document.querySelector('.coverage')!
    const general = [...coverage.querySelectorAll('p.notice')].find(p => p.textContent === scan.warnings[0])!
    expect(general.closest('details')).toBeNull()
    const folded = coverage.querySelector<HTMLDetailsElement>('details.coverage-warnings')!
    expect(folded.open).toBe(false)
    expect(folded.querySelector('summary')?.textContent).toBe('跨日与覆盖提醒（2）')
    folded.querySelector('summary')!.click(); await settle()
    expect(folded.open).toBe(true)
    expect([...folded.querySelectorAll('p.notice')].map(p => p.textContent)).toEqual(scan.warnings.slice(1))
    expect(coverage.textContent).toContain('不代表当天的独立互动次数或投入时长')
  })
  it('shows three findings per column by default and keeps every remaining detail reachable until date changes reset expansion', async () => {
    const batch = practicalBatchFixture()
    batch.episodes = Array.from({ length: 5 }, (_, i) => ({ ...practicalEpisode(`episode-${i}`), title: `协作片段 ${i + 1}` }))
    await render(async method => {
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.scan') return batch.scan
      return { batch, history: [], job: null }
    })
    for (const column of document.querySelectorAll('[data-column]')) expect(column.querySelectorAll('.finding')).toHaveLength(3)
    const progress = document.querySelector('[data-column=progress]')!
    const expand = progress.querySelector<HTMLButtonElement>('.show-more')!
    expect(expand.textContent).toBe('显示更多 2 项')
    expand.click(); await settle()
    expect(progress.querySelectorAll('.finding')).toHaveLength(5)
    expect(document.querySelectorAll('[data-column=friction] .finding')).toHaveLength(3)
    const last = [...progress.querySelectorAll<HTMLButtonElement>('.finding')].find(item => item.textContent?.includes('协作片段 5'))!
    last.click(); await settle()
    expect(document.querySelector('#episode-detail h2')?.textContent).toBe('协作片段 5')
    expect(expand.textContent).toBe('收起')
    expand.click(); await settle()
    expect(progress.querySelectorAll('.finding')).toHaveLength(3)
    expand.click(); await settle()
    const date = document.querySelector<HTMLInputElement>('input[type=date]')!
    date.value = '2026-09-20'; date.dispatchEvent(new Event('change', { bubbles: true })); await settle()
    for (const column of document.querySelectorAll('[data-column]')) {
      expect(column.querySelectorAll('.finding')).toHaveLength(3)
      expect(column.querySelector('.show-more')?.getAttribute('aria-expanded')).toBe('false')
    }
    expect(document.querySelectorAll('.episode')).toHaveLength(5)
  })
  it('replaces psychological count cards with concrete findings and selects their evidence details', async () => {
    const batch = practicalBatchFixture()
    batch.episodes.push({ ...practicalEpisode('second'), title: '第二段独立检查', outcome: 'assistant_reported' })
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.scan') return batch.scan
      if (method === 'plugin.open_source') return { path: 'agent-sessions/example.md', line: 170 }
      if (method === 'host.editor.open') return { ok: true }
      return { batch, history: [], job: null }
    })
    await render(request)
    expect(document.querySelector('.metrics')).toBeNull()
    expect(document.querySelector('#signals-title')).toBeNull()
    const mainReview = document.querySelector('.review-columns')!
    expect(mainReview.textContent).toContain('具体目标进展')
    expect(mainReview.textContent).toContain('协作负担')
    expect(mainReview.textContent).toContain('能力扩展')
    expect(mainReview.textContent).not.toContain('个片段观察到')
    expect(document.querySelector<HTMLDetailsElement>('details.signals')?.open).toBe(false)
    const second = [...document.querySelectorAll<HTMLButtonElement>('[data-column=progress] button')].find(item => item.textContent?.includes('第二段独立检查'))!
    expect(second.textContent).toContain('AI 自述完成 · 尚未独立核验')
    second.click(); await settle()
    expect(document.querySelector('#episode-detail h2')?.textContent).toBe('第二段独立检查')
    expect(document.activeElement?.id).toBe('episode-detail')
    expect(document.querySelector('#episode-detail')?.textContent).toContain('依据：引文 3')
    expect(document.querySelector('#episode-detail')?.textContent).toContain('以前不能自己调试推流，现在可以用这个脚本完成检查。')
    button('打开原文 · 第 170 行')!.click(); await settle()
    expect(request.mock.calls.find(([method]) => method === 'plugin.open_source')?.[1]).toMatchObject({ source_id: 'source-1', line: 170 })
    button('查看对应片段：修正方案后确认结果')!.click(); await settle()
    expect(document.querySelector('#episode-detail h2')?.textContent).toBe('修正方案后确认结果')
    const experiment = document.querySelector('[aria-label=可选实验]')!
    expect(experiment.textContent).toContain('行动：下一次发布前，用该脚本自行检查推流。')
    expect(experiment.textContent).toContain('如何检验：记录能否在请求 AI 协助前发现异常。')
  })
  it('removes an excluded episode from all practical columns and the proposed experiment', async () => {
    let batch = practicalBatchFixture()
    const second = practicalEpisode('second')
    second.title = '保留的第二段'
    second.practical!.experiment!.action = '第二段可选实验'
    batch.episodes.push(second)
    const request = vi.fn(async (method: string, params?: any) => {
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.scan') return batch.scan
      if (method === 'plugin.review') {
        batch = { ...batch, reviews: { [params.episode_id]: { excluded: params.excluded, note: params.note } } }
        return batch
      }
      return { batch, history: [], job: null }
    })
    await render(request)
    button('排除此片段')!.click(); await settle()
    for (const column of document.querySelectorAll('[data-column]')) {
      expect(column.textContent).not.toContain('修正方案后确认结果')
      expect(column.textContent).toContain('保留的第二段')
    }
    expect(document.querySelector('[aria-label=可选实验]')?.textContent).toContain('第二段可选实验')
    expect(document.querySelector('[aria-label=可选实验]')?.textContent).not.toContain('下一次发布前，用该脚本自行检查推流。')
    document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); await settle()
    const excludedItem = [...document.querySelectorAll<HTMLButtonElement>('.episode')].find(item => item.textContent?.includes('修正方案后确认结果'))!
    excludedItem.click(); await settle()
    expect(document.querySelector('#episode-detail')?.textContent).toContain('已人工排除')
    expect(document.querySelector('.review-columns')?.textContent).not.toContain('修正方案后确认结果')
    button('恢复计入')!.click(); await settle()
    expect(document.querySelector('.review-columns')?.textContent).toContain('修正方案后确认结果')
    expect(document.querySelector('[aria-label=可选实验]')?.textContent).toContain('下一次发布前，用该脚本自行检查推流。')
  })
  it('keeps absent practical evidence unknown and omits a generic batch suggestion', async () => {
    const batch = practicalBatchFixture()
    batch.episodes[0].practical = null
    batch.episodes[0].imagination = signal('observed')
    batch.episodes[0].goal_origin = 'delegated'
    batch.suggestion = '不应显示的泛化建议'
    await render(async method => {
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.scan') return batch.scan
      return { batch, history: [], job: null }
    })
    expect(document.querySelector('[data-column=progress]')?.textContent).toContain('具体进展未知')
    expect(document.querySelector('[data-column=friction]')?.textContent).toContain('没有记录不代表没有负担')
    expect(document.querySelector('[data-column=expansion]')?.textContent).toContain('普通委托不等于能力扩展')
    expect(document.querySelectorAll('.finding')).toHaveLength(0)
    expect(document.querySelector('[aria-label=可选实验]')).toBeNull()
    expect(document.body.textContent).not.toContain('不应显示的泛化建议')
  })
  it('labels legacy data without reinterpreting its signals and refreshes practical review after regeneration', async () => {
    let upgraded = false
    const legacy = practicalBatchFixture()
    delete legacy.rule_version
    legacy.episodes[0].friction = '旧版发现反复追问。'
    legacy.episodes[0].outcome = 'assistant_reported'
    const request = vi.fn(async (method: string) => {
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.scan') return legacy.scan
      if (method === 'plugin.observe') { upgraded = true; return { id: 'new', date: legacy.date, state: 'done', message: '完成' } }
      return { batch: upgraded ? practicalBatchFixture() : legacy, history: [], job: null }
    })
    await render(request)
    expect(document.body.textContent).toContain('旧版报告，重新生成可补充协作复盘')
    expect(document.querySelector('[data-column=progress]')?.textContent).toContain('旧版仅保留目标状态')
    expect(document.querySelector('[data-column=friction]')?.textContent).toContain('旧版发现反复追问。')
    expect(document.querySelector('[data-column=friction]')?.textContent).toContain('旧版记录 · 未结构化核对')
    expect(document.querySelector('[data-column=expansion] button')).toBeNull()
    expect(document.querySelector('[aria-label=可选实验]')).toBeNull()
    button('重新生成观察')!.click(); await settle()
    expect(document.body.textContent).not.toContain('旧版报告，重新生成可补充协作复盘')
    expect(document.querySelector('[data-column=expansion]')?.textContent).toContain('用户表示从无法自行调试，到能使用脚本检查推流。')
  })
  it('discovers recent sources when only September 17 has observations and allows date switches during a running job', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 23, 12))
    const latest = { ...batchFixture().scan, sources: [{ ...batchFixture().scan.sources[0], title: '九月二十二日新互动' }] }
    const request = vi.fn(async (method: string, params?: any) => {
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.scan') return { ...latest, date: params.date }
      return { batch: null, history: [{ date: '2026-09-17', batch_id: 'old', episodes: 2, observed: 1, excluded: 0, created_at: '2026-09-18T03:00:00Z' }], job: { id: 'running-22', date: '2026-09-22', state: 'running', message: '生成中' } }
    })
    await render(request)
    const days = [...document.querySelectorAll<HTMLButtonElement>('nav[aria-label=最近七天] button')]
    expect(days).toHaveLength(7)
    expect(days[0].textContent).toContain('2026-09-23 · 今天')
    expect(days.find(b => b.textContent?.includes('2026-09-17'))?.textContent).toContain('已生成')
    expect(days.find(b => b.textContent?.includes('2026-09-22'))?.textContent).toContain('未生成')
    expect(request).toHaveBeenCalledWith('plugin.scan', { date: '2026-09-22' })
    expect(document.body.textContent).toContain('九月二十二日新互动')
    expect(document.body.textContent).toContain('开始：2026-09-22 08:00 · 结束：2026-09-22 09:00')
    expect(document.body.textContent).toContain('未生成不代表没有来源')
    expect(days[0].disabled).toBe(false)
    days[0].click(); await settle()
    expect(request).toHaveBeenCalledWith('plugin.scan', { date: '2026-09-23' })
    expect(request.mock.calls.some(([method]) => method === 'plugin.observe')).toBe(false)
  })
  it('ignores slow snapshot and source results from an earlier selected date', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 23, 12))
    let oldScan!: (scan: Scan) => void
    let oldSnapshot!: (snapshot: Snapshot) => void
    const currentBatch = { ...batchFixture(), date: '2026-09-21', episodes: [{ ...batchFixture().episodes[0], title: '九月二十一日观察' }] }
    const request = vi.fn(async (method: string, params?: any) => {
      if (method === 'host.agent.providers') return providers
      if (params?.date === '2026-09-22') {
        if (method === 'plugin.scan') return new Promise<Scan>(resolve => { oldScan = resolve })
        if (method === 'plugin.snapshot') return new Promise<Snapshot>(resolve => { oldSnapshot = resolve })
      }
      if (method === 'plugin.scan') return { ...batchFixture().scan, date: params.date, sources: [{ ...batchFixture().scan.sources[0], title: '九月二十一日来源' }] }
      return { batch: currentBatch, history: [], job: null }
    })
    await render(request)
    const day = [...document.querySelectorAll<HTMLButtonElement>('nav[aria-label=最近七天] button')].find(b => b.textContent?.includes('2026-09-21'))!
    expect(day.disabled).toBe(false)
    day.click(); await settle()
    expect(document.body.textContent).toContain('九月二十一日来源')
    expect(document.body.textContent).toContain('九月二十一日观察')
    oldScan({ ...batchFixture().scan, sources: [{ ...batchFixture().scan.sources[0], title: '不应出现的旧日期来源' }] })
    oldSnapshot({ batch: batchFixture(), history: [], job: null }); await settle()
    expect(document.querySelector<HTMLInputElement>('input[type=date]')?.value).toBe('2026-09-21')
    expect(document.body.textContent).toContain('九月二十一日来源')
    expect(document.body.textContent).toContain('九月二十一日观察')
    expect(document.body.textContent).not.toContain('不应出现的旧日期来源')
    expect(document.body.textContent).not.toContain('修正方案后确认结果')
  })
  it('reports fresh scan failure without substituting saved coverage or losing saved observations', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.scan') throw new Error('来源暂不可读')
      return { batch: batchFixture(), history: [], job: null }
    })
    await render(request)
    expect(document.querySelector('[role=alert]')?.textContent).toContain('来源扫描失败：来源暂不可读')
    expect(document.body.textContent).toContain('不能据此判断当天没有来源')
    expect(document.body.textContent).toContain('修正方案后确认结果')
    expect(document.body.textContent).toContain('已存观察仍基于生成时的 1 条来源')
    expect(document.body.textContent).not.toContain('检查 2 条记录')
  })
  it('keeps the selected legacy provider visible and disabled without silently selecting a capable provider', async () => {
    localStorage.setItem('notemd.agent.provider.agency', 'notemd.claude-agent')
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.scan') return batchFixture().scan
      if (method === 'host.agent.providers') return { ...providers, providers: [...providers.providers, { id: 'notemd.claude-agent', name: 'Claude', harness: { ok: true } }] }
      return { batch: batchFixture(), history: [], job: null }
    })
    await render(request)
    const picker = document.querySelector<HTMLSelectElement>('select[aria-label=Agent]')!
    expect(picker.value).toBe('notemd.claude-agent')
    expect(picker.selectedOptions[0].disabled).toBe(true)
    expect(document.body.textContent).toContain('需更新 Agent 以支持 Agency 隔离观测')
    expect(button('重新生成观察')?.disabled).toBe(true)
    expect(document.body.textContent).toContain('相同来源与规则会复用结果并保留校正')
    expect(document.body.textContent).toContain('旧批次的校正仍保留，但不会自动套用')
    picker.value = 'notemd.codex-agent'; picker.dispatchEvent(new Event('change', { bubbles: true })); await settle()
    expect(button('重新生成观察')?.disabled).toBe(false)
    expect(localStorage.getItem('notemd.agent.provider.agency')).toBe('notemd.codex-agent')
  })
  it('remains readable and scannable without an installed provider', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.scan') return batchFixture().scan
      if (method === 'host.agent.providers') return { providers: [], default: '' }
      return { batch: null, history: [], job: null }
    })
    await render(request)
    expect(button('生成观察')).toBeUndefined()
    expect(button('扫描来源')?.disabled).toBe(false)
    button('扫描来源')!.click(); await settle()
    expect(document.body.textContent).toContain('检查 2 条记录 · 纳入 1 条 · 排除 1 条')
    expect(document.body.textContent).toContain('自动审批记录')
  })
  it('opens only the validated source and surfaces navigation failure', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.scan') return batchFixture().scan
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.open_source') return { path: 'agent-sessions/example.md', line: 159 }
      if (method === 'host.editor.open') throw new Error('编辑器无法打开文件')
      return { batch: batchFixture(), history: [], job: null }
    })
    await render(request)
    expect(document.body.textContent).toContain('证据不足')
    expect(document.body.textContent).toContain('不代表你已确认本次 Agency 判断')
    button('打开原文 · 第 159 行')!.click(); await settle()
    expect(request).toHaveBeenCalledWith('host.editor.open', { path: 'agent-sessions/example.md' })
    expect(document.querySelector('[role=alert]')?.textContent).toContain('编辑器无法打开文件')
  })
  it('does not open a source when native integrity validation fails', async () => {
    const request = vi.fn(async () => { throw new Error('来源已变更') })
    window.notemd = { request }
    await expect(api.openSource('2026-09-22', 'source-1', 159)).rejects.toThrow('来源已变更')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('plugin.open_source', { date: '2026-09-22', source_id: 'source-1', line: 159 })
  })
  it('persists review with batch identity, removes its counts and allows restoring', async () => {
    let batch = batchFixture()
    const request = vi.fn(async (method: string, params?: any) => {
      if (method === 'plugin.scan') return batchFixture().scan
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.review') { batch = { ...batch, reviews: { [params.episode_id]: { excluded: params.excluded, note: params.note } } }; return batch }
      return { batch, history: [], job: null }
    })
    await render(request)
    const note = document.querySelector<HTMLTextAreaElement>('#review-note')!
    note.value = '保留用于学习'; note.dispatchEvent(new Event('input', { bubbles: true })); await settle()
    button('排除此片段')!.click(); await settle()
    expect(request.mock.calls.find(([m]) => m === 'plugin.review')?.[1]).toMatchObject({ batch_id: 'batch-1', episode_id: 'episode-1', excluded: true, note: '保留用于学习' })
    expect(document.body.textContent).toContain('计入 0 个片段 · 人工排除 1 个')
    document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); await settle()
    expect(document.querySelector<HTMLTextAreaElement>('#review-note')?.value).toBe('保留用于学习')
    button('恢复计入')!.click(); await settle()
    expect(document.body.textContent).toContain('计入 1 个片段 · 人工排除 0 个')
  })
  it('blocks duplicate generation and presents a native failed job without replacing previous results', async () => {
    let resolve!: (job: Job) => void
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.scan') return batchFixture().scan
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.observe') return new Promise<Job>(r => { resolve = r })
      return { batch: batchFixture(), history: [], job: null }
    })
    await render(request)
    const generate = button('重新生成观察')!
    generate.click(); generate.click(); await settle()
    expect(request.mock.calls.filter(([m]) => m === 'plugin.observe')).toHaveLength(1)
    resolve({ id: 'job', date: '2026-09-22', state: 'failed', message: '失败', error: '模型输出缺少引文' }); await settle()
    expect(document.body.textContent).toContain('生成失败')
    expect(document.body.textContent).toContain('模型输出缺少引文')
    expect(document.body.textContent).toContain('修正方案后确认结果')
    expect(button('重新生成观察')?.disabled).toBe(false)
  })
  it('polls a cross-date job and reloads snapshot after completion', async () => {
    vi.useFakeTimers()
    let complete = false
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.scan') return batchFixture().scan
      if (method === 'host.agent.providers') return providers
      if (method === 'plugin.job') { complete = true; return { id: 'job', date: '2026-09-20', state: 'done', message: '完成' } }
      return { batch: complete ? batchFixture() : null, history: [], job: { id: 'job', date: '2026-09-20', state: complete ? 'done' : 'running', message: '生成中' } }
    })
    await render(request)
    expect(document.body.textContent).toContain('2026-09-20 · 正在生成')
    expect(button('生成观察')?.disabled).toBe(true)
    await vi.advanceTimersByTimeAsync(2000); await settle()
    expect(request.mock.calls.filter(([m]) => m === 'plugin.snapshot')).toHaveLength(2)
    expect(document.body.textContent).toContain('协作复盘')
  })
})
