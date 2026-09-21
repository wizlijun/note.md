import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadBookStyleRule, onDocument, renderDocument, renderNext, saveBookStyleRule } from './bridge'

describe('typeset file-view bridge', () => {
  const request = vi.fn()
  const postMessage = vi.fn()

  beforeEach(() => {
    request.mockReset()
    postMessage.mockReset()
    Object.assign(window, { notemd: { locale: 'zh', request } })
    Object.defineProperty(window, 'parent', { value: { postMessage }, configurable: true })
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('acknowledges a valid snapshot before starting render work', () => {
    const callback = vi.fn()
    const off = onDocument(callback)
    const data = { type: 'file_view.open', viewId: 'typeset', requestId: 7, uri: '/vault/book.typeset.md', content: '# Book' }
    window.dispatchEvent(new MessageEvent('message', { data, origin: 'tauri://localhost', source: window.parent }))
    expect(postMessage).toHaveBeenCalledWith({ type: 'file_view.ready', requestId: 7 }, 'tauri://localhost')
    expect(callback).toHaveBeenCalledWith({ uri: data.uri, content: data.content, requestId: 7 })
    off()
  })

  it('ignores ordinary Markdown and foreign origins', () => {
    const callback = vi.fn()
    const off = onDocument(callback)
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'file_view.open', viewId: 'typeset', requestId: 1, uri: '/vault/book.md', content: '' }, origin: 'tauri://localhost', source: window.parent }))
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'file_view.open', viewId: 'typeset', requestId: 2, uri: '/vault/book.typeset.md', content: '' }, origin: 'https://evil.test', source: window.parent }))
    expect(callback).not.toHaveBeenCalled()
    expect(postMessage).not.toHaveBeenCalled()
    off()
  })

  it('passes the exact snapshot and Vault root to the native renderer', async () => {
    request.mockResolvedValueOnce({ root: '/vault' }).mockResolvedValueOnce({ cache_key: 'a'.repeat(64), page_count: 3, hit: true, complete: true, busy: false })
    const result = await renderDocument({ uri: '/vault/book.typeset.md', content: '# Book', requestId: 1 }, 'auto')
    expect(result.hit).toBe(true)
    expect(request.mock.calls).toEqual([
      ['host.vault.info'],
      ['plugin.render', { uri: '/vault/book.typeset.md', content: '# Book', vault_root: '/vault', book_style: 'auto' }],
    ])
  })

  it('requests the next render batch independently of document preparation', async () => {
    const key = 'b'.repeat(64)
    request.mockResolvedValueOnce({ cache_key: key, page_count: 7, hit: false, complete: false, busy: true })
    await expect(renderNext(key)).resolves.toEqual({ cache_key: key, page_count: 7, hit: false, complete: false, busy: true })
    expect(request).toHaveBeenCalledWith('plugin.render-next', { cache_key: key })
  })

  it('loads and saves the controlled template rule through plugin-scoped settings', async () => {
    request.mockResolvedValueOnce({ settings: { bookStyle: 'aiwriter-book' } })
    await expect(loadBookStyleRule()).resolves.toBe('aiwriter-book')
    request.mockResolvedValueOnce({ ok: true })
    await saveBookStyleRule('wonderous-book')
    expect(request).toHaveBeenLastCalledWith('host.settings.set', { key: 'bookStyle', value: 'wonderous-book' })
  })

})
