import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelRender, downloadFonts, fontDownloadStatus, loadBookStyleRule, onDocument, renderDocument, renderNext, saveBookStyleRule } from './bridge'

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
    request.mockResolvedValueOnce({ root: '/vault' }).mockResolvedValueOnce({ render_id: 'render-1', stage: 'complete', completed_chunks: 1, total_chunks: 2, cache_key: 'a'.repeat(64), page_count: 3, hit: true, complete: true, busy: false })
    const result = await renderDocument({ uri: '/vault/book.typeset.md', content: '# Book', requestId: 1 }, 'auto')
    expect(result.hit).toBe(true)
    expect(request.mock.calls).toEqual([
      ['host.vault.info'],
      ['plugin.render', { uri: '/vault/book.typeset.md', content: '# Book', vault_root: '/vault', book_style: 'auto' }],
    ])
  })

  it('polls only the current render session independently of the cache key', async () => {
    const key = 'b'.repeat(64)
    request.mockResolvedValueOnce({ render_id: 'render-1', stage: 'rendering', completed_chunks: 1, total_chunks: 2, cache_key: key, page_count: 7, hit: false, complete: false, busy: true })
    await expect(renderNext('render-1')).resolves.toEqual({ render_id: 'render-1', stage: 'rendering', completed_chunks: 1, total_chunks: 2, cache_key: key, page_count: 7, hit: false, complete: false, busy: true })
    expect(request).toHaveBeenCalledWith('plugin.render-next', { render_id: 'render-1' })
  })

  it('loads and saves the controlled template rule through plugin-scoped settings', async () => {
    request.mockResolvedValueOnce({ settings: { bookStyle: 'aiwriter-book' } })
    await expect(loadBookStyleRule()).resolves.toBe('aiwriter-book')
    request.mockResolvedValueOnce({ ok: true })
    await saveBookStyleRule('wonderous-book')
    expect(request).toHaveBeenLastCalledWith('host.settings.set', { key: 'bookStyle', value: 'wonderous-book' })
  })

  it('accepts queued preparation without a cache key and cancels by session', async () => {
    request.mockResolvedValueOnce({ root: '/vault' }).mockResolvedValueOnce({ render_id: 'queued-1', stage: 'queued', completed_chunks: 0, total_chunks: 0, cache_key: '', page_count: 0, hit: false, complete: false, busy: true })
    await expect(renderDocument({ uri: '/vault/book.typeset.md', content: '# Book', requestId: 1 }, 'auto')).resolves.toMatchObject({ cache_key: '', stage: 'queued' })
    request.mockResolvedValueOnce({ ok: true })
    await cancelRender('queued-1')
    expect(request).toHaveBeenLastCalledWith('plugin.cancel', { render_id: 'queued-1' })
  })

  it('rejects progress belonging to another view session', async () => {
    request.mockResolvedValueOnce({ render_id: 'other', stage: 'rendering', completed_chunks: 1, total_chunks: 2, cache_key: 'a', page_count: 1, hit: false, complete: false, busy: true })
    await expect(renderNext('this-view')).rejects.toThrow('invalid progress')
  })

  it('starts only a fixed font bundle and validates download progress', async () => {
    const progress = { style: 'cjk', stage: 'downloading', completed: 1, total: 3 }
    request.mockResolvedValueOnce(progress).mockResolvedValueOnce({ ...progress, stage: 'complete', completed: 3 })
    await expect(downloadFonts('cjk')).resolves.toEqual(progress)
    expect(request).toHaveBeenCalledWith('plugin.fonts-download', { style: 'cjk' })
    await expect(fontDownloadStatus()).resolves.toMatchObject({ stage: 'complete', completed: 3 })
  })

})
