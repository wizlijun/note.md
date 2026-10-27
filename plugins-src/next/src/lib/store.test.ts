import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reduceEvents } from './domain'
import type { NextWorkspace, WorkspaceItem } from './repository'

const mocks = vi.hoisted(() => ({
  loadWorkspace: vi.fn(),
  loadTaskReminders: vi.fn(async () => ({})),
  saveTaskReminder: vi.fn(),
  appendEvent: vi.fn(),
  createIdeaSource: vi.fn(),
  createTaskSource: vi.fn(),
  openSource: vi.fn(),
  updateItemPlanningMetadata: vi.fn(),
  loadNextSettings: vi.fn(async () => ({ wipLimit: 5, defaultPriority: 'P2', defaultDueDays: 0, defaultContext: '' })),
  saveNextSettings: vi.fn(async (value) => value),
  syncTaskHook: vi.fn(async () => {}),
  persistCompletionNote: vi.fn(),
}))

vi.mock('./repository', async (importOriginal) => {
  const original = await importOriginal<typeof import('./repository')>()
  return {
    ...original,
    loadWorkspace: mocks.loadWorkspace,
    appendEvent: mocks.appendEvent,
    createIdeaSource: mocks.createIdeaSource,
    createTaskSource: mocks.createTaskSource,
    openSource: mocks.openSource,
    updateItemPlanningMetadata: mocks.updateItemPlanningMetadata,
  }
})

vi.mock('./reminders', () => ({ loadTaskReminders: mocks.loadTaskReminders, saveTaskReminder: mocks.saveTaskReminder }))
vi.mock('./task-hook.svelte', () => ({ syncTaskHook: mocks.syncTaskHook }))
vi.mock('./completion-note', async (importOriginal) => ({
  ...await importOriginal<typeof import('./completion-note')>(),
  persistCompletionNote: mocks.persistCompletionNote,
}))

vi.mock('./settings', () => ({
  DEFAULT_NEXT_SETTINGS: { wipLimit: 5, defaultPriority: 'P2', defaultDueDays: 0, defaultContext: '' },
  loadNextSettings: mocks.loadNextSettings,
  normalizeNextSettings: (value: unknown) => value,
  saveNextSettings: mocks.saveNextSettings,
}))

import { completeWithNote, createIdea, createTask, place, refresh, state, updateMetadata, updateSettings, updateReminder } from './store.svelte'
import { CompletionNoteError, createCompletionNote } from './completion-note'

const capture: WorkspaceItem = {
  key: 'inbox/ideas/a-idea.md',
  state: 'capture',
  title: 'Idea',
  path: 'inbox/ideas/a-idea.md',
  created: '2026-08-29T01:00:00Z',
  proofed: false,
  orphan: false,
  relinkCandidates: [],
  relinkMatch: null,
}

function workspace(): NextWorkspace {
  return {
    ledger: { type: 'Next', version: 1, source_dirs: ['inbox/ideas'], events: [], extra: {} },
    ledgerRaw: 'loaded',
    sourceDirs: ['inbox/ideas'],
    ideaDir: 'inbox/ideas',
    taskDir: 'inbox/tasks',
    projection: reduceEvents([]),
    sources: [],
    taskSources: [],
    items: [capture],
    capture: [capture],
    wip: [],
    waiting: [],
    dormant: [],
    closed: [],
    unsupported: [],
    projectOptions: [],
    scanErrors: [],
    readOnlyError: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  delete capture.priority
  delete capture.due
  delete capture.contexts
  mocks.loadNextSettings.mockResolvedValue({ wipLimit: 5, defaultPriority: 'P2', defaultDueDays: 0, defaultContext: '' })
  mocks.saveNextSettings.mockImplementation(async (value) => value)
  state.workspace = workspace()
  state.loading = false
  state.saving = false
  state.error = null
  state.reminders = {}
  mocks.loadTaskReminders.mockResolvedValue({})
  mocks.syncTaskHook.mockResolvedValue(undefined)
})

