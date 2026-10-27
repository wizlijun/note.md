// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { reduceEvents } from './lib/domain'
import type { NextWorkspace, WorkspaceItem } from './lib/repository'
import type { ReminderView } from './lib/reminders'
import type { NextSettings } from './lib/settings'
import type { CreateTaskResult } from './lib/store.svelte'
import { CompletionNoteError, type CompletionNoteOperation } from './lib/completion-note'

const mocks = vi.hoisted(() => ({
  state: {
    workspace: null as NextWorkspace | null,
    loading: false,
    saving: false,
    error: null as string | null,
    reminders: {} as Record<string, ReminderView>,
    settings: { wipLimit: 5, defaultPriority: 'P2', defaultDueDays: 0, defaultContext: '' } as NextSettings,
  },
  refresh: vi.fn(async () => {}),
  createIdea: vi.fn(async () => 'inbox/ideas/new-idea.md'),
  createTask: vi.fn(async (): Promise<CreateTaskResult> => ({ path: 'inbox/tasks/new-task.md', placedCurrent: false })),
  place: vi.fn(async () => {}),
  completeWithNote: vi.fn(async (_item: WorkspaceItem, _operation: CompletionNoteOperation) => {}),
  reopen: vi.fn(async () => {}),
  relink: vi.fn(async () => {}),
  open: vi.fn(async () => {}),
  updateSettings: vi.fn(async () => {}),
  updateMetadata: vi.fn(async () => ({})),
  updateReminder: vi.fn(async () => ({})),
  toast: vi.fn(async () => {}),
}))

vi.mock('./lib/bridge', () => ({
  bridge: () => ({ locale: 'zh' }),
  toast: mocks.toast,
  vaultExists: vi.fn(),
  vaultList: vi.fn(),
  vaultRead: vi.fn(),
  vaultWrite: vi.fn(),
  editorOpen: vi.fn(),
}))

vi.mock('./lib/store.svelte', () => ({
  state: mocks.state,
  refresh: mocks.refresh,
  createIdea: mocks.createIdea,
  createTask: mocks.createTask,
  place: mocks.place,
  completeWithNote: mocks.completeWithNote,
  reopen: mocks.reopen,
  relink: mocks.relink,
  open: mocks.open,
  updateSettings: mocks.updateSettings,
  updateMetadata: mocks.updateMetadata,
  updateReminder: mocks.updateReminder,
}))

import App from './App.svelte'

let component: ReturnType<typeof mount> | null = null

afterEach(() => {
  if (component) unmount(component)
  component = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
  mocks.createIdea.mockResolvedValue('inbox/ideas/new-idea.md')
  mocks.createTask.mockResolvedValue({ path: 'inbox/tasks/new-task.md', placedCurrent: false })
  mocks.updateSettings.mockResolvedValue(undefined)
  mocks.updateMetadata.mockResolvedValue({})
  mocks.updateReminder.mockResolvedValue({})
  mocks.state.reminders = {}
  mocks.place.mockResolvedValue(undefined)
  mocks.completeWithNote.mockResolvedValue(undefined)
  mocks.reopen.mockResolvedValue(undefined)
  mocks.state.saving = false
  mocks.state.settings = { wipLimit: 5, defaultPriority: 'P2', defaultDueDays: 0, defaultContext: '' }
  vi.useRealTimers()
})

const item = (key: string, title: string, state: WorkspaceItem['state']): WorkspaceItem => ({
  key,
  state,
  title,
  body: `# ${title}\n\n第一段。\n\n这是完整 Idea 的最后一段。`,
  path: `inbox/ideas/${key}-idea.md`,
  proofed: false,
  orphan: false,
  relinkCandidates: [],
  relinkMatch: null,
})

function workspace(): NextWorkspace {
  const wip: WorkspaceItem = {
    ...item('wip', '正在验证的想法', 'wip'),
    idea_id: 'wip',
    projection: {
      idea_id: 'wip',
      state: 'wip',
      last_event_id: 'e-wip',
      last_at: '2026-08-30T00:00:00Z',
      projects: ['Next', 'Research', 'Product'],
      project: 'Next',
      commitment: '验证项目标记',
      next_action: '运行测试',
      close_condition: '可以复用',
    },
  }
  const waiting = item('waiting', '等待设计稿', 'waiting')
  const capture = item('capture', '默认隐藏的想法', 'capture')
  const dormant: WorkspaceItem = {
    ...item('dormant', '以后再看的想法', 'dormant'),
    idea_id: 'dormant',
    projection: {
      idea_id: 'dormant',
      state: 'dormant',
      last_event_id: 'e-dormant',
      last_at: '2026-08-29T00:00:00Z',
      wake_trigger: '2026-12-01',
    },
  }
  const closed: WorkspaceItem = {
    ...item('closed', '已经关闭的想法', 'closed'),
    idea_id: 'closed',
    projection: {
      idea_id: 'closed',
      state: 'closed',
      last_event_id: 'e-closed',
      last_at: '2026-08-28T00:00:00Z',
      exit: { kind: 'done' },
    },
  }
  return {
    ledger: { type: 'Next', version: 1, source_dirs: ['inbox/ideas'], events: [], extra: {} },
    ledgerRaw: null,
    sourceDirs: ['inbox/ideas'],
    ideaDir: 'inbox/ideas',
    projection: reduceEvents([]),
    sources: [],
    items: [wip, waiting, capture, dormant, closed],
    capture: [capture],
    wip: [wip],
    waiting: [waiting],
    dormant: [dormant],
    closed: [closed],
    unsupported: [],
    projectOptions: [],
    scanErrors: [],
    readOnlyError: null,
  }
}

function withWipLimit(next: NextWorkspace, count: number, limit = 5): NextWorkspace {
  const seed = next.wip[0]!
  const wip = Array.from({ length: count }, (_, index) => ({
    ...seed,
    key: `wip-${index + 1}`,
    item_id: `wip-${index + 1}`,
    idea_id: `wip-${index + 1}`,
    title: `进行中 ${index + 1}`,
    projection: seed.projection ? {
      ...seed.projection,
      idea_id: `wip-${index + 1}`,
    } : undefined,
  }))
  return {
    ...next,
    items: [...next.items.filter((entry) => entry.state !== 'wip'), ...wip],
    wip,
    projection: {
      ...next.projection,
      wipCount: count,
      wipLimit: limit,
      wipAtLimit: count >= limit,
      wipExceeded: count > limit,
    },
  }
}

function targetLane(lane: string, left = 300): HTMLElement {
  const target = document.querySelector<HTMLElement>(`[data-lane="${lane}"]`)!
  target.getBoundingClientRect = () => ({
    x: left, y: 0, left, top: 0, right: left + 200, bottom: 500,
    width: 200, height: 500, toJSON: () => ({}),
  })
  return target
}

function pointerDrag(itemKey: string, lane: string, pointerId = 1): void {
  targetLane(lane)
  document.querySelector<HTMLElement>(`[data-item-key="${itemKey}"]`)!
    .dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, button: 0, pointerId, clientX: 10, clientY: 10,
    }))
  window.dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true, pointerId, clientX: 350, clientY: 50,
  }))
  window.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, pointerId, clientX: 350, clientY: 50,
  }))
  flushSync()
}

