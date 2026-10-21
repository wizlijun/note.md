import { mount, tick, unmount } from 'svelte'
import { fromStore, writable } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TimelineDetail from './TimelineDetail.svelte'
import { parseTimeline } from '../parser'
import type { EventEdit } from '../edit-document'

const item = parseTimeline(`---
type: timeline
---
- 09:00:10–24:00 — 研发：讨论编辑能力 [来源](notes/source.md)
  - 09:15:20–09:30:30 — 讨论：子议题 [子来源](notes/child.md)
`)!.items[0]

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label)
  if (!match) throw new Error(`Missing button: ${label}`)
  return match
}

function field(label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const match = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)
  if (!match) throw new Error(`Missing field: ${label}`)
  return match
}

async function change(label: string, value: string) {
  const input = field(label)
  input.value = value
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  await tick()
}

async function submit() {
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await tick()
}

function escape() { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) }

describe('Timeline detail editing', () => {
  let component: ReturnType<typeof mount> | undefined
  afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  async function start(options: { editable?: boolean; save?: () => Promise<void>; zh?: boolean; event?: typeof item } = {}) {
    const onsave = vi.fn(async (_item: typeof item, _edit: EventEdit) => { await options.save?.() })
    const onclose = vi.fn()
    const onlink = vi.fn(async () => {})
    const onediting = vi.fn()
    const editability = fromStore(writable(options.editable ?? true))
    component = mount(TimelineDetail, { target: document.body, props: {
      item: options.event ?? item, rules: [], zh: options.zh ?? true, get editable() { return editability.current }, onsave, onclose, onlink, onediting,
    } })
    await tick()
    return { onsave, onclose, onlink, onediting, setEditable(value: boolean) { editability.current = value } }
  }

  it('edits parent title, description, second-precision times and native importance selection', async () => {
    const calls = await start()
    button('编辑 研发').click(); await tick()
    expect(calls.onediting).toHaveBeenLastCalledWith(true)
    await vi.waitFor(() => expect(document.activeElement).toBe(field('标题')))
    expect(field('开始时间').value).toBe('09:00:10')
    expect(field('结束时间').value).toBe('24:00')
    expect(field('重要程度').tagName).toBe('SELECT')
    expect([...document.querySelectorAll('option')].map(option => option.value)).toEqual(['high', 'normal', 'unknown'])
    await change('标题', '需求评审')
    await change('事件描述', '确认保存体验')
    await change('开始时间', '08:59:59')
    await change('重要程度', 'high')
    await submit()
    await vi.waitFor(() => expect(document.querySelector('form')).toBeNull())
    expect(calls.onsave).toHaveBeenCalledExactlyOnceWith(item, { title: '需求评审', text: '确认保存体验', start: '08:59:59', end: '24:00', importance: 'high' })
    expect(calls.onediting).toHaveBeenLastCalledWith(false)
    await vi.waitFor(() => expect(document.activeElement).toBe(button('编辑 研发')))
  })

  it('edits nested topics independently', async () => {
    const calls = await start()
    button('编辑 讨论').click(); await tick()
    expect(field('事件描述').value).toBe('子议题')
    expect(field('结束时间').value).toBe('09:30:30')
    await change('标题', '决定')
    await change('重要程度', 'normal')
    await submit()
    await vi.waitFor(() => expect(calls.onsave).toHaveBeenCalledOnce())
    expect(calls.onsave.mock.calls[0][0]).toBe(item.children[0])
    expect(calls.onsave.mock.calls[0][1]).toMatchObject({ title: '决定', importance: 'normal' })
  })

  it('Escape cancels the draft first, then closes details; cancel never saves', async () => {
    const calls = await start()
    button('编辑 研发').click(); await tick()
    await change('标题', '未保存')
    escape(); await tick()
    expect(document.querySelector('form')).toBeNull()
    expect(calls.onclose).not.toHaveBeenCalled()
    button('编辑 研发').click(); await tick()
    expect(field('标题').value).toBe('研发')
    button('取消').click(); await tick()
    expect(calls.onsave).not.toHaveBeenCalled()
    escape(); await tick()
    expect(calls.onclose).toHaveBeenCalledOnce()
  })

  it('retains the entire draft and permits retry after a failed save', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('文件已变化')).mockResolvedValueOnce(undefined)
    const calls = await start({ save })
    button('编辑 研发').click(); await tick()
    await change('标题', '保留的标题')
    await change('事件描述', '保留的描述')
    await change('重要程度', 'normal')
    await submit()
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('文件已变化'))
    expect(field('标题').value).toBe('保留的标题')
    expect(field('事件描述').value).toBe('保留的描述')
    expect(field('重要程度').value).toBe('normal')
    expect(calls.onediting).toHaveBeenLastCalledWith(true)
    await submit()
    await vi.waitFor(() => expect(document.querySelector('form')).toBeNull())
    expect(calls.onsave).toHaveBeenCalledTimes(2)
  })

  it('blocks duplicate submits, closing, cancellation and source navigation during save', async () => {
    let resolve!: () => void
    const calls = await start({ save: () => new Promise<void>(done => { resolve = done }) })
    button('编辑 研发').click(); await tick()
    await submit()
    await submit()
    expect(calls.onsave).toHaveBeenCalledOnce()
    expect(document.querySelector('fieldset')?.disabled).toBe(true)
    expect(button('关闭详情').disabled).toBe(true)
    expect(button('编辑 讨论').disabled).toBe(true)
    const source = document.querySelector<HTMLButtonElement>('.source-link')!
    expect(source.disabled).toBe(true)
    source.click()
    button('关闭详情').click()
    escape(); await tick()
    expect(document.querySelector('form')).not.toBeNull()
    expect(calls.onclose).not.toHaveBeenCalled()
    expect(calls.onlink).not.toHaveBeenCalled()
    resolve()
    await vi.waitFor(() => expect(document.querySelector('form')).toBeNull())
  })

  it('rejects invalid times and empty content while allowing a description-only event', async () => {
    const calls = await start({ event: { ...item, action: '' } })
    button('编辑 讨论编辑能力').click(); await tick()
    expect(field('标题').value).toBe('')
    await change('开始时间', '24:00:01')
    await submit()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('时间格式')
    await change('开始时间', '10:00')
    await change('结束时间', '09:00')
    await submit()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('不能早于')
    await change('结束时间', '10:00')
    await change('事件描述', ' ')
    await submit()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('不能同时为空')
    expect(calls.onsave).not.toHaveBeenCalled()
    await change('事件描述', '第一行\n第二行')
    await submit()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('删除换行')
    expect(calls.onsave).not.toHaveBeenCalled()
    await change('事件描述', '只有描述')
    await submit()
    await vi.waitFor(() => expect(calls.onsave).toHaveBeenCalledOnce())
    expect(calls.onsave.mock.calls[0][1]).toMatchObject({ title: '', text: '只有描述', start: '10:00', end: '10:00' })
  })

  it('explains the host upgrade requirement without exposing an unsupported editor', async () => {
    await start({ editable: false, zh: false })
    expect(document.querySelector('.detail')?.textContent).toContain('Update note.md')
    expect(document.querySelectorAll('.source-limit')).toHaveLength(1)
    expect(document.querySelectorAll('.edit-limit')).toHaveLength(1)
    expect(document.querySelectorAll('.edit-event')).toHaveLength(0)
    expect(button('Close details').disabled).toBe(false)
  })

  it('retains a draft when the host becomes read-only and still permits cancellation', async () => {
    const calls = await start({ save: async () => { throw new Error('只读状态不能保存') } })
    button('编辑 研发').click(); await tick()
    await change('标题', '保留标题')
    await change('事件描述', '保留描述')
    await change('重要程度', 'high')
    calls.setEditable(false)
    await tick()
    expect(field('标题').value).toBe('保留标题')
    expect(field('事件描述').value).toBe('保留描述')
    expect(field('重要程度').value).toBe('high')
    expect(document.querySelectorAll('.edit-event')).toHaveLength(0)
    await submit()
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('只读状态不能保存'))
    expect(field('标题').value).toBe('保留标题')
    button('取消').click(); await tick()
    expect(document.querySelector('form')).toBeNull()
    expect(calls.onediting).toHaveBeenLastCalledWith(false)
    expect(button('关闭详情').disabled).toBe(false)
    expect(document.querySelector('.edit-limit')?.textContent).toContain('只读')
  })

  it('does not let an unmounted editor end editing in a newly opened document after a late save result', async () => {
    let resolve!: () => void
    const calls = await start({ save: () => new Promise<void>(done => { resolve = done }) })
    button('编辑 研发').click(); await tick()
    await submit()
    await unmount(component!)
    component = undefined
    expect(calls.onediting.mock.calls.map(call => call[0])).toEqual([true, false])
    resolve()
    await tick()
    await tick()
    expect(calls.onediting.mock.calls.map(call => call[0])).toEqual([true, false])
  })
})
