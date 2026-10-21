import { mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.svelte'
import type { ClassificationRule } from './lib/classification'
import type { TimelineSettings } from './lib/bridge'

const fixture = `---
type: timeline
description: 合成测试日程
---
# 示例时间线
- 09:00:00–10:15:00 — 研发审阅：检查合成项目的界面方案 [方案](../notes/spec.md#line12)
  - 09:15:00–09:30:00 — 讨论：核对交互 [讨论记录](../notes/discussion.md#line3)
- 09:05:00–09:05:20 — 家庭安排：安排周末活动

记录仅用于演示。
`

const assessedFixture = `---
type: timeline
sources: [{id: s01, resource: /vault/notes/spec.md, title: 合成证据}]
event_metadata: ${JSON.stringify({
  meeting: { importance: 'high', reason: '确认交付日期。', evidence: [{ source: 's01', locator: 'L12-L18' }], signals: { source_chars: 260, duration_minutes: null, owner_relation: 'direct' }, anomaly: { status: 'none', reason: '已核对计划。', evidence: [] } },
  routine: { importance: 'normal', reason: '例行核对。', evidence: [{ source: 's01', locator: 'L19' }], signals: { source_chars: 20, duration_minutes: 0, owner_relation: 'related' } },
  pending: { importance: 'unknown', reason: '关系尚未核实。', evidence: [], signals: { source_chars: null, duration_minutes: null, owner_relation: 'unknown' }, anomaly: { status: 'unknown', reason: '缺少常态基线。', evidence: [] } },
  fault: { importance: 'normal', reason: '例行测试中断。', evidence: [{ source: 's01', locator: 'L20' }], signals: { source_chars: null, duration_minutes: null, owner_relation: 'background' }, anomaly: { status: 'flagged', reason: '原文明示故障。', evidence: [{ source: 's01', locator: 'L21-L22' }] } },
})}
---
- 09:00–10:00 — 研发审阅：确定交付 [方案](../notes/spec.md#L12) <!-- event:meeting -->
  - 09:15–09:30 — 讨论：例行核对 <!-- event:routine -->
    - 09:20–09:25 — 议题：关系待核实 <!-- event:pending -->
- 09:05–09:05 — 家庭安排：合成测试中断 <!-- event:fault -->
`

const initialRules: ClassificationRule[] = [
  { id: 'review', name: '审阅', keywords: ['审阅'], category: 'work' },
  { id: 'family', name: '家庭', keywords: ['家庭'], category: 'life' },
]

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label)
  if (!match) throw new Error(`Missing button: ${label}`)
  return match
}

function field<T extends HTMLElement>(label: string): T {
  const match = document.querySelector<T>(`[aria-label="${label}"]`)
  if (!match) throw new Error(`Missing field: ${label}`)
  return match
}

function rectAt(top: number): DOMRect {
  return { x: 0, y: top, top, right: 0, bottom: top, left: 0, width: 0, height: 0, toJSON: () => ({}) }
}

async function setField(label: string, value: string) {
  const input = field<HTMLInputElement | HTMLSelectElement>(label)
  input.value = value
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  await tick()
}

function openDocument(content = fixture, requestId = 1, uri = '/vault/diary/2026-09-09.timeline.md', editable = false) {
  window.dispatchEvent(new MessageEvent('message', { origin: 'http://localhost:1420', source: window, data: {
    type: 'file_view.open', viewId: 'timeline', requestId, uri, content, capabilities: { edit: editable },
  } }))
}

function host(options: { save?: (settings: TimelineSettings) => Promise<void>; load?: () => Promise<unknown>; language?: string; exists?: boolean } = {}) {
  const request = vi.fn(async (method: string, params?: any) => {
    if (method === 'host.settings.get') return options.load ? options.load() : { settings: { timeline: { classification: structuredClone(initialRules), startTime: '09:00' } } }
    if (method === 'host.settings.set') { await options.save?.(params.value); return {} }
    if (method === 'host.vault.info') return { root: '/vault' }
    if (method === 'host.vault.exists') return { exists: options.exists ?? true }
    if (method === 'host.editor.open') return {}
    throw new Error(`Unexpected request: ${method}`)
  })
  Object.assign(window, { notemd: { locale: options.language ?? 'zh', theme: 'light', request } })
  const posted = vi.spyOn(window, 'postMessage')
  return { request, posted }
}

