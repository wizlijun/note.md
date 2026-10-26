// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { parseReminderPreference, type ReminderView } from '../lib/reminders'
import { localTimeZone } from './reminder-time'
import type { WorkspaceItem } from '../lib/repository'
import { setLocale } from '../lib/strings'
import ReminderSheet from './ReminderSheet.svelte'

vi.mock('./reminder-time', async () => {
  const actual = await vi.importActual<typeof import('./reminder-time')>('./reminder-time')
  return { ...actual, localTimeZone: vi.fn(() => 'Asia/Taipei') }
})

let component: ReturnType<typeof mount> | null = null
const automatic: ReminderView = { policy: 'enabled', status: 'automatic', raw: null }
const task: WorkspaceItem = {
  key: 'task:delivery', kind: 'task', item_id: 'delivery', title: '交付版本', state: 'capture',
  path: 'inbox/tasks/delivery-task.md', due: '2026-10-28',
  proofed: false, orphan: false, relinkCandidates: [], relinkMatch: null,
}

beforeEach(() => {
  setLocale('zh')
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  vi.mocked(localTimeZone).mockReturnValue('Asia/Taipei')
})

afterEach(() => {
  if (component) unmount(component)
  component = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
  setLocale('en')
})

function render(view = automatic, item = task, saving = false, onSubmit = vi.fn(async (_input: { policy: 'enabled' | 'muted'; paused_until?: string }) => {})) {
  const onCancel = vi.fn()
  component = mount(ReminderSheet, { target: document.body, props: { item, view, saving, onCancel, onSubmit } })
  flushSync()
  return { onCancel, onSubmit }
}

function pause(value: string) {
  const input = document.querySelector<HTMLInputElement>('[name="pausedUntil"]')!
  input.value = value
  input.dispatchEvent(new InputEvent('input', { bubbles: true }))
  flushSync()
}

function submit() {
  document.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
  flushSync()
}

async function settled() {
  await Promise.resolve()
  await Promise.resolve()
  flushSync()
}

