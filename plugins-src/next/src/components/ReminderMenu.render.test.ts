// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { parseReminderPreference, type ReminderView } from '../lib/reminders'
import { localTimeZone } from './reminder-time'
import { setLocale } from '../lib/strings'
import ReminderMenu from './ReminderMenu.svelte'

vi.mock('./reminder-time', async () => {
  const actual = await vi.importActual<typeof import('./reminder-time')>('./reminder-time')
  return { ...actual, localTimeZone: vi.fn(() => 'Asia/Taipei') }
})

let component: ReturnType<typeof mount> | null = null
const automatic: ReminderView = { policy: 'enabled', status: 'automatic', raw: null }

beforeEach(() => {
  setLocale('zh')
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-26T00:30:00.567Z'))
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

function render(view = automatic, saving = false) {
  const anchor = document.createElement('button')
  document.body.appendChild(anchor)
  const callbacks = { onCancel: vi.fn(), onSelect: vi.fn(), onMore: vi.fn() }
  component = mount(ReminderMenu, { target: document.body, props: {
    anchor, itemTitle: '交付版本', view, saving, ...callbacks,
  } })
  flushSync()
  return { anchor, ...callbacks }
}

function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((row) => row.textContent === label)!
  expect(button).toBeTruthy()
  button.click()
  flushSync()
}

describe('ReminderMenu', () => {
  it.each([
    ['暂停 1 小时', { policy: 'enabled', paused_until: '2026-10-26T01:30:00Z' }],
    ['暂停至明早 9 点', { policy: 'enabled', paused_until: '2026-10-27T01:00:00Z' }],
    ['关闭提醒', { policy: 'muted' }],
  ])('selects %s directly using a precise reminder policy', (label, input) => {
    const { onSelect } = render()
    expect(document.querySelector('[role="menu"]')?.classList.contains('menu-panel')).toBe(true)
    expect([...document.querySelectorAll('[role="menuitem"]')].every((row) => row.classList.contains('menu-row'))).toBe(true)
    click(label as string)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(input)
    const id = '11111111-1111-4111-8111-111111111111'
    expect(() => parseReminderPreference(JSON.stringify({
      version: 1, task_id: id, updated_at: '2026-10-26T00:30:00Z', ...onSelect.mock.calls[0][0],
    }), id)).not.toThrow()
  })

  it.each(['muted', 'paused'] as const)('restores automatic reminders from %s without a pause timestamp', (status) => {
    const { onSelect } = render({ ...automatic, status, policy: status === 'muted' ? 'muted' : 'enabled', pausedUntil: '2026-10-28T01:00:00Z' })
    click('恢复自动提醒')
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ policy: 'enabled' })
    if (status === 'muted') expect(document.body.textContent).not.toContain('暂停 1 小时')
  })

  it.each(['legacy', 'error'] as const)('offers only details for %s records', (status) => {
    const { onMore, onSelect } = render({ ...automatic, status, error: 'broken record' })
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(1)
    click('更多…')
    expect(onMore).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('supports keyboard navigation, cancellation and focus restoration', () => {
    const { anchor, onCancel } = render()
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(document.activeElement).toBe(menu)
    const key = (value: string) => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
      flushSync()
    }
    key('ArrowUp')
    expect(document.activeElement).toBe(rows.at(-1))
    key('ArrowDown')
    expect(document.activeElement).toBe(rows[0])
    key('End')
    expect(document.activeElement).toBe(rows.at(-1))
    key('Home')
    expect(document.activeElement).toBe(rows[0])
    key('Escape')
    expect(onCancel).toHaveBeenCalledOnce()
    unmount(component!)
    component = null
    expect(document.activeElement).toBe(anchor)
  })

  it('cancels on Tab or an outside pointer without changing policy', () => {
    const { onCancel, onSelect } = render()
    document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('blocks selection and cancellation while saving', () => {
    const { onCancel, onSelect, onMore } = render(automatic, true)
    expect([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].every((row) => row.disabled)).toBe(true)
    click('暂停 1 小时')
    click('更多…')
    document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onCancel).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    expect(onMore).not.toHaveBeenCalled()
  })
})
