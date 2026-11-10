// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { setLocale } from '../lib/strings'
import CreateTaskSheet from './CreateTaskSheet.svelte'

setLocale('zh')

let component: ReturnType<typeof mount> | null = null

afterEach(() => {
  if (component) unmount(component)
  component = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function input(name: string, value: string): void {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!
  field.value = value
  field.dispatchEvent(new InputEvent('input', { bubbles: true }))
}

describe('CreateTaskSheet', () => {
  it('creates an Inbox Task with Control-Enter and keeps optional fields structured', async () => {
    const onSubmit = vi.fn(async () => {})
    component = mount(CreateTaskSheet, {
      target: document.body,
      props: { taskDir: 'inbox/tasks', saving: false, onCancel: vi.fn(), onSubmit },
    })
    flushSync()

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('inbox/tasks')
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    }))
    flushSync()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('任务')
    expect(onSubmit).not.toHaveBeenCalled()

    input('title', '提交 TestFlight 构建')
    input('body', '确认签名环境变量。')
    input('done_when', '构建可安装')
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    }))
    await Promise.resolve()

    expect(onSubmit).toHaveBeenCalledWith({
      title: '提交 TestFlight 构建',
      body: '确认签名环境变量。',
      done_when: '构建可安装',
      priority: 'P2',
      contexts: [],
    }, false)
  })

  it('submits once with Linux Ctrl+Enter, ignoring Super, extra modifiers and IME/repeat/consumed events', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64')
    const onSubmit = vi.fn(async () => {})
    component = mount(CreateTaskSheet, { target: document.body,
      props: { taskDir: 'inbox/tasks', saving: false, onCancel: vi.fn(), onSubmit } })
    flushSync(); input('title', '只创建一次')
    for (const init of [
      { metaKey: true }, { ctrlKey: true, metaKey: true },
      { ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true },
      { ctrlKey: true, repeat: true }, { ctrlKey: true, isComposing: true }, { ctrlKey: true, keyCode: 229 },
    ]) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ...init, cancelable: true }))
    const consumed = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true })
    consumed.preventDefault(); window.dispatchEvent(consumed)
    await Promise.resolve(); expect(onSubmit).not.toHaveBeenCalled()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true }))
    await Promise.resolve()
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ title: '只创建一次', priority: 'P2', contexts: [] }, false)
  })
  it('requires a close condition only for the explicit mark-current action', async () => {
    const onSubmit = vi.fn(async () => {})
    component = mount(CreateTaskSheet, {
      target: document.body,
      props: { taskDir: 'inbox/tasks', saving: false, onCancel: vi.fn(), onSubmit },
    })
    flushSync()
    input('title', '提交构建')

    document.querySelector<HTMLButtonElement>('[data-action="create-current"]')!.click()
    flushSync()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('完成条件')
    expect(onSubmit).not.toHaveBeenCalled()

    input('done_when', 'TestFlight 可安装')
    document.querySelector<HTMLButtonElement>('[data-action="create-current"]')!.click()
    await Promise.resolve()
    expect(onSubmit).toHaveBeenCalledWith({
      title: '提交构建',
      done_when: 'TestFlight 可安装',
      priority: 'P2',
      contexts: [],
    }, true)
  })

  it('closes with Escape only while idle', () => {
    const onCancel = vi.fn()
    component = mount(CreateTaskSheet, {
      target: document.body,
      props: { taskDir: 'inbox/tasks', saving: false, onCancel, onSubmit: vi.fn() },
    })
    flushSync()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
