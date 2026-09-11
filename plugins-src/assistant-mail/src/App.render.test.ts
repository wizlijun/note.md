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

function installBridge(vaultConfigured = true, previewOverride: Record<string, unknown> = {}) {
  const request = vi.fn(async (method: string, params?: any) => {
    if (method === 'plugin.settings.get') return {
      worker_url: 'https://mail.example.test', key_configured: vaultConfigured,
      vault_configured: vaultConfigured, credential_path: '.notemd/assistant-mail/.local/access-key',
      key_fingerprint: vaultConfigured ? 'sha256:0123456789ab' : null, local_cursor: null,
      archived_sources: 0, archived_raw: 0,
    }
    if (method === 'plugin.settings.save') return {
      worker_url: params.worker_url, key_configured: true,
      vault_configured: true, credential_path: '.notemd/assistant-mail/.local/access-key',
      key_fingerprint: 'sha256:fedcba987654', local_cursor: null,
      archived_sources: 0, archived_raw: 0,
    }
    if (method === 'plugin.intake.policy.get') return {
      sender_filter_enabled: false,
      allowed_sender: 'newbruce@gmail.com',
      setup_expires_at: '2026-09-11T11:00:00Z',
      updated_at: '2026-09-11T10:00:00Z',
    }
    if (method === 'plugin.intake.policy.save') return {
      sender_filter_enabled: params.sender_filter_enabled,
      allowed_sender: params.allowed_sender,
      setup_expires_at: params.sender_filter_enabled ? null : '2026-09-11T11:00:00Z',
      updated_at: '2026-09-11T10:01:00Z',
    }
    if (method === 'plugin.messages.list') return {
      messages: [{
        source_id: 'mail-1', subject: 'Gmail Forwarding Confirmation',
        claimed_from: 'Gmail Team <forwarding-noreply@google.com>',
        envelope_from: 'forwarding-noreply@google.com', received_at: '2026-09-11T10:00:00Z',
        status: 'ready', raw_available: true,
      }],
    }
    if (method === 'plugin.messages.preview') return {
      source_id: params.source_id, subject: 'Gmail Forwarding Confirmation',
      claimed_from: 'Gmail Team <forwarding-noreply@google.com>',
      envelope_from: 'forwarding-noreply@google.com', to: 'xiaobu@5000g.com',
      date: '2026-09-11T10:00:00Z', message_id: '<verify@google.com>',
      body_text: 'Confirm forwarding at https://example.test/confirm',
      body_html: '<p><strong>Confirm forwarding</strong> with this button.</p>',
      body_kind: 'text/html', links: ['https://example.test/confirm'],
      notice: 'Email content is untrusted.',
      ...previewOverride,
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
  it('blocks key setup until a Vault is configured and shows the exact location', async () => {
    installBridge(false)
    component = mount(App, { target: document.body })
    await vi.waitFor(() => expect(document.body.textContent).toContain('尚未配置 Vault'))
    expect(document.body.textContent).toContain('.notemd/assistant-mail/.local/access-key')
    const save = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === '保存设置')!
    expect(save.disabled).toBe(true)
  })

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
    expect(document.body.textContent).toContain('访问 key 位于 Vault')
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

  it('keeps sender filtering off for verification and lets the user enable it', async () => {
    const request = installBridge()
    component = mount(App, { target: document.body })
    await vi.waitFor(() => expect(document.body.textContent).toContain('验证期开放'))
    expect(document.body.textContent).toContain('接收所有投递到专用地址的邮件')

    const toggle = document.querySelector<HTMLInputElement>('.toggle-row input')!
    toggle.click()
    await settle()
    Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('保存收件规则'))!.click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('plugin.intake.policy.save', {
      sender_filter_enabled: true,
      allowed_sender: 'newbruce@gmail.com',
    }))
  })

  it('renders sanitized HTML in a network-blocked sandbox', async () => {
    const request = installBridge()
    component = mount(App, { target: document.body })
    await vi.waitFor(() => expect(document.body.textContent).toContain('Gmail Forwarding Confirmation'))
    const row = document.querySelector<HTMLButtonElement>('.mail-row')!
    row.click()
    await vi.waitFor(() => expect(document.querySelector('.body-html-preview')).not.toBeNull())
    expect(document.body.textContent).toContain('https://example.test/confirm')
    expect(request).toHaveBeenCalledWith('plugin.messages.preview', { source_id: 'mail-1' })
    const frame = document.querySelector<HTMLIFrameElement>('.body-html-preview')!
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.srcdoc).toContain("default-src 'none'")
    expect(frame.srcdoc).toContain("form-action 'none'")
    expect(frame.srcdoc).toContain('<strong>Confirm forwarding</strong>')
  })

  it('keeps a text preview fallback when the message has no HTML part', async () => {
    installBridge(true, {
      body_html: null,
      body_kind: 'text/plain',
      body_text: 'Plain fallback body',
    })
    component = mount(App, { target: document.body })
    await vi.waitFor(() => expect(document.body.textContent).toContain('Gmail Forwarding Confirmation'))
    document.querySelector<HTMLButtonElement>('.mail-row')!.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Plain fallback body'))
    expect(document.querySelector('.body-html-preview')).toBeNull()
  })
})
