import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.svelte'
import fixture from '../fixtures/minimal-valid.json?raw'

const request = vi.fn()
let app: ReturnType<typeof mount> | undefined

function send(content = fixture, requestId = 1): void {
  window.dispatchEvent(new MessageEvent('message', {
    origin: 'tauri://localhost', source: window,
    data: { type: 'file_view.open', viewId: 'knowledge', requestId, uri: '/vault/inbox/result.json', content },
  }))
}

beforeEach(() => {
  request.mockReset()
  request.mockImplementation(async (method: string, params?: { path?: string }) => {
    if (method === 'host.vault.info') return { root: '/vault', wiki_dir: null, daily_dir: null }
    if (method === 'host.vault.list') return { entries: params?.path === 'research' ? [{ name: 'fixture.knowledge.json', is_dir: false }] : [] }
    if (method === 'host.vault.read') return { content: fixture }
    return { ok: true }
  })
  Object.assign(window, { notemd: { pluginId: 'notemd.knowledge-browser', locale: 'zh', theme: 'system', request } })
})

afterEach(async () => {
  if (app) await unmount(app)
  app = undefined
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('Knowledge Browser application', () => {
  it('acknowledges a valid file snapshot only after rendering the shared reader', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    app = mount(App, { target: document.body })
    flushSync(); send()
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'file_view.ready', requestId: 1 }, 'tauri://localhost'))
    expect(document.body.textContent).toContain('发布执行人须在获得工程负责人批准后执行发布')
    expect(document.body.textContent).toContain('提取门槛strong_only · ≥ strong')
    expect(document.body.textContent).toContain('证据强度strong')
    expect(document.body.textContent).not.toContain('编辑 JSON 原文')
    expect(request).not.toHaveBeenCalledWith('host.vault.write', expect.anything())
  })

  it('falls back without changing malformed JSON', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    app = mount(App, { target: document.body })
    flushSync(); send('{"schema":', 2)
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'file_view.fallback', requestId: 2 }, 'tauri://localhost'))
    expect(request).not.toHaveBeenCalledWith('host.vault.write', expect.anything())
  })

  it('falls back when an ordinary JSON object has no knowledge schema marker', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    app = mount(App, { target: document.body })
    flushSync(); send('{"name":"ordinary"}', 3)
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'file_view.fallback', requestId: 3 }, 'tauri://localhost'))
    expect(request).not.toHaveBeenCalledWith('host.vault.write', expect.anything())
  })

  it('keeps recognized but invalid v3.1 content in the knowledge diagnostics view', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    const invalid = JSON.parse(fixture) as Record<string, unknown>
    delete invalid.selection
    app = mount(App, { target: document.body })
    flushSync(); send(JSON.stringify(invalid), 4)
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'file_view.ready', requestId: 4 }, 'tauri://localhost'))
    expect(document.body.textContent).toContain('缺少必填字段 selection')
  })

  it('keeps a compatibility warning in the reading view', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    const compatible = JSON.parse(fixture) as Record<string, any>
    compatible.generated.rule = 'relation-schema-extractor/3.1.0'
    app = mount(App, { target: document.body })
    flushSync(); send(JSON.stringify(compatible), 5)
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'file_view.ready', requestId: 5 }, 'tauri://localhost'))
    expect(document.body.textContent).toContain('发布执行人须在获得工程负责人批准后执行发布')
    expect(document.body.textContent).not.toContain('兼容旧规则')
  })
})