describe('Next window', () => {
  it('opens Task completion with a multiline note and preserves one operation through a failed completion retry', async () => {
    const next = workspace()
    const task: WorkspaceItem = { ...next.capture[0], kind: 'task',
      path: 'inbox/tasks/completion-task.md', item_id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8',
      task: { version: 1, id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8' } }
    next.capture = [task]; next.items = [task, ...next.items.filter((entry) => entry.state !== 'capture')]
    mocks.state.workspace = next
    let reject!: (error: Error) => void
    mocks.completeWithNote.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    component = mount(App, { target: document.body }); flushSync()
    document.querySelector<HTMLButtonElement>('[data-item-key="capture"] .place')!.click(); flushSync()
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(options[0].textContent).toBe('完成并记一笔')
    expect(options.map((option) => option.textContent)).toContain('完成')
    options[0].click(); flushSync(); await Promise.resolve()
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
    expect(document.activeElement).toBe(textarea)
    const note = '完成第一步\n\n粘贴多行记录\n  保留缩进'
    textarea.value = note; textarea.dispatchEvent(new InputEvent('input', { bubbles: true })); flushSync()
    const submit = () => document.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    submit(); flushSync(); submit(); flushSync()
    expect(mocks.completeWithNote).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-completion-confetti]')).toBeNull()
    expect(textarea.readOnly).toBe(true)
    reject(new CompletionNoteError(true, new Error('ledger write failed')))
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('记录已写入 Task 原文'))
    expect(textarea.value).toBe(note)
    expect(textarea.readOnly).toBe(true)
    const operation = mocks.completeWithNote.mock.calls[0][1]
    expect(operation.note).toBe(note)
    expect(operation.event).not.toHaveProperty('result')
    submit()
    await vi.waitFor(() => expect(mocks.completeWithNote).toHaveBeenCalledTimes(2))
    expect(mocks.completeWithNote.mock.calls[1][1]).toBe(operation)
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect(document.querySelector('[data-completion-confetti]')).toBeTruthy()
    expect(mocks.reopen).not.toHaveBeenCalled()
    expect(mocks.place).not.toHaveBeenCalled()
  })

  it.each([
    ['现在推进', { route: 'commit', status_only: true }],
    ['等待回收', { route: 'wait', status_only: true }],
    ['以后再看', { route: 'park', status_only: true }],
    ['完成', { route: 'settle', exit: { kind: 'done' }, status_only: true }],
    ['停止', { route: 'settle', exit: { kind: 'stopped', via: 'drop' }, status_only: true }],
    ['转移他人', { route: 'settle', exit: { kind: 'transferred', via: 'delegate' }, status_only: true }],
  ])('saves %s from the placement menu with status only', async (label, input) => {
    const next = workspace()
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    document.querySelector<HTMLButtonElement>('[data-item-key="capture"] .place')!.click()
    flushSync()
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(options.map((option) => option.textContent)).toEqual([
      '现在推进', '等待回收', '以后再看', '完成', '停止', '转移他人', '更多…',
    ])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[role="menu"] input, [role="menu"] textarea')).toBeNull()
    options.find((option) => option.textContent === label)!.click()

    await vi.waitFor(() => expect(mocks.place).toHaveBeenCalledWith(next.capture[0], input))
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
    expect(mocks.place).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(Boolean(document.querySelector('[data-completion-confetti]'))).toBe(label === '完成')
  })

  it.each(['capture', 'wip', 'waiting', 'dormant'])('completes a %s card directly without a menu or form', async (source) => {
    const next = workspace()
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()
    const showPlaced = [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('显示已安放'))!
    showPlaced.click()
    flushSync()

    document.querySelector<HTMLButtonElement>(`[data-item-key="${source}"] [data-complete]`)!.click()
    flushSync()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    const completed = next.items.find((entry) => entry.key === source)!
    await vi.waitFor(() => expect(mocks.place).toHaveBeenCalledWith(completed, {
      route: 'settle', exit: { kind: 'done' }, status_only: true,
    }))
    expect(mocks.place).toHaveBeenCalledTimes(1)
    if (source === 'dormant') {
      expect(mocks.reopen).toHaveBeenCalledWith(completed)
      expect(mocks.reopen.mock.invocationCallOrder[0]).toBeLessThan(mocks.place.mock.invocationCallOrder[0])
    } else {
      expect(mocks.reopen).not.toHaveBeenCalled()
    }
    await vi.waitFor(() => expect(document.querySelector('[data-completion-confetti]')).toBeTruthy())
  })

  it('retries placement after reopening without reopening the already active card again', async () => {
    const next = workspace()
    mocks.state.workspace = next
    mocks.reopen.mockImplementationOnce(async () => {
      const index = next.items.findIndex((entry) => entry.key === 'dormant')
      next.items[index] = { ...next.items[index], state: 'capture' }
    })
    mocks.place.mockRejectedValueOnce(new Error('disk full'))
    component = mount(App, { target: document.body })
    flushSync()
    const showPlaced = [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('显示已安放'))!
    showPlaced.click()
    flushSync()
    document.querySelector<HTMLButtonElement>('[data-item-key="dormant"] .place')!.click()
    flushSync()
    const done = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent === '完成')!
    done.click()
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled())
    await vi.waitFor(() => expect(done.disabled).toBe(false))
    done.click()
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
    expect(mocks.reopen).toHaveBeenCalledTimes(1)
    expect(mocks.place).toHaveBeenCalledTimes(2)
  })

  it('renders status-only cards without undefined or empty detail text', () => {
    const next = workspace()
    for (const card of next.items) {
      const base = {
        idea_id: card.key,
        last_event_id: `e-${card.key}`,
        last_at: '2026-10-26T00:00:00Z',
      }
      if (card.state === 'wip') card.projection = { ...base, state: 'wip' }
      if (card.state === 'waiting') card.projection = { ...base, state: 'waiting' }
      if (card.state === 'dormant') card.projection = { ...base, state: 'dormant' }
      if (card.state === 'closed') card.projection = { ...base, state: 'closed', exit: { kind: 'done' } }
    }
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()
    const showPlaced = [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('显示已安放'))!
    showPlaced.click()
    flushSync()

    for (const key of ['wip', 'waiting', 'dormant', 'closed']) {
      const card = document.querySelector(`[data-item-key="${key}"]`)!
      expect(card.textContent).not.toContain('undefined')
      expect(card.textContent).not.toContain('null')
      expect(card.querySelector('.body > p')).toBeNull()
    }
    expect(document.querySelector('[data-item-key="dormant"] .place')).toBeTruthy()
  })

  it('opens the detailed placement form only from More and keeps its validation', () => {
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()

    document.querySelector<HTMLButtonElement>('[data-item-key="capture"] .place')!.click()
    flushSync()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    const more = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === '更多…')!
    more.click()
    flushSync()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    expect(document.querySelector('[data-choices-for="commitment"]')).toBeTruthy()
    document.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    flushSync()
    expect(mocks.place).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
  })

  it.each([false, true])('celebrates a detailed completion only after a successful save (failure: %s)', async (fails) => {
    mocks.state.workspace = workspace()
    let resolveSave!: () => void
    let rejectSave!: (error: Error) => void
    mocks.place.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      resolveSave = resolve
      rejectSave = reject
    }))
    component = mount(App, { target: document.body })
    flushSync()
    document.querySelector<HTMLButtonElement>('[data-item-key="capture"] .place')!.click()
    flushSync()
    const more = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === '更多…')!
    more.click()
    flushSync()
    document.querySelectorAll<HTMLButtonElement>('.routes button')[3]!.click()
    flushSync()
    const exitKind = document.querySelector<HTMLSelectElement>('[role="dialog"] select')!
    exitKind.value = 'done'
    exitKind.dispatchEvent(new Event('change', { bubbles: true }))
    flushSync()
    document.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(mocks.place).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-completion-confetti]')).toBeNull()

    if (fails) {
      rejectSave(new Error('disk full'))
      await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled())
      expect(document.querySelector('[data-completion-confetti]')).toBeNull()
      expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    } else {
      resolveSave()
      await vi.waitFor(() => expect(document.querySelector('[data-completion-confetti]')).toBeTruthy())
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    }
  })

  it('does not celebrate a quick completion before saving or when saving fails', async () => {
    mocks.state.workspace = workspace()
    let fail!: (error: Error) => void
    mocks.place.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    component = mount(App, { target: document.body })
    flushSync()
    document.querySelector<HTMLButtonElement>('[data-item-key="capture"] .place')!.click()
    flushSync()
    const done = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === '完成')!
    done.click()
    flushSync()
    expect(document.querySelector('[data-completion-confetti]')).toBeNull()
    fail(new Error('disk full'))
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled())
    expect(document.querySelector('[data-completion-confetti]')).toBeNull()
    expect(document.querySelector('[role="menu"]')).toBeTruthy()
  })

  it('keeps a failed placement menu available to retry and prevents duplicate submissions while pending', async () => {
    mocks.state.workspace = workspace()
    let fail!: (reason: Error) => void
    mocks.place.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    component = mount(App, { target: document.body })
    flushSync()
    document.querySelector<HTMLButtonElement>('[data-item-key="capture"] .place')!.click()
    flushSync()
    const first = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!
    first.click()
    first.click()
    flushSync()

    expect(mocks.place).toHaveBeenCalledTimes(1)
    expect([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].every((button) => button.disabled)).toBe(true)
    fail(new Error('disk full'))
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error', 'Next 无法保存这次安放。', 'Error: disk full'))
    await vi.waitFor(() => expect(first.disabled).toBe(false))
    expect(document.querySelector('[role="menu"]')).toBeTruthy()
    first.click()
    await vi.waitFor(() => expect(mocks.place).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  })

  it('cancels the placement menu with Escape or an outside pointer without saving', () => {
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()
    const anchor = document.querySelector<HTMLButtonElement>('[data-item-key="capture"] .place')!
    anchor.click()
    flushSync()
    document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    flushSync()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(anchor)

    anchor.click()
    flushSync()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    flushSync()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(mocks.place).not.toHaveBeenCalled()
  })

  it.each([false, true])('closes the placement menu when a creation shortcut opens a sheet (Task: %s)', (task) => {
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()
    document.querySelector<HTMLButtonElement>('[data-item-key="capture"] .place')!.click()
    flushSync()
    expect(document.querySelector('[role="menu"]')).toBeTruthy()

    document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'n', metaKey: true, shiftKey: task, bubbles: true, cancelable: true,
    }))
    flushSync()

    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(mocks.place).not.toHaveBeenCalled()
  })

  it('supports keyboard navigation and selection in the placement menu', async () => {
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()
    document.querySelector<HTMLButtonElement>('[data-item-key="capture"] .place')!.click()
    flushSync()
    const menu = document.querySelector('[role="menu"]')!
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    const key = (value: string) => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
      flushSync()
    }
    expect(document.activeElement).toBe(menu)
    key('ArrowUp')
    expect(document.activeElement).toBe(rows[6])
    key('ArrowDown')
    expect(document.activeElement).toBe(rows[0])
    key('End')
    expect(document.activeElement).toBe(rows[6])
    key('ArrowDown')
    expect(document.activeElement).toBe(rows[0])
    key('ArrowUp')
    expect(document.activeElement).toBe(rows[6])
    key('Home')
    expect(document.activeElement).toBe(rows[0])
    key('ArrowDown')
    expect(document.activeElement).toBe(rows[1])
    // Native buttons produce a click when activated with Enter or Space.
    const selected = document.activeElement as HTMLButtonElement
    selected.click()
    await vi.waitFor(() => expect(mocks.place).toHaveBeenCalledWith(mocks.state.workspace!.capture[0], { route: 'wait', status_only: true }))
  })

  it('defaults to priority sorting and switches the board to due or newest-first order', () => {
    const next = workspace()
    const cards: WorkspaceItem[] = [
      { ...item('sort-a', 'P0 later', 'capture'), priority: 'P0', due: '2026-09-20', created: '2026-09-06T00:00:00Z' },
      { ...item('sort-b', 'P1 sooner new', 'capture'), priority: 'P1', due: '2026-09-05', created: '2026-09-04T00:00:00Z' },
      { ...item('sort-c', 'P1 sooner old', 'capture'), priority: 'P1', due: '2026-09-05', created: '2026-09-03T00:00:00Z' },
      { ...item('sort-d', 'P2 earliest', 'capture'), priority: 'P2', due: '2026-09-01', created: '2026-09-05T00:00:00Z' },
    ]
    next.capture = cards
    next.items = [...next.items.filter((entry) => entry.state !== 'capture'), ...cards]
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    const keys = () => [...document.querySelectorAll<HTMLElement>('[data-lane="capture"] [data-item-key]')]
      .map((card) => card.dataset.itemKey)
    const sort = document.querySelector<HTMLSelectElement>('[name="sortMode"]')!
    const selectMode = (mode: string) => {
      for (const option of sort.options) option.selected = option.value === mode
      sort.dispatchEvent(new Event('change', { bubbles: true }))
      flushSync()
      expect(sort.value).toBe(mode)
    }
    expect(sort.value).toBe('priority')
    expect(keys()).toEqual(['sort-a', 'sort-b', 'sort-c', 'sort-d'])

    selectMode('due')
    expect(keys()).toEqual(['sort-d', 'sort-b', 'sort-c', 'sort-a'])

    selectMode('created')
    expect(keys()).toEqual(['sort-a', 'sort-d', 'sort-b', 'sort-c'])
  })

  it('sorts the whole Inbox before limiting the unfiltered view to ten cards', () => {
    const next = workspace()
    const normal = Array.from({ length: 10 }, (_, index) => ({
      ...item(`normal-${index}`, `Normal ${index}`, 'capture'),
      priority: 'P3' as const,
      created: `2026-09-01T00:00:${String(index).padStart(2, '0')}Z`,
    }))
    const urgent = {
      ...item('urgent-eleventh', 'Urgent eleventh', 'capture'),
      priority: 'P0' as const,
      created: '2026-08-01T00:00:00Z',
    }
    next.capture = [...normal, urgent]
    next.items = [...next.items.filter((entry) => entry.state !== 'capture'), ...next.capture]
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    const cards = [...document.querySelectorAll('[data-lane="capture"] [data-item-key]')]
    expect(cards).toHaveLength(10)
    expect(cards[0]?.getAttribute('data-item-key')).toBe('urgent-eleventh')
  })

  it('shows multiple project tags compactly on its card', () => {
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()
    expect([...document.querySelectorAll('[data-item-key="wip"] .badge.project')].map((badge) => badge.textContent))
      .toEqual(['Next', 'Research', '+1'])
  })

  it('shows a local Inbox project suggestion and requires a click before selecting it', () => {
    const next = workspace()
    next.capture[0].suggestedProject = {
      project: 'Next',
      reason: 'content',
      score: 4,
      matchedTerms: ['念头', '泳道'],
      candidatesScored: 1,
    }
    next.projectOptions = ['Next']
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    expect(document.querySelector('[data-project-tag="Next"]')).toBeNull()
    document.querySelector<HTMLButtonElement>('[data-project-suggestion="Next"]')!.click()
    flushSync()
    expect(document.querySelector('[role="dialog"] [data-project-tag="Next"]')).toBeTruthy()
    expect(mocks.place).not.toHaveBeenCalled()
  })

  it('previews the complete Idea body in a viewport tip on hover and keyboard focus', () => {
    vi.useFakeTimers()
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()

    const card = document.querySelector<HTMLElement>('[data-item-key="capture"]')!
    expect(document.querySelector('[role="tooltip"]')).toBeNull()

    card.dispatchEvent(new PointerEvent('pointerenter'))
    flushSync()
    let tip = document.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(tip.textContent).toContain('# 默认隐藏的想法')
    expect(tip.textContent).toContain('这是完整 Idea 的最后一段。')
    expect(tip.closest('.board-scroll')).toBeNull()
    expect(card.getAttribute('aria-describedby')).toBe(tip.id)
    const waitingCard = document.querySelector<HTMLElement>('[data-item-key="waiting"]')!
    expect(waitingCard.getAttribute('aria-describedby')).not.toBe(card.getAttribute('aria-describedby'))
    expect(document.getElementById(card.getAttribute('aria-labelledby')!)?.textContent).toBe('默认隐藏的想法')
    expect(tip.classList.contains('idea-preview-tip')).toBe(true)

    card.dispatchEvent(new PointerEvent('pointerleave', { relatedTarget: tip }))
    tip.dispatchEvent(new PointerEvent('pointerenter'))
    flushSync()
    expect(document.querySelector('[role="tooltip"]')).toBe(tip)
    tip.dispatchEvent(new PointerEvent('pointerleave'))
    vi.advanceTimersByTime(101)
    flushSync()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()

    card.focus()
    flushSync()
    tip = document.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(tip.textContent).toContain('这是完整 Idea 的最后一段。')
    Object.defineProperty(tip, 'clientHeight', { configurable: true, value: 200 })
    Object.defineProperty(tip, 'scrollHeight', { configurable: true, value: 1000 })
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }))
    expect(tip.scrollTop).toBe(160)
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    expect(tip.scrollTop).toBe(1000)
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
    expect(tip.scrollTop).toBe(0)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    flushSync()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('renders Idea Markdown as text and does not preview a missing source', () => {
    vi.useFakeTimers()
    const next = workspace()
    next.capture[0].body = '<img src=x onerror="alert(1)">\n\n最后一行'
    next.wip[0].body = undefined
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    const capture = document.querySelector<HTMLElement>('[data-item-key="capture"]')!
    capture.dispatchEvent(new PointerEvent('pointerenter'))
    flushSync()
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(tip.textContent).toContain('<img src=x onerror="alert(1)">')
    expect(tip.querySelector('img')).toBeNull()

    capture.dispatchEvent(new PointerEvent('pointerleave'))
    document.querySelector<HTMLElement>('[data-item-key="wip"]')!
      .dispatchEvent(new PointerEvent('pointerenter'))
    vi.advanceTimersByTime(101)
    flushSync()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('keeps the tip reachable across the pointer gap and respects independent keyboard focus', () => {
    vi.useFakeTimers()
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()

    const card = document.querySelector<HTMLElement>('[data-item-key="capture"]')!
    card.dispatchEvent(new PointerEvent('pointerenter'))
    card.focus()
    flushSync()
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]')!

    card.dispatchEvent(new PointerEvent('pointerleave'))
    vi.advanceTimersByTime(200)
    flushSync()
    expect(document.querySelector('[role="tooltip"]')).toBe(tip)

    card.blur()
    card.dispatchEvent(new PointerEvent('pointerenter'))
    card.dispatchEvent(new PointerEvent('pointerleave'))
    vi.advanceTimersByTime(60)
    tip.dispatchEvent(new PointerEvent('pointerenter'))
    vi.advanceTimersByTime(200)
    flushSync()
    expect(document.querySelector('[role="tooltip"]')).toBe(tip)

    tip.dispatchEvent(new PointerEvent('pointerleave'))
    vi.advanceTimersByTime(200)
    flushSync()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('closes the tip before opening a placement menu and previews supported repair cards', () => {
    const next = workspace()
    const unsupported: WorkspaceItem = {
      ...item('unsupported', '需要修复的想法', 'unsupported'),
      idea_id: 'unsupported',
      projection: {
        idea_id: 'unsupported',
        state: 'unsupported',
        last_event_id: 'unsupported-event',
        last_at: '2026-08-30T00:00:00Z',
        unsupported_actions: ['future'],
      },
    }
    next.items.push(unsupported)
    next.unsupported.push(unsupported)
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    const repairCard = document.querySelector<HTMLElement>('[data-item-key="unsupported"]')!
    repairCard.dispatchEvent(new PointerEvent('pointerenter'))
    flushSync()
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('需要修复的想法')

    const capture = document.querySelector<HTMLElement>('[data-item-key="capture"]')!
    capture.dispatchEvent(new PointerEvent('pointerenter'))
    flushSync()
    expect(document.querySelector('[role="tooltip"]')).toBeTruthy()
    capture.querySelector<HTMLButtonElement>('.place')!.click()
    flushSync()
    expect(document.querySelector('[role="menu"]')).toBeTruthy()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('uses pointer movement to place a card because Tauri swallows HTML5 drag events', () => {
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()

    const waitingLane = targetLane('waiting')
    const captureCard = document.querySelector<HTMLElement>('[data-item-key="capture"]')!
    captureCard.dispatchEvent(new PointerEvent('pointerenter'))
    flushSync()
    expect(document.querySelector('[role="tooltip"]')).toBeTruthy()
    captureCard.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, button: 0, pointerId: 7, clientX: 10, clientY: 10,
    }))
    captureCard.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    flushSync()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 7, clientX: 350, clientY: 50,
    }))
    flushSync()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    expect(waitingLane.classList.contains('over')).toBe(true)
    expect(document.querySelector('.drag-ghost')?.textContent).toContain('默认隐藏的想法')
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 7, clientX: 350, clientY: 50,
    }))
    flushSync()

    expect(mocks.place).toHaveBeenCalledWith(mocks.state.workspace!.capture[0], { route: 'wait', status_only: true })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('restores the focused preview after a click that never becomes a drag', () => {
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()

    const card = document.querySelector<HTMLElement>('[data-item-key="capture"]')!
    card.dispatchEvent(new PointerEvent('pointerenter'))
    card.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, button: 0, pointerId: 12, clientX: 10, clientY: 10,
    }))
    card.focus()
    flushSync()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()

    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 12, clientX: 10, clientY: 10,
    }))
    flushSync()
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('默认隐藏的想法')
  })

  it('shows a New Idea shortcut and creates into the displayed Idea directory', async () => {
    const next = workspace()
    next.ideaDir = 'capture/sparks'
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    const createButton = document.querySelector<HTMLButtonElement>('[data-action="new-idea"]')
    expect(createButton?.textContent).toContain('新建 Idea')
    createButton!.click()
    flushSync()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('capture/sparks')

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[name="idea"]')!
    textarea.value = '值得记录的念头'
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true }))
    document.querySelector<HTMLFormElement>('[data-form="create-idea"]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(mocks.createIdea).toHaveBeenCalledWith({
      body: '值得记录的念头', priority: 'P2', contexts: [],
    }))
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  })

  it('creates a Task in Inbox or explicitly marks it current', async () => {
    const next = workspace()
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    const createButton = document.querySelector<HTMLButtonElement>('[data-action="new-task"]')
    expect(createButton?.textContent).toContain('新建任务')
    createButton!.click()
    flushSync()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('inbox/tasks')

    const title = document.querySelector<HTMLInputElement>('input[name="title"]')!
    title.value = '提交 TestFlight 构建'
    title.dispatchEvent(new InputEvent('input', { bubbles: true }))
    document.querySelector<HTMLFormElement>('[data-form="create-task"]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(mocks.createTask).toHaveBeenCalledWith({
      title: '提交 TestFlight 构建',
      priority: 'P2',
      contexts: [],
    }, false))
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())

    createButton!.click()
    flushSync()
    const currentTitle = document.querySelector<HTMLInputElement>('input[name="title"]')!
    currentTitle.value = '验证安装'
    currentTitle.dispatchEvent(new InputEvent('input', { bubbles: true }))
    const done = document.querySelector<HTMLInputElement>('input[name="done_when"]')!
    done.value = '安装成功'
    done.dispatchEvent(new InputEvent('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('[data-action="create-current"]')!.click()
    await vi.waitFor(() => expect(mocks.createTask).toHaveBeenCalledWith({
      title: '验证安装',
      done_when: '安装成功',
      priority: 'P2',
      contexts: [],
    }, true))
  })

  it('closes the Task sheet and warns when the file was saved but Inbox refresh failed', async () => {
    mocks.state.workspace = workspace()
    mocks.createTask.mockResolvedValueOnce({
      path: 'inbox/tasks/published-task.md',
      placedCurrent: false,
      refreshError: 'refresh unavailable',
    })
    component = mount(App, { target: document.body })
    flushSync()

    document.querySelector<HTMLButtonElement>('[data-action="new-task"]')!.click()
    flushSync()
    const title = document.querySelector<HTMLInputElement>('input[name="title"]')!
    title.value = '已发布任务'
    title.dispatchEvent(new InputEvent('input', { bubbles: true }))
    document.querySelector<HTMLFormElement>('[data-form="create-task"]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      'warn',
      '任务已保存，但 Next 暂时无法刷新收件箱。',
      'refresh unavailable',
    ))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('states that mark-current did not happen when its first refresh failed', async () => {
    mocks.state.workspace = workspace()
    mocks.createTask.mockResolvedValueOnce({
      path: 'inbox/tasks/published-task.md',
      placedCurrent: false,
      refreshError: 'refresh unavailable',
    })
    component = mount(App, { target: document.body })
    flushSync()

    document.querySelector<HTMLButtonElement>('[data-action="new-task"]')!.click()
    flushSync()
    const title = document.querySelector<HTMLInputElement>('input[name="title"]')!
    title.value = '已发布任务'
    title.dispatchEvent(new InputEvent('input', { bubbles: true }))
    const done = document.querySelector<HTMLInputElement>('input[name="done_when"]')!
    done.value = '可验收'
    done.dispatchEvent(new InputEvent('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('[data-action="create-current"]')!.click()

    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      'warn',
      '任务已保存，但收件箱刷新失败，尚未标记为当前。',
      'refresh unavailable',
    ))
  })

  it('opens New Task with Shift-Command-N without changing the New Idea shortcut', () => {
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'n', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
    }))
    flushSync()
    expect(document.querySelector('[data-form="create-task"]')).toBeTruthy()
    expect(document.querySelector('[data-form="create-idea"]')).toBeNull()
  })

  it('marks Task and Agent provenance on cards without creating a new lane', () => {
    const next = workspace()
    const task: WorkspaceItem = {
      ...item('task-card', '提交构建', 'capture'),
      kind: 'task',
      item_id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8',
      path: 'inbox/tasks/submit-task.md',
      task: {
        version: 1,
        id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8',
        priority: 'P0',
        due: '2026-09-02',
        contexts: ['@电脑'],
      },
      generatedBy: 'daily-summary-agent/1',
    }
    next.items.push(task)
    next.capture.unshift(task)
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    const card = document.querySelector('[data-item-key="task-card"]')!
    expect(card.textContent).toContain('任务')
    expect(card.textContent).toContain('Agent 添加')
    expect(card.textContent).toContain('2026-09-02')
    expect(card.textContent).toContain('P0 · 紧急')
    expect(card.textContent).toContain('@电脑')
    expect(document.querySelectorAll('[data-lane]')).toHaveLength(5)
    card.querySelector<HTMLButtonElement>('[data-card-title]')!.click()
    flushSync()
    expect(document.querySelector<HTMLSelectElement>('[name="priority"]')?.value).toBe('P0')
    expect(document.querySelector<HTMLInputElement>('[name="due"]')?.value).toBe('2026-09-02')
    expect(document.querySelector<HTMLInputElement>('[name="contexts"]')?.value).toBe('@电脑')
  })

  it('shows safe planning fallbacks on legacy cards in every lane component', () => {
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()

    const card = document.querySelector('[data-item-key="wip"]')!
    expect(card.textContent).toContain('P2 · 普通')
    expect(card.textContent).toContain('无截止日期')
    expect(card.textContent).toContain('情境未明确')
  })

  it('maps P0, P1, P2, and P3 to decreasing visual urgency on every card', () => {
    const next = workspace()
    const priorities = ['P0', 'P1', 'P2', 'P3'] as const
    const cards = priorities.map((priority) => ({
      ...item(`priority-${priority}`, priority, 'capture'),
      priority,
      contexts: [],
    }))
    next.items.push(...cards)
    next.capture.unshift(...cards)
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    for (const priority of priorities) {
      const badge = document.querySelector<HTMLElement>(
        `[data-item-key="priority-${priority}"] [data-priority="${priority}"]`,
      )!
      expect(badge.classList.contains(`priority-${priority.toLowerCase()}`)).toBe(true)
    }
  })

  it('opens the same metadata editor from valid card titles in every lane and saves source fields', async () => {
    const next = workspace()
    next.wip[0].priority = 'P1'
    next.wip[0].due = '2026-09-08'
    next.wip[0].contexts = ['@电脑']
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    document.querySelector<HTMLButtonElement>('.board-tools button')!.click()
    flushSync()
    expect(document.querySelector('[data-action="edit-metadata"]')).toBeNull()
    expect(document.body.textContent).not.toContain('编辑元数据')
    for (const key of ['capture', 'wip', 'waiting', 'dormant', 'closed']) {
      const title = document.querySelector<HTMLButtonElement>(`[data-item-key="${key}"] [data-card-title]`)
      expect(title?.tagName).toBe('BUTTON')
      expect(title?.type).toBe('button')
    }

    document.querySelector<HTMLButtonElement>('[data-item-key="wip"] [data-card-title]')!.click()
    flushSync()
    expect(document.querySelector<HTMLSelectElement>('[name="priority"]')?.value).toBe('P1')
    expect(document.querySelector<HTMLInputElement>('[name="due"]')?.value).toBe('2026-09-08')
    expect(document.querySelector<HTMLInputElement>('[name="contexts"]')?.value).toBe('@电脑')

    const due = document.querySelector<HTMLInputElement>('[name="due"]')!
    due.value = ''
    due.dispatchEvent(new InputEvent('input', { bubbles: true }))
    const contexts = document.querySelector<HTMLInputElement>('[name="contexts"]')!
    contexts.value = '@电话'
    contexts.dispatchEvent(new InputEvent('input', { bubbles: true }))
    document.querySelector<HTMLFormElement>('[data-form="edit-metadata"]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(mocks.updateMetadata).toHaveBeenCalledWith(next.wip[0], {
      priority: 'P1', contexts: ['@电话'],
    }))
    await vi.waitFor(() => expect(document.querySelector('[data-form="edit-metadata"]')).toBeNull())
  })

  it('keeps metadata edits visible when the source write fails', async () => {
    mocks.state.workspace = workspace()
    mocks.updateMetadata.mockRejectedValueOnce(new Error('disk full'))
    component = mount(App, { target: document.body })
    flushSync()

    document.querySelector<HTMLButtonElement>('[data-item-key="wip"] [data-card-title]')!.click()
    flushSync()
    const contexts = document.querySelector<HTMLInputElement>('[name="contexts"]')!
    contexts.value = '@不要丢失'
    contexts.dispatchEvent(new InputEvent('input', { bubbles: true }))
    document.querySelector<HTMLFormElement>('[data-form="edit-metadata"]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      'error', '无法保存元数据，当前编辑仍保留。', 'Error: disk full',
    ))
    expect(document.querySelector<HTMLInputElement>('[name="contexts"]')?.value).toBe('@不要丢失')
  })

  it('prefills future cards from the complete Next settings snapshot', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 1, 9, 0))
    mocks.state.settings = { wipLimit: 5, defaultPriority: 'P1', defaultDueDays: 7, defaultContext: '@电话' }
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()

    document.querySelector<HTMLButtonElement>('[data-action="new-idea"]')!.click()
    flushSync()
    expect(document.querySelector<HTMLSelectElement>('[name="priority"]')?.value).toBe('P1')
    expect(document.querySelector<HTMLInputElement>('[name="due"]')?.value).toBe('2026-09-08')
    expect(document.querySelector<HTMLInputElement>('[name="contexts"]')?.value).toBe('@电话')
    mocks.state.settings = { wipLimit: 5, defaultPriority: 'P2', defaultDueDays: 0, defaultContext: '' }
  })

  it('opens and saves all Next settings from the plugin main window', async () => {
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()

    const entry = document.querySelector<HTMLButtonElement>('[data-action="settings"]')!
    expect(entry).toBeTruthy()
    expect(entry.getAttribute('aria-label')).toBe('设置')
    entry.click()
    flushSync()

    expect(document.querySelector('[data-view="settings"]')).toBeTruthy()
    expect(document.querySelector('[data-lane]')).toBeNull()
    const wip = document.querySelector<HTMLInputElement>('[name="wipLimit"]')!
    const priority = document.querySelector<HTMLSelectElement>('[name="defaultPriority"]')!
    const dueDays = document.querySelector<HTMLInputElement>('[name="defaultDueDays"]')!
    const context = document.querySelector<HTMLInputElement>('[name="defaultContext"]')!
    expect(wip.value).toBe('5')
    expect(priority.value).toBe('P2')
    expect(dueDays.value).toBe('0')
    expect(context.value).toBe('')

    wip.value = '8'
    wip.dispatchEvent(new InputEvent('input', { bubbles: true }))
    for (const option of priority.options) option.selected = option.value === 'P1'
    expect(priority.value).toBe('P1')
    priority.dispatchEvent(new Event('change', { bubbles: true }))
    dueDays.value = '7'
    dueDays.dispatchEvent(new InputEvent('input', { bubbles: true }))
    context.value = '@电脑'
    context.dispatchEvent(new InputEvent('input', { bubbles: true }))
    document.querySelector<HTMLFormElement>('[data-view="settings"] form')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith({
      wipLimit: 8, defaultPriority: 'P1', defaultDueDays: 7, defaultContext: '@电脑',
    }))
    await vi.waitFor(() => expect(document.querySelector('[data-view="settings"]')).toBeNull())
    expect(document.querySelector('[data-lane]')).toBeTruthy()
  })

  it('keeps invalid or unsaved plugin settings on the page', async () => {
    mocks.state.workspace = workspace()
    mocks.updateSettings.mockRejectedValueOnce(new Error('disk full'))
    component = mount(App, { target: document.body })
    flushSync()
    document.querySelector<HTMLButtonElement>('[data-action="settings"]')!.click()
    flushSync()

    const wip = document.querySelector<HTMLInputElement>('[name="wipLimit"]')!
    wip.value = '0'
    wip.dispatchEvent(new InputEvent('input', { bubbles: true }))
    document.querySelector<HTMLFormElement>('[data-view="settings"] form')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    flushSync()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('至少为 1')
    expect(mocks.updateSettings).not.toHaveBeenCalled()

    wip.value = '6'
    wip.dispatchEvent(new InputEvent('input', { bubbles: true }))
    document.querySelector<HTMLFormElement>('[data-view="settings"] form')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('仍保留'))
    expect(document.querySelector<HTMLInputElement>('[name="wipLimit"]')?.value).toBe('6')
    expect(document.querySelector('[data-view="settings"]')).toBeTruthy()
  })

  it('opens New Idea with Command-N and keeps the draft when saving fails', async () => {
    mocks.state.workspace = workspace()
    mocks.createIdea.mockRejectedValueOnce(new Error('disk full'))
    component = mount(App, { target: document.body })
    flushSync()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true, cancelable: true }))
    flushSync()
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[name="idea"]')!
    textarea.value = '不要丢掉我'
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true }))
    document.querySelector<HTMLFormElement>('[data-form="create-idea"]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled())
    flushSync()

    expect(document.querySelector<HTMLTextAreaElement>('textarea[name="idea"]')?.value).toBe('不要丢掉我')
  })

  it('renders five equal-width swimlanes while keeping dormant and closed memories folded', () => {
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()

    expect(document.querySelectorAll('[data-lane]')).toHaveLength(5)
    expect([...document.querySelectorAll('[data-lane]')].map((lane) => lane.getAttribute('data-lane'))).toEqual([
      'capture', 'wip', 'waiting', 'dormant', 'closed',
    ])
    expect([...document.querySelectorAll('[data-lane] h2')].map((heading) => heading.textContent)).toEqual([
      '收件箱', '进行中', '等待', '稍后', '已结束',
    ])
    expect([...document.querySelectorAll('[data-kind-filter]')].map((button) => button.textContent)).toEqual(['Idea', 'Task'])
    expect(document.querySelectorAll('[data-project-filter]')).toHaveLength(0)
    expect(document.body.textContent).toContain('正在验证的想法')
    expect(document.body.textContent).toContain('等待设计稿')
    expect(document.body.textContent).toContain('默认隐藏的想法')
    expect(document.body.textContent).not.toContain('以后再看的想法')
    expect(document.body.textContent).not.toContain('已经关闭的想法')

    const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('显示已安放'))
    expect(button).toBeTruthy()
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    flushSync()
    expect(document.body.textContent).toContain('以后再看的想法')
    expect(document.body.textContent).toContain('已经关闭的想法')
  })

  it('keeps an emphatic WIP alert visible at the configured limit through unrelated filtering', () => {
    mocks.state.workspace = withWipLimit(workspace(), 5)
    component = mount(App, { target: document.body })
    flushSync()

    const alert = document.querySelector<HTMLElement>('[data-warning="wip"]')!
    expect(alert).toBeTruthy()
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.classList.contains('danger')).toBe(true)
    expect(alert.classList.contains('calm')).toBe(false)
    expect(alert.querySelector('button')).toBeNull()
    expect(alert.textContent).toContain('进行中有 5 项（上限 5）')
    expect(document.querySelector('[data-lane="wip"]')?.classList.contains('wip-limited')).toBe(true)
    expect(document.querySelector('[data-lane="wip"] .lane-head span')?.textContent).toBe('5/5')

    const search = document.querySelector<HTMLInputElement>('input.search')!
    search.value = '不匹配任何卡片'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    flushSync()
    expect(document.querySelector('[data-warning="wip"]')).toBe(alert)
  })

  it('hides the WIP alert only while the full count is below a custom limit', () => {
    mocks.state.workspace = withWipLimit(workspace(), 4, 5)
    component = mount(App, { target: document.body })
    flushSync()

    expect(document.querySelector('[data-warning="wip"]')).toBeNull()
    expect(document.querySelector('[data-lane="wip"] .lane-head span')?.textContent).toBe('4/5')
  })

  it('lists projects after the subtitle and toggles a project filter that composes with search', () => {
    const next = workspace()
    next.projectOptions = ['Next', 'Writing', 'Legacy']
    next.waiting[0].projection = {
      idea_id: 'waiting',
      state: 'waiting',
      last_event_id: 'e-waiting',
      last_at: '2026-08-31T00:00:00Z',
      project: 'Writing',
      waiting_for: '设计稿',
      review_at: '2026-09-01T00:00:00Z',
    }
    next.closed[0].projection = {
      idea_id: 'closed',
      state: 'closed',
      last_event_id: 'e-closed',
      last_at: '2026-08-28T00:00:00Z',
      project: 'Next',
      exit: { kind: 'transferred', via: 'project' },
      target: 'Legacy',
    }
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    const subtitle = document.querySelector('.subtitle-row > p')
    const filters = subtitle?.nextElementSibling
    expect(filters?.classList.contains('project-filters')).toBe(true)
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-project-filter]')]
    expect(buttons.map((button) => button.textContent)).toEqual(['Next', 'Writing', 'Legacy'])

    buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    flushSync()
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
    expect(document.body.textContent).toContain('正在验证的想法')
    expect(document.body.textContent).not.toContain('已经关闭的想法')
    expect(document.body.textContent).not.toContain('等待设计稿')
    expect(document.body.textContent).not.toContain('默认隐藏的想法')
    const showPlaced = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('显示已安放'))!
    expect(showPlaced).toBeTruthy()
    showPlaced.click()
    flushSync()
    expect(document.body.textContent).toContain('已经关闭的想法')
    showPlaced.click()
    flushSync()
    expect(document.body.textContent).not.toContain('已经关闭的想法')

    buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    flushSync()
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false')
    expect(document.body.textContent).toContain('等待设计稿')
    expect(document.body.textContent).toContain('默认隐藏的想法')
    expect(document.body.textContent).not.toContain('已经关闭的想法')
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('显示已安放'))).toBe(true)

    buttons[2].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    flushSync()
    expect(document.body.textContent).not.toContain('已经关闭的想法')
    showPlaced.click()
    flushSync()
    expect(document.body.textContent).toContain('已经关闭的想法')
    expect(document.body.textContent).not.toContain('正在验证的想法')

    buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    flushSync()
    expect(document.body.textContent).toContain('等待设计稿')
    expect(document.body.textContent).not.toContain('正在验证的想法')

    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = '不存在'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    flushSync()
    expect(document.body.textContent).not.toContain('等待设计稿')
    search.value = '设计稿'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    flushSync()
    expect(document.body.textContent).toContain('等待设计稿')
  })

  it('filters Idea and Task across all lanes and composes with project and search without writes', () => {
    const next = workspace()
    next.projectOptions = ['Next']
    for (const lane of ['capture', 'wip', 'waiting', 'dormant', 'closed'] as const) {
      const source = next[lane][0]!
      const task: WorkspaceItem = { ...source, key: `task-${lane}`, kind: 'task', title: `Task ${lane}` }
      next[lane].push(task)
      next.items.push(task)
    }
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()
    const idea = document.querySelector<HTMLButtonElement>('[data-kind-filter="idea"]')!
    const task = document.querySelector<HTMLButtonElement>('[data-kind-filter="task"]')!
    const visible = () => [...document.querySelectorAll('[data-item-key]')].map((card) => card.getAttribute('data-item-key'))
    task.click()
    flushSync()
    expect(visible()).toEqual(['task-capture', 'task-wip', 'task-waiting'])
    const showPlaced = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('显示已安放'))!
    expect(showPlaced).toBeTruthy()
    showPlaced.click()
    flushSync()
    expect(visible()).toEqual(['task-capture', 'task-wip', 'task-waiting', 'task-dormant', 'task-closed'])
    expect(task.getAttribute('aria-pressed')).toBe('true')
    idea.click()
    flushSync()
    expect(visible()).toEqual(['capture', 'wip', 'waiting', 'dormant', 'closed'])
    expect(task.getAttribute('aria-pressed')).toBe('false')
    idea.click()
    flushSync()
    expect(idea.getAttribute('aria-pressed')).toBe('false')
    expect(visible()).toContain('capture')
    expect(visible()).toContain('task-capture')
    expect(visible()).toContain('closed')
    showPlaced.click()
    flushSync()
    expect(showPlaced.textContent).toBe('显示已安放')
    expect(visible()).not.toContain('closed')
    expect(visible()).not.toContain('task-closed')
    expect(visible()).not.toContain('dormant')
    expect(visible()).not.toContain('task-dormant')

    task.click()
    document.querySelector<HTMLButtonElement>('[data-project-filter="Next"]')!.click()
    flushSync()
    expect(visible()).toEqual(['task-wip'])
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = '不存在'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    flushSync()
    expect(visible()).toEqual([])
    search.value = 'wip'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    flushSync()
    expect(visible()).toEqual(['task-wip'])
    expect(mocks.place).not.toHaveBeenCalled()
    expect(mocks.reopen).not.toHaveBeenCalled()
    expect(mocks.updateMetadata).not.toHaveBeenCalled()
  })

  it('keeps placed memories hidden while searching unless explicitly shown, but retains due reviews', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T00:00:00Z'))
    const next = workspace()
    const due: WorkspaceItem = {
      ...next.dormant[0], key: 'due', title: '到期复看的想法',
      projection: {
        idea_id: 'due', state: 'dormant', last_event_id: 'e-due',
        last_at: '2026-08-29T00:00:00Z', wake_trigger: '2026-10-26',
      },
    }
    next.dormant.push(due)
    next.items.push(due)
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = '想法'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    flushSync()
    const visible = () => [...document.querySelectorAll('[data-item-key]')].map((card) => card.getAttribute('data-item-key'))
    expect(visible()).toContain('due')
    expect(visible()).not.toContain('dormant')
    expect(visible()).not.toContain('closed')
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('显示已安放'))!
    expect(button).toBeTruthy()
    button.click()
    flushSync()
    expect(visible()).toContain('dormant')
    expect(visible()).toContain('closed')
    search.value = '已经关闭'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    flushSync()
    expect(visible()).toEqual(['closed'])
    button.click()
    flushSync()
    expect(visible()).toEqual([])
    search.value = ''
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    flushSync()
    expect(visible()).toContain('due')
    expect(visible()).not.toContain('closed')
    expect(mocks.place).not.toHaveBeenCalled()
    expect(mocks.reopen).not.toHaveBeenCalled()
  })

  it('applies project and text filters together to repair cards', () => {
    const next = workspace()
    const repair: WorkspaceItem = {
      ...item('repair', '需要修复的 Next 想法', 'unsupported'),
      idea_id: 'repair',
      projection: {
        idea_id: 'repair',
        state: 'unsupported',
        last_event_id: 'e-repair',
        last_at: '2026-08-31T00:00:00Z',
        project: 'Next',
        unsupported_actions: ['future-action'],
      },
    }
    next.items.push(repair)
    next.unsupported.push(repair)
    next.projectOptions = ['Next']
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    document.querySelector<HTMLButtonElement>('[data-project-filter="Next"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    flushSync()
    expect(document.body.textContent).toContain('需要修复的 Next 想法')

    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = '不存在'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    flushSync()
    expect(document.body.textContent).not.toContain('需要修复的 Next 想法')
    search.value = '需要修复'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    flushSync()
    expect(document.body.textContent).toContain('需要修复的 Next 想法')
  })

  it.each([
    ['wip', { route: 'commit', status_only: true }],
    ['waiting', { route: 'wait', status_only: true }],
    ['dormant', { route: 'park', status_only: true }],
    ['closed', { route: 'settle', exit: { kind: 'done' }, status_only: true }],
  ])('saves the default status directly when dropped into %s', async (lane, input) => {
    const next = workspace()
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    pointerDrag('capture', lane as string)

    await vi.waitFor(() => expect(mocks.place).toHaveBeenCalledWith(next.capture[0], input))
    expect(mocks.place).toHaveBeenCalledTimes(1)
    expect(mocks.reopen).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it.each(['dormant', 'closed'])('reopens a %s card dropped into capture without a form', async (source) => {
    const next = workspace()
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()
    const showPlaced = [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('显示已安放'))!
    showPlaced.click()
    flushSync()

    pointerDrag(source, 'capture')

    await vi.waitFor(() => expect(mocks.reopen).toHaveBeenCalledWith(next.items.find((entry) => entry.key === source)))
    expect(mocks.place).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('does nothing on a same-lane pointer drop and disables dragging while saving', () => {
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()

    const wip = document.querySelector<HTMLElement>('[data-item-key="wip"]')!
    expect(wip.dataset.draggable).toBe('true')
    pointerDrag('wip', 'wip')
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    unmount(component!)
    component = null
    document.body.innerHTML = ''
    mocks.state.saving = true
    component = mount(App, { target: document.body })
    flushSync()
    expect(document.querySelector<HTMLElement>('[data-item-key="wip"]')!.dataset.draggable).toBe('false')
  })

  it.each(['dormant', 'closed'])('reopens a %s idea before directly placing it into a new lane', async (source) => {
    const next = workspace()
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    const showPlaced = [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('显示已安放'))!
    showPlaced.click()
    flushSync()
    pointerDrag(source, 'wip')

    const moved = next.items.find((entry) => entry.key === source)!
    await vi.waitFor(() => expect(mocks.place).toHaveBeenCalledWith(moved, { route: 'commit', status_only: true }))
    expect(mocks.reopen).toHaveBeenCalledWith(moved)
    expect(mocks.reopen.mock.invocationCallOrder[0]).toBeLessThan(mocks.place.mock.invocationCallOrder[0])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('cancels a pointer drag with Escape and never starts one from a card button', () => {
    mocks.state.workspace = workspace()
    component = mount(App, { target: document.body })
    flushSync()
    targetLane('waiting')

    const card = document.querySelector<HTMLElement>('[data-item-key="capture"]')!
    card.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, button: 0, pointerId: 8, clientX: 10, clientY: 10,
    }))
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 8, clientX: 350, clientY: 50,
    }))
    flushSync()
    expect(document.querySelector('.drag-ghost')).toBeTruthy()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 8, clientX: 350, clientY: 50,
    }))
    flushSync()
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    card.querySelector<HTMLButtonElement>('button')!.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, button: 0, pointerId: 9, clientX: 10, clientY: 10,
    }))
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 9, clientX: 350, clientY: 50,
    }))
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 9, clientX: 350, clientY: 50,
    }))
    flushSync()
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    card.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, button: 0, pointerId: 10, clientX: 10, clientY: 10,
    }))
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 10, clientX: 350, clientY: 50,
    }))
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 10, clientX: 900, clientY: 50,
    }))
    flushSync()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps a reopened orphan visible in a repair area with placement and relink actions', () => {
    const next = workspace()
    const orphan: WorkspaceItem = {
      ...item('orphan', '找不到原文的想法', 'capture'),
      idea_id: 'orphan-id',
      orphan: true,
      relinkMatch: 'manual',
    }
    next.items.push(orphan)
    mocks.state.workspace = next
    component = mount(App, { target: document.body })
    flushSync()

    expect(document.body.textContent).toContain('需要处理')
    expect(document.body.textContent).toContain('找不到原文的想法')
    expect(document.querySelector('[data-item-key="orphan"] [data-card-title]')).toBeNull()
    const place = document.querySelector<HTMLButtonElement>('[data-item-key="orphan"] .place')
    expect(place).toBeTruthy()
    place!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    flushSync()
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('安放“找不到原文的想法”')
  })
})


