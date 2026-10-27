// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'

const request = vi.hoisted(() => vi.fn())
vi.mock('../lib/bridge', () => ({ bridge: () => ({ request }) }))
import { setLocale } from '../lib/strings'
import { taskHook } from '../lib/task-hook.svelte'
import TaskHookSettings from './TaskHookSettings.svelte'

let component: ReturnType<typeof mount> | undefined
const configuration = (environmentKeys: string[] = []) => ({
  configured: false, environmentSupported: true, environmentKeys,
})
const draft = 'DESK_DISPLAY_URL=https://example.invalid\nDESK_DISPLAY_TOKEN=test-only-token'
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find((element) => element.textContent === label)!
const input = () => document.querySelector<HTMLTextAreaElement>('textarea')!
function enter(value: string) {
  input().value = value
  input().dispatchEvent(new Event('input', { bubbles: true }))
  flushSync()
}
async function open() {
  component = mount(TaskHookSettings, { target: document.body })
  flushSync()
  await vi.waitFor(() => expect(button('选择 Python 脚本…').disabled).toBe(false))
}

beforeEach(() => {
  setLocale('zh')
  request.mockReset()
  taskHook.config = { available: false, configured: false }
  taskHook.jobs = {}
})
afterEach(async () => {
  setLocale('en')
  if (component) await unmount(component)
  component = undefined
  document.body.innerHTML = ''
})

describe('Task hook environment settings', () => {
  it('saves without selecting or running a script, clears the draft and reopens with names only', async () => {
    let saved = false
    request.mockImplementation(async (method, params) => {
      if (method === 'host.taskHook.setEnvironment') {
        expect(params).toEqual({ text: draft })
        saved = true
      }
      return configuration(saved ? ['DESK_DISPLAY_TOKEN', 'DESK_DISPLAY_URL'] : [])
    })
    await open()
    expect(input().placeholder).toContain('https://example.invalid')
    expect(document.body.textContent).toContain('不影响定时任务')
    enter(draft)
    button('保存环境变量').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('环境变量已保存'))
    expect(document.body.textContent).toContain('仅保存在本机，尚未测试连接')
    expect(input().value).toBe('')
    expect(document.querySelector('[data-environment-keys]')!.textContent).toContain('DESK_DISPLAY_TOKEN, DESK_DISPLAY_URL')
    expect(taskHook.config.configured).toBe(false)
    await unmount(component!)
    component = undefined
    await open()
    expect(input().value).toBe('')
    expect(document.body.textContent).not.toContain('test-only-token')
    expect(request.mock.calls).toEqual([
      ['host.taskHook.get', {}], ['host.taskHook.setEnvironment', { text: draft }], ['host.taskHook.get', {}],
    ])
  })

  it('clears only environment overrides without disabling or executing the selected script', async () => {
    request.mockImplementation(async (method) => ({
      ...configuration(method === 'host.taskHook.get' ? ['DESK_DISPLAY_TOKEN'] : []),
      configured: true, scriptPath: '/vault/skills/sync.py',
    }))
    await open()
    enter(draft)
    button('清除已保存变量').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('环境变量覆盖已清除'))
    expect(input().value).toBe('')
    expect(taskHook.config.configured).toBe(true)
    expect(taskHook.config.scriptPath).toBe('/vault/skills/sync.py')
    expect(button('清除已保存变量').disabled).toBe(true)
    expect(request.mock.calls).toEqual([
      ['host.taskHook.get', {}], ['host.taskHook.setEnvironment', { text: '' }],
    ])
  })

  it('keeps the draft on failure and never displays error details', async () => {
    request.mockImplementation(async (method) => {
      if (method === 'host.taskHook.setEnvironment') throw new Error('private-error-token')
      return configuration()
    })
    await open()
    enter(draft)
    button('保存环境变量').click()
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('无法保存环境变量'))
    expect(input().value).toBe(draft)
    expect(document.body.textContent).not.toContain('private-error-token')
    expect(button('保存环境变量').disabled).toBe(false)
    expect(request.mock.calls.map(([method]) => method)).toEqual(['host.taskHook.get', 'host.taskHook.setEnvironment'])
  })

  it('blocks repeated mutations while a save is pending', async () => {
    let resolveSave!: (value: ReturnType<typeof configuration>) => void
    request.mockImplementation((method) => method === 'host.taskHook.get'
      ? Promise.resolve(configuration(['DESK_DISPLAY_TOKEN']))
      : new Promise((resolve) => { resolveSave = resolve }))
    await open()
    enter(draft)
    const save = button('保存环境变量')
    save.click()
    save.click()
    flushSync()
    expect(input().disabled).toBe(true)
    expect([...document.querySelectorAll('button')].every((element) => element.disabled)).toBe(true)
    expect(request.mock.calls.filter(([method]) => method === 'host.taskHook.setEnvironment')).toHaveLength(1)
    resolveSave(configuration(['DESK_DISPLAY_TOKEN', 'DESK_DISPLAY_URL']))
    await vi.waitFor(() => expect(input().disabled).toBe(false))
  })

  it('retains script selection on an older host and explains that environment support needs an update', async () => {
    request.mockResolvedValue({ configured: false })
    await open()
    expect(document.body.textContent).toContain('请更新 note.md 后在这里配置脚本环境变量')
    expect(document.querySelector('textarea')).toBeNull()
    button('选择 Python 脚本…').click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('host.taskHook.select', {}))
    expect(request.mock.calls.map(([method]) => method)).toEqual(['host.taskHook.get', 'host.taskHook.select'])
  })
})