describe('ReminderSheet', () => {
  it('shows the task, due date, current state, IANA zone and truthful reminder behavior', () => {
    render()
    expect(document.querySelector('h2')?.textContent).toContain('交付版本')
    expect(document.querySelector('[data-reminder-due]')?.textContent).toBe('2026-10-28')
    expect(document.querySelector('[data-reminder-status]')?.textContent).toBe('自动提醒')
    expect(document.body.textContent).toContain('本机时区：Asia/Taipei')
    expect(document.body.textContent).toContain('关闭提醒不会完成任务')
    expect(document.body.textContent).toContain('不会立即推送')
    expect(document.body.textContent).toContain('下次推送同步时生效')
    expect(document.body.textContent).toContain('当前屏幕可能仍显示此前的消息')
  })

  it('shows a missing due date explicitly', () => {
    render(automatic, { ...task, due: undefined })
    expect(document.querySelector('[data-reminder-due]')?.textContent).toBe('未设置截止日期')
  })

  it('prefills a pause in local time and saves its UTC instant', async () => {
    const { onSubmit, onCancel } = render({ ...automatic, status: 'paused', pausedUntil: '2026-10-27T01:00:00Z' })
    expect(document.querySelector<HTMLInputElement>('[name="pausedUntil"]')?.value).toBe('2026-10-27T09:00')
    pause('2026-10-28T09:30')
    submit()
    await settled()
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ policy: 'enabled', paused_until: '2026-10-28T01:30:00Z' })
    expect(onCancel).not.toHaveBeenCalled()
    const id = '11111111-1111-4111-8111-111111111111'
    expect(() => parseReminderPreference(JSON.stringify({
      version: 1, task_id: id, updated_at: '2026-01-01T00:00:00Z', ...onSubmit.mock.calls[0][0],
    }), id)).not.toThrow()
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
  })

  it('preserves the original seconds and offset when saving an unchanged pause', async () => {
    const pausedUntil = '2026-10-27T09:00:47+08:00'
    const { onSubmit } = render({ ...automatic, status: 'paused', pausedUntil })
    expect(document.querySelector<HTMLInputElement>('[name="pausedUntil"]')?.value).toBe('2026-10-27T09:00')
    submit()
    await settled()
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ policy: 'enabled', paused_until: pausedUntil })
    const id = '11111111-1111-4111-8111-111111111111'
    expect(() => parseReminderPreference(JSON.stringify({
      version: 1, task_id: id, updated_at: '2026-01-01T00:00:00Z', ...onSubmit.mock.calls[0][0],
    }), id)).not.toThrow()
  })

  it.each(['-04:00', '-05:00'])('preserves a stored DST occurrence with offset %s when the local draft is unchanged', async (offset) => {
    vi.mocked(localTimeZone).mockReturnValue('America/New_York')
    const pausedUntil = `2026-11-01T01:30:45${offset}`
    const { onSubmit } = render({ ...automatic, status: 'paused', pausedUntil })
    expect(document.querySelector<HTMLInputElement>('[name="pausedUntil"]')?.value).toBe('2026-11-01T01:30')
    submit()
    await settled()
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ policy: 'enabled', paused_until: pausedUntil })
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('rejects an unchanged pause that expires while the sheet is open', () => {
    const { onSubmit } = render({ ...automatic, status: 'paused', pausedUntil: '2026-01-01T00:00:30Z' })
    vi.setSystemTime(new Date('2026-01-01T00:00:31Z'))
    submit()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('必须晚于现在')
  })

  it('clears a pause when automatic reminders are restored', async () => {
    const { onSubmit } = render({ ...automatic, status: 'paused', pausedUntil: '2026-10-27T01:00:00Z' })
    pause('')
    submit()
    await settled()
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ policy: 'enabled' })
  })

  it('saves muted without carrying a paused timestamp', async () => {
    const { onSubmit } = render({ ...automatic, status: 'paused', pausedUntil: '2026-10-27T01:00:00Z' })
    const policy = document.querySelector<HTMLSelectElement>('[name="reminderPolicy"]')!
    for (const option of policy.options) option.selected = option.value === 'muted'
    expect(policy.value).toBe('muted')
    policy.dispatchEvent(new Event('change', { bubbles: true }))
    flushSync()
    expect(document.querySelector<HTMLInputElement>('[name="pausedUntil"]')?.disabled).toBe(true)
    submit()
    await settled()
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ policy: 'muted' })
  })

  it('rejects a pause in the past and preserves the entered time', () => {
    const { onSubmit } = render()
    pause('2025-12-31T09:00')
    submit()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('必须晚于现在')
    expect(document.querySelector<HTMLInputElement>('[name="pausedUntil"]')?.value).toBe('2025-12-31T09:00')
  })

  it.each([
    ['2026-03-08T02:30', '不存在'],
    ['2026-11-01T01:30', '出现两次'],
  ])('rejects a DST-invalid local time %s in the displayed IANA zone', (value, reason) => {
    vi.mocked(localTimeZone).mockReturnValue('America/New_York')
    const { onSubmit } = render()
    pause(value)
    submit()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('America/New_York')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(reason)
  })

  it.each(['closed', 'unsupported', 'legacy', 'error'] as const)('prevents overwriting a %s reminder and shows why', (reason) => {
    const view = reason === 'closed' || reason === 'unsupported' ? automatic : { ...automatic, status: reason, error: 'invalid JSON: original preserved' }
    const { onSubmit, onCancel } = render(view, reason === 'closed' || reason === 'unsupported' ? { ...task, state: reason } : task)
    expect(document.querySelector('form, select, input, button[type="submit"]')).toBeNull()
    expect(document.body.textContent).not.toContain('关闭提醒不会完成任务')
    expect(document.body.textContent).not.toContain('恢复后按现有提醒规则筛选')
    expect(document.body.textContent).toContain('下次推送同步时生效')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
    expect(onSubmit).not.toHaveBeenCalled()
    const buttons = document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toBe('关闭')
    buttons[0].click()
    expect(onCancel).toHaveBeenCalledOnce()
    if (reason === 'closed') expect(document.querySelector('[data-reminder-status]')?.textContent).toBe('不再提醒')
    if (reason === 'unsupported') expect(document.body.textContent).toContain('请先修复该任务')
    if (reason === 'legacy') expect(document.body.textContent).toContain('独立关闭记录仍生效')
    if (reason === 'error') {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('不会覆盖原记录')
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('invalid JSON: original preserved')
    }
  })

  it('keeps a failed edit, supports retry and blocks double submit or cancellation while pending', async () => {
    let reject!: (error: Error) => void
    const onSubmit = vi.fn(async (_input: { policy: 'enabled' | 'muted'; paused_until?: string }) => {})
      .mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const { onCancel } = render(automatic, task, false, onSubmit)
    pause('2026-10-28T09:30')
    submit()
    submit()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.querySelector<HTMLElement>('.scrim')!.click()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    reject(new Error('disk full'))
    await settled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('当前编辑仍保留')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('disk full')
    expect(document.querySelector<HTMLInputElement>('[name="pausedUntil"]')?.value).toBe('2026-10-28T09:30')
    submit()
    await settled()
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('traps focus, cancels with Escape or the scrim and restores the previous focus', async () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    anchor.focus()
    const { onCancel } = render()
    await settled()
    expect(document.activeElement).toBe(document.querySelector('[name="reminderPolicy"]'))
    const first = document.querySelector<HTMLElement>('.close')!
    const last = document.querySelector<HTMLElement>('button[type="submit"]')!
    last.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(first)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(last)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.querySelector<HTMLElement>('.scrim')!.click()
    expect(onCancel).toHaveBeenCalledTimes(2)
    unmount(component!)
    component = null
    expect(document.activeElement).toBe(anchor)
  })
})