describe('Task reminders in the board', () => {
  const id = '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8'
  function renderTask(status: ReminderView['status'] = 'automatic') {
    const next = workspace()
    const task: WorkspaceItem = { ...item('reminder-task', '交付报告', 'capture'), kind: 'task',
      item_id: id, path: 'inbox/tasks/report-task.md', task: { version: 1, id, due: '2026-10-28' } }
    next.items.push(task)
    next.capture.unshift(task)
    mocks.state.workspace = next
    mocks.state.reminders[id] = { status, policy: status === 'muted' ? 'muted' : 'enabled', raw: null }
    component = mount(App, { target: document.body })
    flushSync()
    return task
  }
  function clickText(text: string, root: ParentNode = document) {
    const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(text))!
    expect(button).toBeTruthy()
    button.click()
    flushSync()
  }
  it('turns off reminders from the card without placing or completing it', async () => {
    const task = renderTask()
    document.querySelector<HTMLButtonElement>('[data-reminder="automatic"]')!.click()
    flushSync()
    clickText('关闭提醒', document.querySelector('[role="menu"]')!)
    await vi.waitFor(() => expect(mocks.updateReminder).toHaveBeenCalledWith(task, { policy: 'muted' }, null))
    expect(mocks.place).not.toHaveBeenCalled()
    expect(mocks.reopen).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  })
  it('keeps the menu and reports a failed preference save', async () => {
    renderTask()
    mocks.updateReminder.mockRejectedValueOnce(new Error('disk full'))
    document.querySelector<HTMLButtonElement>('[data-reminder]')!.click()
    flushSync()
    clickText('关闭提醒', document.querySelector('[role="menu"]')!)
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error', expect.any(String), 'Error: disk full'))
    expect(document.querySelector('[role="menu"]')).toBeTruthy()
    expect(document.querySelector('[data-reminder="automatic"]')).toBeTruthy()
  })
  it('keeps metadata edits when opening reminder details and closing with Escape', async () => {
    renderTask()
    document.querySelector<HTMLButtonElement>('[data-item-key="reminder-task"] [data-card-title]')!.click()
    flushSync()
    const due = document.querySelector<HTMLInputElement>('[name="due"]')!
    due.value = '2026-11-01'
    due.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    clickText('管理提醒')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2)
    await Promise.resolve()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    flushSync()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.querySelector<HTMLInputElement>('[name="due"]')?.value).toBe('2026-11-01')
    expect(mocks.updateMetadata).not.toHaveBeenCalled()
  })
  it('updates card and open menu when a pause expires without losing a preference', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T02:00:00Z'))
    const next = workspace()
    const task: WorkspaceItem = { ...item('expires', '暂停到期测试', 'capture'), kind: 'task',
      item_id: id, path: 'inbox/tasks/expire-task.md', task: { version: 1, id } }
    next.items.push(task)
    next.capture.unshift(task)
    mocks.state.workspace = next
    mocks.state.reminders[id] = { status: 'paused', policy: 'enabled', raw: 'saved', pausedUntil: '2026-10-26T02:00:01Z' }
    component = mount(App, { target: document.body })
    flushSync()
    document.querySelector<HTMLButtonElement>('[data-reminder="paused"]')!.click()
    flushSync()
    await vi.advanceTimersByTimeAsync(1002)
    flushSync()
    expect(document.querySelector('[data-reminder="automatic"]')).toBeTruthy()
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('恢复自动提醒')
    expect(mocks.updateReminder).not.toHaveBeenCalled()
  })
  it('does not offer recovery that would override a legacy closure', () => {
    renderTask('legacy')
    document.querySelector<HTMLButtonElement>('[data-reminder]')!.click()
    flushSync()
    const menu = document.querySelector('[role="menu"]')!
    expect(menu.textContent).not.toContain('恢复自动提醒')
    expect(mocks.updateReminder).not.toHaveBeenCalled()
  })
})
