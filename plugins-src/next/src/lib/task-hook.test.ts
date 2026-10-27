// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('./bridge', () => ({ bridge: () => ({ request }) }))
import { taskHook, loadTaskHook, selectTaskHook, clearTaskHook, syncTaskHook, setTaskHookEnvironment } from './task-hook.svelte'

const id = '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8'
beforeEach(() => {
  request.mockReset()
  taskHook.config = { available: false, configured: false }
  taskHook.jobs = {}
})

describe('direct Task script hook', () => {
  it('uses host-owned selection and disable APIs without writing plugin settings', async () => {
    request.mockResolvedValueOnce({ configured: true, scriptPath: '/vault/skills/sync.py' })
    await selectTaskHook()
    expect(taskHook.config.scriptPath).toBe('/vault/skills/sync.py')
    request.mockResolvedValueOnce({ configured: false })
    await clearTaskHook()
    expect(taskHook.config.configured).toBe(false)
    expect(request.mock.calls).toEqual([['host.taskHook.select', {}], ['host.taskHook.clear', {}]])
  })

  it('degrades on older hosts and does not call a model or execute an unconfigured hook', async () => {
    request.mockRejectedValue(new Error('method unavailable'))
    await loadTaskHook()
    await syncTaskHook(id, '合同')
    expect(taskHook.config.available).toBe(false)
    expect(taskHook.jobs).toEqual({})
    expect(request.mock.calls.every(([method]) => method === 'host.taskHook.get')).toBe(true)
  })

  it('retries only the script after failure and supplies no shell or vault arguments', async () => {
    let runs = 0
    request.mockImplementation(async (method) => method === 'host.taskHook.get'
      ? { configured: true }
      : (++runs === 1 ? { ok: false, status: 'pending', errorCode: 'timeout' } : { ok: true, status: 'synced' }))
    await expect(syncTaskHook(id, '合同')).resolves.toBeUndefined()
    expect(taskHook.jobs[id]).toMatchObject({ status: 'pending', errorCode: 'timeout' })
    await syncTaskHook(id, '合同')
    expect(taskHook.jobs[id].status).toBe('synced')
    expect(request.mock.calls.filter(([method]) => method === 'host.taskHook.run')).toEqual([
      ['host.taskHook.run', { taskId: id }], ['host.taskHook.run', { taskId: id }],
    ])
  })

  it('serializes executions for one task and contains bridge errors', async () => {
    let finish!: (value: unknown) => void
    request.mockImplementation((method) => method === 'host.taskHook.get'
      ? Promise.resolve({ configured: true })
      : new Promise((resolve) => { finish = resolve }))
    const first = syncTaskHook(id, '合同')
    const second = syncTaskHook(id, '合同')
    await vi.waitFor(() => expect(taskHook.jobs[id]?.status).toBe('running'))
    expect(request.mock.calls.filter(([method]) => method === 'host.taskHook.run')).toHaveLength(1)
    request.mockImplementation(async (method) => {
      if (method === 'host.taskHook.get') return { configured: true }
      throw new Error('private provider failure')
    })
    finish({ ok: true, status: 'synced' })
    await Promise.all([first, second])
    expect(taskHook.jobs[id]).toEqual({ taskId: id, title: '合同', status: 'pending', errorCode: 'host_unavailable' })
  })

  it.each([
    ['before', 'resolve'], ['before', 'reject'], ['during', 'resolve'], ['during', 'reject'],
  ])('keeps saved environment configuration when a GET started %s a mutation completes with %s later', async (timing, outcome) => {
    let finishRead!: (value: unknown) => void
    let failRead!: (error: Error) => void
    let finishSave!: (value: unknown) => void
    request.mockImplementation((method) => method === 'host.taskHook.get'
      ? new Promise((resolve, reject) => { finishRead = resolve; failRead = reject })
      : new Promise((resolve) => { finishSave = resolve }))
    let read: Promise<unknown>
    let save: Promise<void>
    if (timing === 'before') {
      read = loadTaskHook()
      save = setTaskHookEnvironment('DESK_DISPLAY_TOKEN=test-only-token')
    } else {
      save = setTaskHookEnvironment('DESK_DISPLAY_TOKEN=test-only-token')
      read = loadTaskHook()
    }
    finishSave({ configured: true, environmentSupported: true, environmentKeys: ['DESK_DISPLAY_TOKEN'] })
    await save
    if (outcome === 'resolve') finishRead({ configured: true, environmentSupported: true, environmentKeys: [] })
    else failRead(new Error('old failed read'))
    await read
    expect(taskHook.config).toMatchObject({
      available: true, configured: true, environmentSupported: true, environmentKeys: ['DESK_DISPLAY_TOKEN'],
    })
  })

  it('still runs an already configured hook if its first GET overlaps an environment save', async () => {
    let finishRead!: (value: unknown) => void
    let finishSave!: (value: unknown) => void
    request.mockImplementation((method) => {
      if (method === 'host.taskHook.get') return new Promise((resolve) => { finishRead = resolve })
      if (method === 'host.taskHook.setEnvironment') return new Promise((resolve) => { finishSave = resolve })
      return Promise.resolve({ ok: true, status: 'synced' })
    })
    const sync = syncTaskHook(id, '合同')
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('host.taskHook.get', {}))
    const save = setTaskHookEnvironment('DESK_DISPLAY_TOKEN=test-only-token')
    finishRead({ configured: true, environmentSupported: true, environmentKeys: [] })
    await sync
    expect(request).toHaveBeenCalledWith('host.taskHook.run', { taskId: id })
    expect(taskHook.jobs[id].status).toBe('synced')
    finishSave({ configured: true, environmentSupported: true, environmentKeys: ['DESK_DISPLAY_TOKEN'] })
    await save
    expect(taskHook.config.environmentKeys).toEqual(['DESK_DISPLAY_TOKEN'])
  })

})