describe('Next store IO serialization', () => {
  it('serializes note completion and runs the script only after both durable writes succeed', async () => {
    const task: WorkspaceItem = { ...capture, kind: 'task', path: 'inbox/tasks/a-task.md',
      item_id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8', task: { version: 1, id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8' } }
    const operation = createCompletionNote(task, '已完成\n多行记录')
    let finish!: (value: NextWorkspace) => void
    mocks.persistCompletionNote.mockImplementationOnce(() => new Promise<NextWorkspace>((resolve) => { finish = resolve }))
    const pending = completeWithNote(task, operation)
    expect(state.saving).toBe(true)
    await expect(completeWithNote(task, operation)).rejects.toThrow('already saving')
    await refresh()
    expect(mocks.loadWorkspace).not.toHaveBeenCalled()
    expect(mocks.syncTaskHook).not.toHaveBeenCalled()
    const saved = workspace()
    finish(saved); await pending
    expect(mocks.persistCompletionNote).toHaveBeenCalledExactlyOnceWith(operation, 5)
    expect(mocks.syncTaskHook).toHaveBeenCalledExactlyOnceWith(task.task!.id, task.title)
    expect(state.workspace).toBe(saved)
    expect(state.saving).toBe(false)
  })

  it('keeps a failed note completion retryable and does not run the script for a partial save', async () => {
    const task: WorkspaceItem = { ...capture, kind: 'task', path: 'inbox/tasks/a-task.md',
      item_id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8', task: { version: 1, id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8' } }
    const operation = createCompletionNote(task, '保留记录')
    const error = new CompletionNoteError(true, new Error('ledger write failed'))
    mocks.persistCompletionNote.mockRejectedValueOnce(error)
    mocks.loadWorkspace.mockResolvedValueOnce(workspace())
    await expect(completeWithNote(task, operation)).rejects.toBe(error)
    expect(state.saving).toBe(false)
    expect(mocks.syncTaskHook).not.toHaveBeenCalled()
    mocks.persistCompletionNote.mockResolvedValueOnce(workspace())
    await completeWithNote(task, operation)
    expect(mocks.persistCompletionNote.mock.calls.map((call) => call[0])).toEqual([operation, operation])
    expect(mocks.syncTaskHook).toHaveBeenCalledTimes(1)
  })

  it('updates source metadata, refreshes the workspace, and serializes concurrent actions', async () => {
    const refreshed = workspace()
    refreshed.capture[0] = { ...capture, priority: 'P0', due: '2026-09-08', contexts: ['@电脑'] }
    refreshed.items = refreshed.capture
    let finishUpdate!: () => void
    mocks.updateItemPlanningMetadata.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishUpdate = resolve
    }))
    mocks.loadWorkspace.mockResolvedValueOnce(refreshed)

    const updating = updateMetadata(capture, { priority: 'P0', due: '2026-09-08', contexts: ['@电脑'] })
    expect(state.saving).toBe(true)
    await expect(place(capture, {
      route: 'commit', commitment: 'Validate', next_action: 'Test', close_condition: 'Done',
    })).rejects.toThrow('already saving')
    finishUpdate()
    await expect(updating).resolves.toEqual({})

    expect(mocks.updateItemPlanningMetadata).toHaveBeenCalledWith(capture, {
      priority: 'P0', due: '2026-09-08', contexts: ['@电脑'],
    })
    expect(state.workspace).toBe(refreshed)
    expect(state.saving).toBe(false)
  })

  it('keeps the draft-facing card current when refresh fails after a durable metadata save', async () => {
    mocks.updateItemPlanningMetadata.mockResolvedValueOnce(undefined)
    mocks.loadWorkspace.mockRejectedValueOnce(new Error('refresh unavailable'))

    await expect(updateMetadata(capture, { priority: 'P3', contexts: [] })).resolves.toEqual({
      refreshError: 'Error: refresh unavailable',
    })

    expect(capture.priority).toBe('P3')
    expect(capture.contexts).toEqual([])
    expect(capture.due).toBeUndefined()
    expect(state.error).toBeNull()
  })

  it('preserves the current workspace and surfaces source write failures', async () => {
    const before = state.workspace
    mocks.updateItemPlanningMetadata.mockRejectedValueOnce(new Error('disk full'))

    await expect(updateMetadata(capture, { priority: 'P1', contexts: ['@电话'] })).rejects.toThrow('disk full')
    expect(state.workspace).toBe(before)
    expect(state.error).toContain('disk full')
    expect(mocks.loadWorkspace).not.toHaveBeenCalled()
  })

  it('creates a Task in Inbox without appending a lifecycle event', async () => {
    const refreshed = workspace()
    const taskItem: WorkspaceItem = {
      ...capture,
      key: 'task-id',
      kind: 'task',
      item_id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8',
      title: '提交构建',
      path: 'inbox/tasks/submit-task.md',
      task: { version: 1, id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8' },
    }
    refreshed.items = [taskItem]
    refreshed.capture = [taskItem]
    mocks.createTaskSource.mockResolvedValueOnce({
      path: taskItem.path,
      content: 'document',
      source: { path: taskItem.path, task: taskItem.task },
    })
    mocks.loadWorkspace.mockResolvedValueOnce(refreshed)

    await expect(createTask({ title: '提交构建' }, false)).resolves.toEqual({
      path: 'inbox/tasks/submit-task.md',
      placedCurrent: false,
    })
    expect(mocks.appendEvent).not.toHaveBeenCalled()
    expect(state.workspace).toBe(refreshed)
  })

  it('reports a refresh warning without misreporting a durably published Task as creation failure', async () => {
    mocks.createTaskSource.mockResolvedValueOnce({
      path: 'inbox/tasks/published-task.md',
      content: 'document',
      source: {
        path: 'inbox/tasks/published-task.md',
        task: { version: 1, id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8' },
      },
    })
    mocks.loadWorkspace.mockRejectedValueOnce(new Error('refresh unavailable'))

    await expect(createTask({ title: '已发布任务' }, false)).resolves.toEqual({
      path: 'inbox/tasks/published-task.md',
      placedCurrent: false,
      refreshError: 'Error: refresh unavailable',
    })
    expect(state.error).toBeNull()
  })

  it('marks a newly created Task current using source-first placement defaults', async () => {
    const inbox = workspace()
    const taskItem: WorkspaceItem = {
      ...capture,
      key: 'task-id',
      kind: 'task',
      item_id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8',
      title: '提交构建',
      path: 'inbox/tasks/submit-task.md',
      task: {
        version: 1,
        id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8',
        done_when: '构建可安装',
      },
    }
    inbox.items = [taskItem]
    inbox.capture = [taskItem]
    const current = workspace()
    current.wip = [taskItem]
    mocks.createTaskSource.mockResolvedValueOnce({
      path: taskItem.path,
      content: 'document',
      source: { path: taskItem.path, task: taskItem.task },
    })
    mocks.loadWorkspace.mockResolvedValueOnce(inbox)
    mocks.appendEvent.mockResolvedValueOnce(current)

    await expect(createTask({
      title: '提交构建',
      done_when: '构建可安装',
    }, true)).resolves.toEqual({ path: taskItem.path, placedCurrent: true })
    expect(mocks.appendEvent).toHaveBeenCalledWith(inbox, expect.objectContaining({
      item_kind: 'task',
      item_id: taskItem.item_id,
      action: 'commit',
      commitment: '提交构建',
      next_action: '提交构建',
      close_condition: '构建可安装',
    }), { hardWipLimit: true })
    expect(state.workspace).toBe(current)
  })

  it('never marks a same-id repair card current after refresh detects a collision', async () => {
    const inbox = workspace()
    const repair: WorkspaceItem = {
      ...capture,
      key: 'task-repair:inbox/tasks/collision-task.md',
      kind: 'task',
      item_id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8',
      item_kind: 'task',
      state: 'unsupported',
      title: '冲突任务',
      path: 'inbox/tasks/collision-task.md',
      task: { version: 1, id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8' },
      repairReason: 'duplicate task.id',
    }
    inbox.items = [repair]
    inbox.capture = []
    inbox.unsupported = [repair]
    mocks.createTaskSource.mockResolvedValueOnce({
      path: 'inbox/tasks/new-task.md',
      content: 'document',
      source: {
        path: 'inbox/tasks/new-task.md',
        task: repair.task!,
      },
    })
    mocks.loadWorkspace.mockResolvedValue(inbox)

    await expect(createTask({ title: '新任务', done_when: '可验收' }, true)).resolves.toMatchObject({
      path: 'inbox/tasks/new-task.md',
      placedCurrent: false,
      placementError: expect.stringContaining('not available for placement'),
    })
    expect(mocks.appendEvent).not.toHaveBeenCalled()
    expect(state.workspace).toBe(inbox)
  })

  it('keeps the Task in Inbox and returns a distinguishable result when current placement fails', async () => {
    const inbox = workspace()
    const taskItem: WorkspaceItem = {
      ...capture,
      key: 'task-id',
      kind: 'task',
      item_id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8',
      title: '提交构建',
      path: 'inbox/tasks/submit-task.md',
      task: { version: 1, id: '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8' },
    }
    inbox.items = [taskItem]
    inbox.capture = [taskItem]
    mocks.createTaskSource.mockResolvedValueOnce({
      path: taskItem.path,
      content: 'document',
      source: { path: taskItem.path, task: taskItem.task },
    })
    mocks.loadWorkspace.mockResolvedValue(inbox)
    mocks.appendEvent.mockRejectedValueOnce(new Error('WIP is full'))

    await expect(createTask({ title: '提交构建', done_when: '构建可安装' }, true)).resolves.toEqual({
      path: taskItem.path,
      placedCurrent: false,
      placementError: 'Error: WIP is full',
    })
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(2)
    expect(state.workspace).toBe(inbox)
    expect(state.error).toBeNull()
  })
  it('creates one source idea, refreshes the projection, and returns its path', async () => {
    const refreshed = workspace()
    mocks.createIdeaSource.mockResolvedValueOnce({
      path: 'inbox/ideas/2026-08-30-0905-idea.md',
      content: 'document',
    })
    mocks.loadWorkspace.mockResolvedValueOnce(refreshed)

    await expect(createIdea({ body: '一个念头', priority: 'P1', due: '2026-09-08', contexts: ['@电脑'] }))
      .resolves.toBe('inbox/ideas/2026-08-30-0905-idea.md')
    expect(mocks.createIdeaSource).toHaveBeenCalledWith('一个念头', {
      metadata: { priority: 'P1', due: '2026-09-08', contexts: ['@电脑'] },
    })
    expect(state.workspace).toBe(refreshed)
    expect(state.saving).toBe(false)
  })

  it('preserves the current workspace and reports an error when creation fails', async () => {
    const before = state.workspace
    mocks.createIdeaSource.mockRejectedValueOnce(new Error('disk full'))
    await expect(createIdea({ body: '一个念头', priority: 'P2', contexts: [] })).rejects.toThrow('disk full')
    expect(state.workspace).toBe(before)
    expect(state.error).toContain('disk full')
    expect(mocks.loadWorkspace).not.toHaveBeenCalled()
  })

  it('blocks placement while a focus refresh may be persisting source directories', async () => {
    let finishLoad!: (value: NextWorkspace) => void
    mocks.loadWorkspace.mockImplementationOnce(() => new Promise<NextWorkspace>((resolve) => {
      finishLoad = resolve
    }))

    const refreshing = refresh()
    expect(state.saving).toBe(true)
    await expect(place(capture, {
      route: 'commit',
      commitment: 'Validate',
      next_action: 'Run a test',
      close_condition: 'Evidence exists',
    })).rejects.toThrow('already saving')
    expect(mocks.appendEvent).not.toHaveBeenCalled()

    finishLoad(workspace())
    await refreshing
    expect(state.saving).toBe(false)
  })

  it('loads one complete settings snapshot whenever the workspace refreshes', async () => {
    const refreshed = workspace()
    refreshed.projection = reduceEvents([], { wipLimit: 8 })
    mocks.loadNextSettings.mockResolvedValueOnce({ wipLimit: 8, defaultPriority: 'P1', defaultDueDays: 7, defaultContext: '@电脑' })
    mocks.loadWorkspace.mockResolvedValueOnce(refreshed)

    await refresh()

    expect(mocks.loadWorkspace).toHaveBeenCalledWith(expect.any(Object), { wipLimit: 8 })
    expect(state.workspace?.projection.wipLimit).toBe(8)
    expect(state.settings).toEqual({ wipLimit: 8, defaultPriority: 'P1', defaultDueDays: 7, defaultContext: '@电脑' })
  })

  it('persists plugin-owned settings only after the new WIP projection loads', async () => {
    const refreshed = workspace()
    refreshed.projection = reduceEvents([], { wipLimit: 8 })
    mocks.loadWorkspace.mockResolvedValueOnce(refreshed)
    const settings = { wipLimit: 8, defaultPriority: 'P1' as const, defaultDueDays: 7, defaultContext: '@电脑' }

    await updateSettings(settings)

    expect(mocks.loadWorkspace).toHaveBeenCalledWith(expect.any(Object), { wipLimit: 8 })
    expect(mocks.saveNextSettings).toHaveBeenCalledWith(settings)
    expect(state.settings).toEqual(settings)
    expect(state.workspace?.projection.wipLimit).toBe(8)
  })
})


describe('Task reminder store', () => {
  const id = '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8'
  function taskWorkspace() {
    const task: WorkspaceItem = { ...capture, kind: 'task', key: 'task:' + id,
      item_id: id, path: 'inbox/tasks/test-task.md', task: { version: 1, id } }
    const next = workspace()
    next.items = next.capture = [task]
    state.workspace = next
    return { task, next }
  }
  it('runs the script only after completion is saved, without waiting for the channel', async () => {
    const { task, next } = taskWorkspace()
    next.ledger.version = 2
    let finish!: (value: NextWorkspace) => void
    mocks.appendEvent.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    mocks.syncTaskHook.mockImplementationOnce(() => new Promise(() => {}))
    const saving = place(task, { route: 'settle', exit: { kind: 'done' }, status_only: true })
    expect(mocks.syncTaskHook).not.toHaveBeenCalled()
    finish(next)
    await expect(saving).resolves.toBeUndefined()
    expect(mocks.syncTaskHook).toHaveBeenCalledWith(id, task.title)
    expect(state.saving).toBe(false)
    expect(state.error).toBeNull()
  })
  it('does not run scripts for failed saves or Idea transitions', async () => {
    const { task, next } = taskWorkspace()
    next.ledger.version = 2
    mocks.appendEvent.mockRejectedValueOnce(new Error('disk full'))
    mocks.loadWorkspace.mockResolvedValueOnce(next)
    await expect(place(task, { route: 'settle', exit: { kind: 'done' }, status_only: true })).rejects.toThrow('disk full')
    expect(mocks.syncTaskHook).not.toHaveBeenCalled()
    mocks.appendEvent.mockResolvedValueOnce(next)
    await place(capture, { route: 'settle', exit: { kind: 'done' }, status_only: true })
    expect(mocks.syncTaskHook).not.toHaveBeenCalled()
  })
  it('serializes reminder writes and changes no lifecycle event', async () => {
    const { task, next } = taskWorkspace()
    let finish!: (value: unknown) => void
    mocks.saveTaskReminder.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    mocks.loadWorkspace.mockResolvedValueOnce(next)
    const saving = updateReminder(task, { policy: 'muted' }, null)
    expect(state.saving).toBe(true)
    await expect(updateReminder(task, { policy: 'enabled' }, null)).rejects.toThrow('already saving')
    finish({ policy: 'muted', status: 'muted', raw: 'saved' })
    await expect(saving).resolves.toEqual({})
    expect(mocks.saveTaskReminder).toHaveBeenCalledWith(task, { policy: 'muted' }, null, expect.anything())
    expect(mocks.appendEvent).not.toHaveBeenCalled()
    expect(mocks.syncTaskHook).toHaveBeenCalledWith(id, task.title)
  })
  it('keeps verified preference after a later board refresh fails', async () => {
    const { task } = taskWorkspace()
    const saved = { policy: 'muted' as const, status: 'muted' as const, raw: 'saved' }
    mocks.saveTaskReminder.mockResolvedValueOnce(saved)
    mocks.loadWorkspace.mockRejectedValueOnce(new Error('scan failed'))
    await expect(updateReminder(task, { policy: 'muted' }, null)).resolves.toEqual({ refreshError: 'Error: scan failed' })
    expect(state.reminders[id]).toEqual(saved)
    expect(state.error).toBeNull()
  })
  it('does not show a successful policy on failed write', async () => {
    const { task } = taskWorkspace()
    const previous = { policy: 'enabled' as const, status: 'automatic' as const, raw: null }
    state.reminders[id] = previous
    mocks.saveTaskReminder.mockRejectedValueOnce(new Error('disk full'))
    await expect(updateReminder(task, { policy: 'muted' }, null)).rejects.toThrow('disk full')
    expect(state.reminders[id]).toEqual(previous)
    expect(mocks.syncTaskHook).not.toHaveBeenCalled()
    expect(state.saving).toBe(false)
  })
  it('rejects changing reminders for a closed Task', async () => {
    const { task } = taskWorkspace()
    task.state = 'closed'
    await expect(updateReminder(task, { policy: 'enabled' }, null)).rejects.toThrow('not active')
    expect(mocks.saveTaskReminder).not.toHaveBeenCalled()
  })
})