describe('Timeline application', () => {
  let app: ReturnType<typeof mount> | undefined
  afterEach(async () => {
    if (app) await unmount(app)
    app = undefined
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  async function start(options: Parameters<typeof host>[0] = {}) {
    const mocked = host(options)
    app = mount(App, { target: document.body })
    await vi.waitFor(() => expect(mocked.request).toHaveBeenCalledWith('host.settings.get'))
    openDocument()
    await vi.waitFor(() => expect(document.querySelectorAll('.event')).toHaveLength(2))
    return mocked
  }

  it('saves all fields and keeps a failed draft retryable against the host dirty snapshot', async () => {
    const mocked = await start()
    openDocument(fixture, 2, undefined, true)
    await tick()
    document.querySelector<HTMLButtonElement>('.event')!.click(); await tick()
    document.querySelector<HTMLButtonElement>('.edit-event')!.click(); await tick()
    await setField('标题', '研发审阅更新')
    await setField('事件描述', '确认新的交付安排')
    await setField('开始时间', '08:45:30')
    await setField('结束时间', '10:30')
    await setField('重要程度', 'high')
    expect(field<HTMLButtonElement>('下一天').disabled).toBe(true)
    button('保存').click()
    const saves = () => mocked.posted.mock.calls.filter(([message]) => message.type === 'file_view.save')
    await vi.waitFor(() => expect(saves()).toHaveLength(1))
    const request = saves()[0][0]
    expect(request.content).toContain('[方案](../notes/spec.md#line12)')
    const reply = (id: number, operationId: number, ok: boolean) => window.dispatchEvent(new MessageEvent('message', { origin: 'http://localhost:1420', source: window, data: { type: 'file_view.save_result', requestId: id, operationId, ok, error: 'disk full' } }))
    reply(2, request.operationId, false)
    openDocument(request.content, 3, undefined, true)
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('disk full'))
    expect(field<HTMLInputElement>('标题').value).toBe('研发审阅更新')
    button('保存').click()
    await vi.waitFor(() => expect(saves()).toHaveLength(2))
    const retry = saves()[1][0]
    expect(retry.requestId).toBe(3)
    reply(3, retry.operationId, true)
    openDocument(retry.content, 4, undefined, true)
    await vi.waitFor(() => expect(document.querySelector('.event-editor')).toBeNull())
    expect(document.querySelector('.event strong')?.textContent).toBe('研发审阅更新')
    expect(document.querySelector('.event')?.getAttribute('data-importance')).toBe('high')
    expect(document.querySelector('.detail')?.textContent).toContain('确认新的交付安排')
    expect(document.querySelector('.detail')?.textContent).toContain('手动设置')
  })

  it('preserves drafts when an external snapshot deletes the selected event and refuses overwrite', async () => {
    const mocked = await start()
    openDocument(assessedFixture, 2, undefined, true); await tick()
    document.querySelector<HTMLButtonElement>('.event')!.click(); await tick()
    document.querySelector<HTMLButtonElement>('.edit-event')!.click(); await tick()
    await setField('标题', '我的未保存草稿')
    openDocument('---\ntype: timeline\n---\n', 3, undefined, true); await tick()
    expect(field<HTMLInputElement>('标题').value).toBe('我的未保存草稿')
    button('保存').click()
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('文件已发生变化'))
    expect(mocked.posted.mock.calls.some(([message]) => message.type === 'file_view.save')).toBe(false)
    button('取消').click(); await tick()
    expect(document.querySelector('.detail')).toBeNull()
  })

  it('renders timed blocks, nested detail, notes and sources through the real bridge', async () => {
    const mocked = await start()
    const cards = [...document.querySelectorAll<HTMLButtonElement>('.event')]
    expect(cards.map((card) => card.dataset.category)).toEqual(['work', 'life'])
    expect(cards[0].style.top).not.toBe(cards[1].style.top)
    expect(cards[0].style.left).not.toBe(cards[1].style.left)
    expect(document.querySelector('.document-notes')?.textContent).toContain('记录仅用于演示。')
    expect(document.querySelector('.original-title')?.textContent).toBe('示例时间线')
    expect(mocked.posted).toHaveBeenCalledWith({ type: 'file_view.ready', requestId: 1 }, 'http://localhost:1420')
    cards[0].click()
    await tick()
    expect(document.querySelector('.detail')?.textContent).toContain('核对交互')
    expect(document.querySelectorAll('.source-link')).toHaveLength(2)
    document.querySelector<HTMLButtonElement>('.source-link')!.click()
    await vi.waitFor(() => expect(mocked.request).toHaveBeenCalledWith('host.editor.open', expect.objectContaining({ path: 'notes/spec.md' })))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
    expect(document.querySelector('.detail')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(cards[0]))
    expect(document.querySelector('.toolbar-actions')?.textContent).not.toContain('编辑 Markdown')
  })

  it('shows independent assessments at every level and preserves source navigation limits', async () => {
    const mocked = await start()
    expect([...document.querySelectorAll('.event .importance-label')].map((node) => node.textContent)).toEqual(['待判断', '待判断'])
    openDocument(assessedFixture, 2); await tick()
    const cards = [...document.querySelectorAll<HTMLButtonElement>('.event')]
    expect(cards.map((card) => card.dataset.category)).toEqual(['work', 'life'])
    expect(cards.map((card) => card.dataset.importance)).toEqual(['high', 'normal'])
    expect(cards[0].getAttribute('aria-label')).toContain('重要')
    expect(cards[1].getAttribute('aria-label')).toContain('普通，反常')
    expect(cards[1].querySelector('.anomaly-label')?.textContent).toBe('反常')
    expect(parseFloat(cards[1].style.height)).toBe(44)
    expect(cards[1].querySelector('.event-top .importance-label')?.textContent).toBe('普通')
    expect(cards[1].querySelector('.event-top .anomaly-label')?.textContent).toBe('反常')
    expect(cards[1].querySelector('.event-time .event-duration')?.textContent).toBe('0 秒')
    expect(cards[0].querySelector('.event-text')?.textContent).toBe('确定交付')
    expect(cards[0].getAttribute('aria-label')).toContain('1 个议题')
    expect(cards[0].title).toContain('1 小时')
    expect(field('分类图例').textContent).not.toContain('待判断')
    expect(field('重要程度图例').textContent).toContain('待判断')
    cards[0].click(); await tick()
    const assessments = [...document.querySelectorAll('.assessment')]
    expect(assessments.map((node) => node.querySelector('.importance-label')?.textContent)).toEqual(['重要', '普通', '待判断'])
    expect(assessments[0].textContent).toContain('确认交付日期。')
    expect(assessments[0].textContent).toContain('s01 · L12-L18')
    expect(assessments[0].textContent).toContain('已核对未发现反常')
    expect(assessments[1].textContent).toContain('反常尚未判断')
    expect(assessments[1].textContent).toContain('0 分钟')
    expect(assessments[2].textContent).toContain('缺少常态基线。')
    expect([...assessments[2].querySelectorAll('.signals dd')].map((node) => node.textContent)).toEqual(['未知', '未知', '未知'])
    expect(document.querySelector('.source-limit')?.textContent).toContain('不能定位行号')
    document.querySelector<HTMLButtonElement>('.source-link')!.click()
    await vi.waitFor(() => expect(mocked.request).toHaveBeenCalledWith('host.editor.open', { path: 'notes/spec.md' }))
    expect(document.querySelector('.detail')?.textContent).not.toContain('event:')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick()
    await vi.waitFor(() => expect(document.activeElement).toBe(cards[0]))
    cards[1].click(); await tick()
    expect(document.querySelector('.anomaly-assessment')?.textContent).toContain('原文明示故障。')
    expect(document.querySelector('.anomaly-assessment')?.textContent).toContain('s01 · L21-L22')
  })

  it('localizes importance, anomaly and unknown signals in English', async () => {
    await start({ language: 'en' })
    expect(document.querySelector('.event .importance-label')?.textContent).toBe('Pending review')
    document.querySelector<HTMLButtonElement>('.event')!.click(); await tick()
    expect(document.querySelector('.assessment-reason')?.textContent).toBe('This legacy document has not been assessed.')
    expect(document.querySelector('.anomaly-assessment')?.textContent).toContain('Anomaly not yet assessed')
    openDocument(assessedFixture, 2); await tick()
    document.querySelector<HTMLButtonElement>('[data-item-id="fault"]')!.click(); await tick()
    expect(document.querySelector('.assessment .importance-label')?.textContent).toBe('Normal')
    expect(document.querySelector('.assessment .anomaly-label')?.textContent).toBe('Anomaly')
    expect(document.querySelector('.signals')?.textContent).toContain('Unknown')
    expect(document.querySelector('.source-limit')?.textContent).toContain('cannot navigate to line numbers')
    openDocument(assessedFixture.replace('"fault":{"importance":"normal"', '"fault":{"importance":"unknown"'), 3); await tick()
    const top = document.querySelector('[data-item-id="fault"] .event-top')!
    expect(top.querySelector('.importance-label')?.textContent).toBe('Pending review')
    expect(top.querySelector('.anomaly-label')?.textContent).toBe('Anomaly')
    openDocument(assessedFixture.replace('09:00–10:00', '09:00–09:45'), 4); await tick()
    expect(document.querySelector('[data-item-id="meeting"] .event-text')).toBeNull()
    expect(document.querySelector('[data-item-id="meeting"] .importance-label')).not.toBeNull()
  })

  it('retains failed drafts, prevents concurrent exits and applies classification only after a successful retry', async () => {
    let rejectSave!: (cause: Error) => void
    const save = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject })).mockResolvedValue(undefined)
    const mocked = await start({ save })
    button('☷时间线设置').click(); await tick()
    await setField('打开时定位时间', '13:45')
    await setField('规则名称 1', '自定义审阅')
    await setField('关键词 1', '审阅、评审')
    await setField('大类 1', 'interest')
    button('保存设置').click(); await tick()
    expect(button('取消').disabled).toBe(true)
    expect(field<HTMLButtonElement>('下一天').disabled).toBe(true)
    expect(field<HTMLInputElement>('规则名称 1').matches(':disabled')).toBe(true)
    button('取消').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    field<HTMLButtonElement>('下一天').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(document.querySelector('.settings')).not.toBeNull()
    expect(mocked.request.mock.calls.some(([method]) => method === 'host.editor.open')).toBe(false)
    rejectSave(new Error('模拟磁盘写入失败'))
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('模拟磁盘写入失败'))
    expect(field<HTMLInputElement>('打开时定位时间').value).toBe('13:45')
    expect(field<HTMLInputElement>('规则名称 1').value).toBe('自定义审阅')
    expect(field<HTMLSelectElement>('大类 1').value).toBe('interest')
    expect(button('保存设置').disabled).toBe(false)
    button('保存设置').click()
    await vi.waitFor(() => expect(document.querySelector('.settings')).toBeNull())
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0].startTime).toBe('13:45')
    expect(save.mock.calls[1][0].classification[0]).toEqual({ id: 'review', name: '自定义审阅', keywords: ['审阅', '评审'], category: 'interest' })
    expect(document.querySelector<HTMLButtonElement>('.event')?.dataset.category).toBe('interest')
  })

  it('discards cancelled changes and persists add, remove and rule order from the settings panel', async () => {
    const mocked = await start()
    button('☷时间线设置').click(); await tick()
    await setField('大类 1', 'leisure')
    button('取消').click(); await tick()
    expect(document.querySelector<HTMLButtonElement>('.event')?.dataset.category).toBe('work')
    expect(mocked.request.mock.calls.some(([method]) => method === 'host.settings.set')).toBe(false)
    button('☷时间线设置').click(); await tick()
    expect(field<HTMLSelectElement>('大类 1').value).toBe('work')
    button('+ 添加规则').click(); await tick()
    await setField('规则名称 3', '研究兴趣')
    await setField('关键词 3', '研发')
    await setField('大类 3', 'interest')
    field<HTMLButtonElement>('上移规则 3').click(); await tick()
    field<HTMLButtonElement>('上移规则 2').click(); await tick()
    field<HTMLButtonElement>('删除规则 3').click(); await tick()
    button('保存设置').click()
    await vi.waitFor(() => expect(document.querySelector('.settings')).toBeNull())
    expect(document.querySelector<HTMLButtonElement>('.event')?.dataset.category).toBe('interest')
    expect(mocked.request).toHaveBeenCalledWith('host.settings.set', { key: 'timeline', value: { classification: [
      expect.objectContaining({ name: '研究兴趣', keywords: ['研发'], category: 'interest' }), initialRules[0],
    ], startTime: '09:00' } })
  })

  it('blocks settings after a load failure and allows retry without overwriting unread rules', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('读取失败')).mockResolvedValue({ settings: { classification: initialRules } })
    await start({ load })
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('读取失败'))
    expect(button('☷时间线设置').disabled).toBe(true)
    button('重试').click()
    await vi.waitFor(() => expect(button('☷时间线设置').disabled).toBe(false))
    button('☷时间线设置').click(); await tick()
    expect(field<HTMLInputElement>('规则名称 1').value).toBe('审阅')
  })

  it('handles unsupported documents via fallback and notes-only timelines without fake events', async () => {
    const mocked = await start()
    openDocument('---\ntype: timeline\n---\n- 25:00–26:00 — 开发：无效时间', 2)
    expect(mocked.posted).toHaveBeenCalledWith({ type: 'file_view.fallback', requestId: 2 }, 'http://localhost:1420')
    openDocument('---\ntype: timeline\n---\n# 安静的一天\n暂无活动。', 3)
    await tick()
    expect(document.querySelectorAll('.event')).toHaveLength(0)
    expect(document.body.textContent).toContain('暂无带时间的活动记录')
    expect(document.querySelector('.document-notes')?.textContent).toContain('暂无活动。')
  })

  it('offers an explicit repair draft for damaged rules and only replaces them after saving', async () => {
    const mocked = await start({ load: async () => ({ settings: { classification: [{ bad: true }] } }) })
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('替换损坏的时间线设置'))
    expect(button('☷时间线设置').disabled).toBe(true)
    button('重新设置').click(); await tick()
    expect(document.querySelectorAll('.rule').length).toBeGreaterThan(0)
    expect(button('重新设置').disabled).toBe(true)
    button('取消').click()
    await vi.waitFor(() => expect(document.activeElement).toBe(button('重新设置')))
    expect(mocked.request.mock.calls.some(([method]) => method === 'host.settings.set')).toBe(false)
    button('重新设置').click(); await tick()
    button('保存设置').click()
    await vi.waitFor(() => expect(document.querySelector('.settings')).toBeNull())
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(mocked.request).toHaveBeenCalledWith('host.settings.set', expect.objectContaining({ key: 'timeline' }))
    await vi.waitFor(() => expect(document.activeElement).toBe(button('☷时间线设置')))
  })

  it('uses the host language on its first frame', async () => {
    await start({ language: 'en' })
    expect(document.querySelector('.legend')?.textContent).toContain('Interests')
    expect(button('☷Settings')).toBeTruthy()
    expect(document.querySelector('h1')?.textContent).toContain('September 9')
  })

  it('loads the opening time and reapplies it after each new document', async () => {
    await start({ load: async () => ({ settings: { timeline: { classification: initialRules, startTime: '10:00' } } }) })
    const scroller = field<HTMLDivElement>('日程时间轴')
    const schedule = document.querySelector<HTMLDivElement>('.schedule')!
    Object.defineProperties(scroller, { scrollHeight: { value: 1200, configurable: true }, clientHeight: { value: 400, configurable: true } })
    Object.defineProperty(scroller, 'getBoundingClientRect', { value: () => rectAt(192), configurable: true })
    Object.defineProperty(schedule, 'getBoundingClientRect', { value: () => rectAt(207 - scroller.scrollTop), configurable: true })
    scroller.scrollTop = 0
    openDocument(fixture, 2, '/vault/diary/2026-09-10.timeline.md')
    await vi.waitFor(() => expect(scroller.scrollTop).toBe(127))
    scroller.scrollTop = 0
    openDocument(fixture, 3, '/vault/diary/2026-09-11.timeline.md')
    await vi.waitFor(() => expect(scroller.scrollTop).toBe(127))
  })

  it('navigates adjacent days and a chosen archive date through the actual host bridge', async () => {
    const mocked = await start()
    field<HTMLButtonElement>('上一天').click()
    await vi.waitFor(() => expect(mocked.request).toHaveBeenCalledWith('host.editor.open', { path: 'diary/2026-09-08.timeline.md', fileView: 'timeline', replaceCurrent: true, currentPath: 'diary/2026-09-09.timeline.md' }))
    field<HTMLButtonElement>('下一天').click()
    await vi.waitFor(() => expect(mocked.request).toHaveBeenCalledWith('host.editor.open', { path: 'diary/2026-09-10.timeline.md', fileView: 'timeline', replaceCurrent: true, currentPath: 'diary/2026-09-09.timeline.md' }))
    openDocument(fixture, 2, '/vault/diary/2026/2026-12-31.timeline.md'); await tick()
    const picker = field<HTMLInputElement>('选择日期')
    expect(picker.type).toBe('date')
    expect(picker.value).toBe('2026-12-31')
    picker.value = '2027-01-02'
    picker.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(mocked.request).toHaveBeenCalledWith('host.editor.open', { path: 'diary/2027/2027-01-02.timeline.md', fileView: 'timeline', replaceCurrent: true, currentPath: 'diary/2026/2026-12-31.timeline.md' }))
    expect(picker.value).toBe('2026-12-31')
    button('☷时间线设置').click(); await tick()
    expect(field<HTMLButtonElement>('上一天').disabled).toBe(true)
    expect(field<HTMLButtonElement>('下一天').disabled).toBe(true)
    expect(field<HTMLInputElement>('选择日期').disabled).toBe(true)
  })

  it('keeps the current day visible when the selected timeline is missing', async () => {
    const mocked = await start({ exists: false })
    field<HTMLButtonElement>('下一天').click()
    await vi.waitFor(() => expect(document.querySelector('.navigation-error')?.textContent).toContain('2026-09-10 暂无时间线'))
    expect(document.querySelector('h1')?.textContent).toContain('9月9日')
    expect(mocked.request.mock.calls.some(([method]) => method === 'host.editor.open')).toBe(false)
    expect(field<HTMLButtonElement>('下一天').disabled).toBe(false)
  })

  it('receives an open immediately after mount, before deferred mount effects run', async () => {
    const mocked = host()
    app = mount(App, { target: document.body })
    openDocument()
    await tick()
    expect(document.querySelectorAll('.event')).toHaveLength(2)
    expect(mocked.posted).toHaveBeenCalledWith({ type: 'file_view.ready', requestId: 1 }, 'http://localhost:1420')
    await unmount(app); app = undefined
    mocked.posted.mockClear()
    openDocument(fixture, 2)
    expect(mocked.posted).not.toHaveBeenCalled()
  })
})
