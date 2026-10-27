// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'

const request = vi.hoisted(() => vi.fn())
vi.mock('../lib/bridge', () => ({ bridge: () => ({ request }) }))
import { setLocale } from '../lib/strings'
import { syncTaskHook, taskHook } from '../lib/task-hook.svelte'
import TaskHookStatus from './TaskHookStatus.svelte'

const taskId = '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8'
let component: ReturnType<typeof mount> | undefined
beforeEach(() => {
  setLocale('zh')
  request.mockReset()
  taskHook.jobs = {}
  taskHook.config = { available: false, configured: false }
})
afterEach(() => {
  setLocale('en')
  if (component) unmount(component)
  component = undefined
  document.body.innerHTML = ''
})

describe('Task hook failure feedback', () => {
  it.each([
    ['missing_cube_config', '缺少 Cube 配置'],
    ['cube_unavailable', '无法连接 Cube'],
    ['sync_busy', '另一个同步正在运行'],
    ['cube_safe_create_unavailable', 'Cube 服务尚不支持安全创建'],
  ])('shows the safe reason for %s and retries only synchronization', async (errorCode, message) => {
    let runs = 0
    request.mockImplementation(async (method) => method === 'host.taskHook.get'
      ? { configured: true }
      : (++runs === 1 ? { ok: false, status: 'pending', errorCode, exitCode: 1 }
        : { ok: true, status: 'synced' }))
    component = mount(TaskHookStatus, { target: document.body })
    await syncTaskHook(taskId, '诊断任务')
    flushSync()
    expect(document.body.textContent).toContain('已保存')
    expect(document.body.textContent).toContain(message)
    if (errorCode === 'missing_cube_config') {
      expect(document.body.textContent).toContain('~/.config/desk-display/env')
      expect(document.body.textContent).toContain('DESK_DISPLAY_TOKEN')
    }
    document.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Cube 已同步'))
    expect(request.mock.calls).toEqual([
      ['host.taskHook.get', {}], ['host.taskHook.run', { taskId }],
      ['host.taskHook.get', {}], ['host.taskHook.run', { taskId }],
    ])
  })

  it('never renders arbitrary error details from a script', () => {
    taskHook.jobs[taskId] = {
      taskId, title: '诊断任务', status: 'pending', errorCode: 'private token=secret',
    }
    component = mount(TaskHookStatus, { target: document.body })
    flushSync()
    expect(document.body.textContent).toContain('Cube 待同步')
    expect(document.body.textContent).not.toContain('private token=secret')
  })
})
