import { mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.svelte'
import type { ClassificationRule } from './lib/classification'

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

async function setField(label: string, value: string) {
  const input = field<HTMLInputElement | HTMLSelectElement>(label)
  input.value = value
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  await tick()
}

function openDocument(content = fixture, requestId = 1) {
  window.dispatchEvent(new MessageEvent('message', { origin: 'http://localhost:1420', source: window, data: {
    type: 'custom_editor.open', editorId: 'timeline', requestId, uri: '/vault/diary/2026-09-09.timeline.md', content,
  } }))
}

function host(options: { save?: (rules: ClassificationRule[]) => Promise<void>; load?: () => Promise<unknown>; language?: string } = {}) {
  const request = vi.fn(async (method: string, params?: any) => {
    if (method === 'host.settings.get') return options.load ? options.load() : { settings: { classification: structuredClone(initialRules) } }
    if (method === 'host.settings.set') { await options.save?.(params.value); return {} }
    if (method === 'host.vault.info') return { root: '/vault' }
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

  it('renders timed blocks, nested detail, notes, sources and the Markdown escape hatch through the real bridge', async () => {
    const mocked = await start()
    const cards = [...document.querySelectorAll<HTMLButtonElement>('.event')]
    expect(cards.map((card) => card.dataset.category)).toEqual(['work', 'life'])
    expect(cards[0].style.top).not.toBe(cards[1].style.top)
    expect(cards[0].style.left).not.toBe(cards[1].style.left)
    expect(document.querySelector('.document-notes')?.textContent).toContain('记录仅用于演示。')
    expect(document.querySelector('.original-title')?.textContent).toBe('示例时间线')
    expect(mocked.posted).toHaveBeenCalledWith({ type: 'custom_editor.ready', requestId: 1 }, 'http://localhost:1420')
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
    button('‹/›编辑 Markdown').click()
    expect(mocked.posted).toHaveBeenCalledWith(expect.objectContaining({ type: 'custom_editor.fallback', reason: 'edit' }), 'http://localhost:1420')
  })

  it('retains failed drafts, prevents concurrent exits and applies classification only after a successful retry', async () => {
    let rejectSave!: (cause: Error) => void
    const save = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject })).mockResolvedValue(undefined)
    const mocked = await start({ save })
    button('☷分类设置').click(); await tick()
    await setField('规则名称 1', '自定义审阅')
    await setField('关键词 1', '审阅、评审')
    await setField('大类 1', 'interest')
    button('保存分类').click(); await tick()
    expect(button('取消').disabled).toBe(true)
    expect(button('‹/›编辑 Markdown').disabled).toBe(true)
    expect(field<HTMLInputElement>('规则名称 1').matches(':disabled')).toBe(true)
    button('取消').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    button('‹/›编辑 Markdown').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(document.querySelector('.settings')).not.toBeNull()
    expect(mocked.posted).not.toHaveBeenCalledWith(expect.objectContaining({ reason: 'edit' }), expect.anything())
    rejectSave(new Error('模拟磁盘写入失败'))
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('模拟磁盘写入失败'))
    expect(field<HTMLInputElement>('规则名称 1').value).toBe('自定义审阅')
    expect(field<HTMLSelectElement>('大类 1').value).toBe('interest')
    expect(button('保存分类').disabled).toBe(false)
    button('保存分类').click()
    await vi.waitFor(() => expect(document.querySelector('.settings')).toBeNull())
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0][0]).toEqual({ id: 'review', name: '自定义审阅', keywords: ['审阅', '评审'], category: 'interest' })
    expect(document.querySelector<HTMLButtonElement>('.event')?.dataset.category).toBe('interest')
  })

  it('discards cancelled changes and persists add, remove and rule order from the settings panel', async () => {
    const mocked = await start()
    button('☷分类设置').click(); await tick()
    await setField('大类 1', 'leisure')
    button('取消').click(); await tick()
    expect(document.querySelector<HTMLButtonElement>('.event')?.dataset.category).toBe('work')
    expect(mocked.request.mock.calls.some(([method]) => method === 'host.settings.set')).toBe(false)
    button('☷分类设置').click(); await tick()
    expect(field<HTMLSelectElement>('大类 1').value).toBe('work')
    button('+ 添加规则').click(); await tick()
    await setField('规则名称 3', '研究兴趣')
    await setField('关键词 3', '研发')
    await setField('大类 3', 'interest')
    field<HTMLButtonElement>('上移规则 3').click(); await tick()
    field<HTMLButtonElement>('上移规则 2').click(); await tick()
    field<HTMLButtonElement>('删除规则 3').click(); await tick()
    button('保存分类').click()
    await vi.waitFor(() => expect(document.querySelector('.settings')).toBeNull())
    expect(document.querySelector<HTMLButtonElement>('.event')?.dataset.category).toBe('interest')
    expect(mocked.request).toHaveBeenCalledWith('host.settings.set', { key: 'classification', value: [
      expect.objectContaining({ name: '研究兴趣', keywords: ['研发'], category: 'interest' }), initialRules[0],
    ] })
  })

  it('blocks settings after a load failure and allows retry without overwriting unread rules', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('读取失败')).mockResolvedValue({ settings: { classification: initialRules } })
    await start({ load })
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('读取失败'))
    expect(button('☷分类设置').disabled).toBe(true)
    button('重试').click()
    await vi.waitFor(() => expect(button('☷分类设置').disabled).toBe(false))
    button('☷分类设置').click(); await tick()
    expect(field<HTMLInputElement>('规则名称 1').value).toBe('审阅')
  })

  it('handles unsupported documents via fallback and notes-only timelines without fake events', async () => {
    const mocked = await start()
    openDocument('---\ntype: timeline\n---\n- 25:00–26:00 — 开发：无效时间', 2)
    expect(mocked.posted).toHaveBeenCalledWith({ type: 'custom_editor.fallback', requestId: 2 }, 'http://localhost:1420')
    openDocument('---\ntype: timeline\n---\n# 安静的一天\n暂无活动。', 3)
    await tick()
    expect(document.querySelectorAll('.event')).toHaveLength(0)
    expect(document.body.textContent).toContain('暂无带时间的活动记录')
    expect(document.querySelector('.document-notes')?.textContent).toContain('暂无活动。')
  })

  it('offers an explicit repair draft for damaged rules and only replaces them after saving', async () => {
    const mocked = await start({ load: async () => ({ settings: { classification: [{ bad: true }] } }) })
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('替换损坏的分类规则'))
    expect(button('☷分类设置').disabled).toBe(true)
    button('重新设置分类').click(); await tick()
    expect(document.querySelectorAll('.rule').length).toBeGreaterThan(0)
    expect(button('重新设置分类').disabled).toBe(true)
    button('取消').click()
    await vi.waitFor(() => expect(document.activeElement).toBe(button('重新设置分类')))
    expect(mocked.request.mock.calls.some(([method]) => method === 'host.settings.set')).toBe(false)
    button('重新设置分类').click(); await tick()
    button('保存分类').click()
    await vi.waitFor(() => expect(document.querySelector('.settings')).toBeNull())
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(mocked.request).toHaveBeenCalledWith('host.settings.set', expect.objectContaining({ key: 'classification' }))
    await vi.waitFor(() => expect(document.activeElement).toBe(button('☷分类设置')))
  })

  it('uses the host language on its first frame', async () => {
    await start({ language: 'en' })
    expect(document.querySelector('.legend')?.textContent).toContain('Interests')
    expect(button('☷Categories')).toBeTruthy()
    expect(document.querySelector('h1')?.textContent).toContain('September 9')
  })
})
