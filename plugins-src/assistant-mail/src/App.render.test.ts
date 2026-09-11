import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import App from './App.svelte'

let component: ReturnType<typeof mount> | null = null

afterEach(() => {
  if (component) unmount(component)
  component = null
  document.body.innerHTML = ''
})

async function settle() {
  await Promise.resolve()
  await tick()
  flushSync()
}

function installBridge() {
  const request = vi.fn(async (method: string, params?: any) => {
    if (method === 'plugin.settings.get') return {
      worker_url: 'https://mail.example.test', key_configured: true,
      key_fingerprint: 'sha256:0123456789ab', local_cursor: null,
      archived_sources: 0, archived_raw: 0,
    }
    if (method === 'plugin.settings.save') return {
      worker_url: params.worker_url, key_configured: true,
      key_fingerprint: 'sha256:fedcba987654', local_cursor: null,
      archived_sources: 0, archived_raw: 0,
    }
    if (method === 'plugin.delete.plan.create') return {
      id: 'plan-1', plan_hash: 'hash-1', source_ids: params.source_ids,
    }
    if (method === 'plugin.delete.plan.get') return {
      id: params.plan_id, plan_hash: 'hash-from-agent', source_ids: ['source-from-agent'],
    }
    if (method === 'plugin.delete.plan.execute') return { job_id: 'job-1' }
    return { ok: true }
  })
  window.notemd = { pluginId: 'notemd.assistant-mail', locale: 'zh', theme: 'light', request, onMessage: () => {} }
  return request
}

describe('Assistant Mail settings window', () => {
  it('never renders or retains the entered access key after save', async () => {
    const request = installBridge()
    component = mount(App, { target: document.body })
    await vi.waitFor(() => expect(document.body.textContent).toContain('凭证已配置'))
    const key = document.querySelector<HTMLInputElement>('input[type="password"]')!
    key.value = 'super-secret-key-that-must-not-render-123'
    key.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '保存设置')!.click()
    await vi.waitFor(() => expect(key.value).toBe(''))
    expect(document.body.textContent).not.toContain('super-secret-key-that-must-not-render-123')
    expect(request).toHaveBeenCalledWith('plugin.settings.save', expect.objectContaining({ worker_url: 'https://mail.example.test' }))
  })

  it('requires exact DELETE confirmation before trusted-window execution', async () => {
    const request = installBridge()
    component = mount(App, { target: document.body })
    await vi.waitFor(() => expect(document.body.textContent).toContain('凭证已配置'))
    const ids = document.querySelector<HTMLTextAreaElement>('textarea')!
    ids.value = 'source-1'
    ids.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '生成删除计划')!.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('执行这个精确计划'))
    const execute = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === '执行这个精确计划')!
    expect(execute.disabled).toBe(true)
    const confirm = document.querySelector<HTMLInputElement>('.plan input')!
    confirm.value = 'DELETE'
    confirm.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(execute.disabled).toBe(false)
    execute.click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('plugin.delete.plan.execute', {
      plan_id: 'plan-1', plan_hash: 'hash-1', confirmation: 'DELETE',
    }))
  })

  it('loads the exact Agent-created plan before allowing confirmation', async () => {
    const request = installBridge()
    component = mount(App, { target: document.body })
    await vi.waitFor(() => expect(document.body.textContent).toContain('凭证已配置'))
    const input = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
      .find((value) => value.placeholder.includes('plan id'))!
    input.value = 'agent-plan-1'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent === '回源加载这个计划')!.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('hash-from-agent'))
    expect(request).toHaveBeenCalledWith('plugin.delete.plan.get', { plan_id: 'agent-plan-1' })
    const execute = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === '执行这个精确计划')!
    expect(execute.disabled).toBe(true)
  })
})
