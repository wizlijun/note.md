import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.svelte'
import fixture from '../fixtures/minimal-valid.json?raw'

const request = vi.fn()
let app: ReturnType<typeof mount> | undefined

function send(content = fixture, requestId = 1): void {
  window.dispatchEvent(new MessageEvent('message', {
    origin: 'tauri://localhost', source: window,
    data: { type: 'file_view.open', viewId: 'knowledge', requestId, uri: '/vault/research/fixture.knowledge.json', content },
  }))
}

beforeEach(() => {
  request.mockReset()
  request.mockImplementation(async (method: string, params?: { path?: string }) => {
    if (method === 'host.vault.info') return { root: '/vault', wiki_dir: null, daily_dir: null }
    if (method === 'host.vault.list') return { entries: params?.path === 'research' ? [{ name: 'fixture.knowledge.json', is_dir: false }] : [] }
    if (method === 'host.vault.read') return { content: fixture }
    if (method === 'host.settings.get') return { settings: {} }
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
    app = mount(App, { target: document.body, props: { entry: 'viewer' } })
    flushSync(); send()
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'file_view.ready', requestId: 1 }, 'tauri://localhost'))
    expect(document.body.textContent).toContain('发布执行人须在获得工程负责人批准后执行发布')
    expect(request).not.toHaveBeenCalledWith('host.vault.write', expect.anything())
  })

  it('falls back without changing malformed JSON', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    app = mount(App, { target: document.body, props: { entry: 'viewer' } })
    flushSync(); send('{"schema":', 2)
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'file_view.fallback', requestId: 2 }, 'tauri://localhost'))
    expect(request).not.toHaveBeenCalledWith('host.vault.write', expect.anything())
  })

  it('discovers a Vault dataset in the standalone window and exposes relation/time/diagnostic modes', async () => {
    app = mount(App, { target: document.body, props: { entry: 'browser' } })
    await vi.waitFor(() => expect(document.querySelector('select option[value="research/fixture.knowledge.json"]')).not.toBeNull())
    const selector = document.querySelector('select[aria-label="数据集"]') as HTMLSelectElement
    selector.value = 'research/fixture.knowledge.json'; selector.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(document.body.textContent).toContain('发布执行人须在获得工程负责人批准后执行发布'))
    for (const label of ['关系', '时间', '诊断']) expect([...document.querySelectorAll('button')].some(button => button.textContent === label)).toBe(true)
  })
})
