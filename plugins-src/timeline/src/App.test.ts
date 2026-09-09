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

function openDocument(content = fixture, requestId = 1, uri = '/vault/diary/2026-09-09.timeline.md') {
  window.dispatchEvent(new MessageEvent('message', { origin: 'http://localhost:1420', source: window, data: {
    type: 'file_view.open', viewId: 'timeline', requestId, uri, content,
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
