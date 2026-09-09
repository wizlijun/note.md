// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, mount, tick, unmount } from 'svelte'
import { fromStore, writable } from 'svelte/store'
import FilePluginView from './FilePluginView.svelte'
import { i18n } from '../lib/i18n/store.svelte'
import type { Tab } from '../lib/tabs.svelte'
import { pluginRuntime } from '../lib/plugins/runtime.svelte'
import type { PluginManifest } from '../lib/plugins/types'

const openFileViewPage = vi.hoisted(() => vi.fn())
vi.mock('../lib/plugins/file-view-pages', () => ({ openFileViewPage }))

describe('FilePluginView', () => {
  let component: ReturnType<typeof mount> | undefined
  const initialContent = '---\ntype: Timeline\n---\n## 09:00–10:00 开发'
  const view = { pluginId: 'notemd.timeline', viewId: 'timeline', entry: 'index.html', icon: 'clock' as const }

  afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
    openFileViewPage.mockReset()
    pluginRuntime.manifests = []
  })

  async function setup() {
    i18n.locale = 'zh'
    const store = writable({ id: 'tab-1', title: 'day.timeline.md', filePath: '/diary/day.timeline.md', currentContent: initialContent } as Tab)
    const tab = fromStore(store)
    component = mount(FilePluginView, {
      target: document.body,
      props: {
        get tab() { return tab.current },
        view,
        fallback: createRawSnippet(() => ({ render: () => '<div class="fallback-editor">Markdown editor</div>' })),
      },
    })
    await tick()
    const frame = document.querySelector('iframe')!
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
    frame.dispatchEvent(new Event('load'))
    await tick()
    const reply = (type: string, requestId: number, reason?: string, targetFrame = frame) => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'plugin://notemd.timeline', source: targetFrame.contentWindow,
        data: { type, requestId, reason },
      }))
    }
    return { store, frame, postMessage, reply }
  }

  it('hands the current document to the frame and reveals only an acknowledged snapshot', async () => {
    const { frame, postMessage, reply } = await setup()
    expect(postMessage).toHaveBeenCalledWith({ type: 'file_view.open', uri: '/diary/day.timeline.md', content: initialContent, viewId: 'timeline', requestId: 1 }, 'plugin://notemd.timeline')
    expect(frame.getAttribute('sandbox')?.split(' ')).toContain('allow-forms')
    expect(frame.classList.contains('pending')).toBe(true)
    reply('file_view.ready', 1)
    await tick()
    expect(frame.classList.contains('pending')).toBe(false)
    expect(document.querySelector('.fallback-editor')).toBeNull()
  })

  it('hides stale content during an update and ignores the previous snapshot acknowledgement', async () => {
    const { store, frame, postMessage, reply } = await setup()
    reply('file_view.ready', 1)
    await tick()
    store.update((tab) => ({ ...tab, currentContent: initialContent + '\nnew item' }))
    await tick()
    expect(frame.classList.contains('pending')).toBe(true)
    expect(postMessage.mock.lastCall?.[0].requestId).toBe(2)
    reply('file_view.ready', 1)
    await tick()
    expect(frame.classList.contains('pending')).toBe(true)
    reply('file_view.ready', 2)
    await tick()
    expect(frame.classList.contains('pending')).toBe(false)
  })

  it('falls back on parse failure and leaves retry to the shared host switcher', async () => {
    const { store, reply } = await setup()
    reply('file_view.fallback', 1)
    await tick()
    expect(document.querySelector('.fallback-editor')).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
    store.update((tab) => ({ ...tab, currentContent: initialContent + '\ncorrected item' }))
    await tick()
    expect(document.querySelector('.fallback-editor')).toBeTruthy()
    expect(document.querySelector('.file-plugin-fallback button')).toBeNull()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('keeps an explicit edit request in Markdown and retries after external reload', async () => {
    const { reply } = await setup()
    reply('file_view.fallback', 1, 'edit')
    await tick()
    expect(document.querySelector('.file-plugin-fallback')?.textContent).toContain('正在使用默认编辑器')
    window.dispatchEvent(new CustomEvent('notemd:auto-reloaded', { detail: { tabId: 'another-tab' } }))
    await tick()
    expect(document.querySelector('iframe')).toBeNull()
    window.dispatchEvent(new CustomEvent('notemd:auto-reloaded', { detail: { tabId: 'tab-1' } }))
    await tick()
    expect(document.querySelector('iframe')).toBeTruthy()
  })

  it('falls back after a load error', async () => {
    const { frame } = await setup()
    frame.dispatchEvent(new Event('error'))
    await tick()
    expect(document.querySelector('.fallback-editor')).toBeTruthy()
  })

  it('times out even if iframe load happens late', async () => {
    vi.useFakeTimers()
    const { frame, reply } = await setup()
    await vi.advanceTimersByTimeAsync(7_500)
    frame.dispatchEvent(new Event('load'))
    await vi.advanceTimersByTimeAsync(500)
    await tick()
    expect(document.querySelector('.fallback-editor')).toBeTruthy()
    // A stale success after timeout cannot replace the mounted Markdown editor.
    reply('file_view.ready', 1)
    await tick()
    expect(document.querySelector('.fallback-editor')).toBeTruthy()
  })

  it('clears the loading deadline after a successful parse', async () => {
    vi.useFakeTimers()
    const { frame, reply } = await setup()
    reply('file_view.ready', 1)
    await tick()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(document.querySelector('.fallback-editor')).toBeNull()
    expect(frame.classList.contains('pending')).toBe(false)
  })

  function pageAction(frame: HTMLIFrameElement, operationId = 1, requestId = 1, origin = 'plugin://notemd.timeline', source: MessageEventSource | null = frame.contentWindow) {
    window.dispatchEvent(new MessageEvent('message', {
      origin, source, data: { type: 'file_view.open_page', requestId, operationId, target: '开发' },
    }))
  }

  function authorizePages() {
    pluginRuntime.manifests = [{ id: view.pluginId, name: 'Test', version: '1.0.0', binary: '', host_capabilities: ['editor.open'] }]
  }

  it('opens a page only after ready and deduplicates actions within the current snapshot', async () => {
    authorizePages()
    openFileViewPage.mockResolvedValue(undefined)
    const { frame, reply, postMessage, store } = await setup()
    pageAction(frame)
    expect(openFileViewPage).not.toHaveBeenCalled()
    reply('file_view.ready', 1)
    pageAction(frame)
    pageAction(frame)
    await vi.waitFor(() => expect(openFileViewPage).toHaveBeenCalledOnce())
    expect(openFileViewPage).toHaveBeenCalledWith('/diary/day.timeline.md', '开发', expect.any(Function))
    expect(postMessage).toHaveBeenCalledWith({ type: 'file_view.page_result', requestId: 1, operationId: 1, ok: true }, 'plugin://notemd.timeline')
    store.update((tab) => ({ ...tab, currentContent: 'changed snapshot' }))
    await tick()
    reply('file_view.ready', 2)
    pageAction(frame, 1, 2)
    await vi.waitFor(() => expect(openFileViewPage).toHaveBeenCalledTimes(2))
  })

  it('uses the calling manifest permission and rejects other frames, origins, and snapshots', async () => {
    pluginRuntime.manifests = [{ id: 'another.plugin', name: 'Other', version: '1.0.0', binary: '', host_capabilities: ['editor.open'] }]
    const { frame, reply, postMessage } = await setup()
    reply('file_view.ready', 1)
    pageAction(frame, 1, 1, 'https://untrusted.test')
    pageAction(frame, 1, 1, 'plugin://notemd.timeline', window)
    pageAction(frame, 1, 0)
    expect(openFileViewPage).not.toHaveBeenCalled()
    pageAction(frame)
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: 'file_view.page_result', requestId: 1, operationId: 1, ok: false, error: 'Plugin requires editor.open permission',
    }, 'plugin://notemd.timeline'))
    expect(openFileViewPage).not.toHaveBeenCalled()
  })

  it('returns navigation failures without replacing the file view', async () => {
    authorizePages()
    openFileViewPage.mockRejectedValue(new Error('Disk full'))
    const { frame, reply, postMessage } = await setup()
    reply('file_view.ready', 1)
    pageAction(frame)
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: 'file_view.page_result', requestId: 1, operationId: 1, ok: false, error: 'Disk full',
    }, 'plugin://notemd.timeline'))
    expect(document.querySelector('iframe')).toBe(frame)
  })

  it('drops an asynchronous result after the snapshot changes', async () => {
    authorizePages()
    let reject!: (error: Error) => void
    openFileViewPage.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail }))
    const { frame, reply, postMessage, store } = await setup()
    reply('file_view.ready', 1)
    pageAction(frame)
    await vi.waitFor(() => expect(openFileViewPage).toHaveBeenCalledOnce())
    const isCurrent = openFileViewPage.mock.calls[0][2]
    expect(isCurrent()).toBe(true)
    store.update((tab) => ({ ...tab, currentContent: 'new document text' }))
    await tick()
    expect(isCurrent()).toBe(false)
    reject(new Error('Old failure'))
    await tick()
    expect(postMessage.mock.calls.some(([message]) => message.type === 'file_view.page_result')).toBe(false)
  })
})
