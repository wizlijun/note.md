import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isHostOrigin, loadCover, onDocument, openLink, openPage, sourcePath } from './bridge'

const request = vi.fn()
const uri = '/vault/indexes/library.index.md'
const content = '# Library\n\n- [Book](../books/a.md) [Status:: Read]\n'
let stop: (() => void) | undefined
function send(overrides = {}, origin = 'tauri://localhost', source: MessageEventSource = window) {
  window.dispatchEvent(new MessageEvent('message', { origin, source, data: {
    type: 'file_view.open', viewId: 'index', requestId: 7, uri, content, ...overrides,
  } }))
}
beforeEach(() => {
  request.mockReset()
  Object.assign(window, { notemd: { locale: 'zh', request } })
})
afterEach(() => { stop?.(); stop = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('shared page navigation channel', () => {
  it('rejects control characters before sending a page request', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    stop = onDocument(() => {})
    send()
    post.mockClear()
    await expect(openPage(uri, '设\u0080计')).rejects.toThrow('无效')
    expect(post).not.toHaveBeenCalled()
  })

  it('requests the logical page through the current parent channel and waits for its result', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    stop = onDocument(() => {})
    send()
    const promise = openPage(uri, '主题/设计')
    const message = post.mock.calls.at(-1)![0]
    expect(message).toMatchObject({ type: 'file_view.open_page', requestId: 7, target: '主题/设计' })
    expect(post.mock.calls.at(-1)![1]).toBe('tauri://localhost')
    send({ ...message, type: 'file_view.page_result', ok: true })
    await expect(promise).resolves.toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })

  it('ignores forged or stale results and surfaces host navigation errors', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    stop = onDocument(() => {})
    send()
    const promise = openPage(uri, '设计')
    const outcome = expect(promise).rejects.toThrow('blocked')
    const response = { ...post.mock.calls.at(-1)![0], type: 'file_view.page_result', ok: false, error: 'blocked' }
    send(response, 'https://evil.test')
    send({ ...response, requestId: 6 })
    send(response, 'tauri://localhost', {} as Window)
    send(response)
    await outcome
  })

  it('cancels requests on a changed snapshot and rejects calls from an old document', async () => {
    vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    stop = onDocument(() => {})
    send()
    const old = expect(openPage(uri, '设计')).rejects.toThrow('切换')
    send({ requestId: 8, uri: '/vault/other.index.md' })
    await old
    await expect(openPage(uri, '设计')).rejects.toThrow('尚未就绪')
  })

  it('times out without inventing a file path or writing to the Vault', async () => {
    vi.useFakeTimers()
    vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    stop = onDocument(() => {})
    send()
    const result = expect(openPage(uri, '设计')).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(30_000)
    await result
    expect(request).not.toHaveBeenCalled()
  })
})

describe('file view handshake', () => {
  it('acknowledges a supported file without reading or writing Vault contents', () => {
    const render = vi.fn()
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    stop = onDocument(render)
    send()
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ uri, rows: [expect.objectContaining({ title: 'Book' })] }))
    expect(post).toHaveBeenCalledWith({ type: 'file_view.ready', requestId: 7 }, 'tauri://localhost')
    expect(request).not.toHaveBeenCalled()
  })
  it('requests Markdown fallback on invalid documents or consumer failure', () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    stop = onDocument(() => { throw new Error('cannot render') })
    send({ content: '# Plain markdown' })
    expect(post).toHaveBeenLastCalledWith({ type: 'file_view.fallback', requestId: 7 }, 'tauri://localhost')
    send({ requestId: 8 })
    expect(post).toHaveBeenLastCalledWith({ type: 'file_view.fallback', requestId: 8 }, 'tauri://localhost')
  })
  it('ignores forged origins, frames and malformed envelopes, and unsubscribes', () => {
    const render = vi.fn()
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    stop = onDocument(render)
    send({}, 'https://evil.test')
    send({}, 'http://localhost.evil.test:1420')
    send({}, 'tauri://localhost', {} as Window)
    for (const value of [{ viewId: 'timeline' }, { requestId: '7' }, { uri: null }, { content: null }]) send(value)
    expect(render).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
    expect(isHostOrigin('http://localhost:1420')).toBe(true)
    stop(); stop = undefined; send()
    expect(render).not.toHaveBeenCalled()
  })
})

describe('Vault files and covers', () => {
  it('resolves relative files, encoded names, fragments and nested index locations', async () => {
    expect(sourcePath(uri, '../books/A%20B.md#chapter', '/vault')).toBe('books/A B.md')
    expect(sourcePath('/vault/合集/reading#index.index.md', '../books/a%23b.md', '/vault')).toBe('books/a#b.md')
    expect(sourcePath('C:\\vault\\indexes\\a.index.md', '../books/a.md', 'C:\\vault')).toBe('books/a.md')
    request.mockResolvedValue({ root: '/vault' })
    await openLink(uri, '../books/a.md')
    expect(request.mock.calls).toEqual([['host.vault.info'], ['host.editor.open', { path: 'books/a.md' }]])
  })
  it.each(['../../outside.md', '../%2e%2e/outside.md', '../%2e%2e%2foutside.md', '../..%5coutside.md', 'javascript:alert(1)', 'https://example.test/a.md', 'file:///vault/a.md', '//example.test/a', '/vault/a.md', '#part', 'a.md?download=1', '../books/%00bad.md', '%ZZ.md'])('rejects unsafe or non-file link %s', (target) => {
    expect(() => sourcePath(uri, target, '/vault')).toThrow()
  })
  it('rejects an index outside the Vault and reports open failures', async () => {
    expect(() => sourcePath('/vault-other/a.index.md', 'a.md', '/vault')).toThrow()
    request.mockResolvedValueOnce({ root: null })
    await expect(openLink(uri, 'a.md')).rejects.toThrow('知识库')
    request.mockResolvedValueOnce({ root: '/vault' }).mockRejectedValueOnce(new Error('file missing'))
    await expect(openLink(uri, 'a.md')).rejects.toThrow('file missing')
  })
  it('loads local image bytes through the bridge and returns an owned Blob URL', async () => {
    const create = vi.fn(() => 'blob:cover')
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create })
    request.mockResolvedValueOnce({ root: '/vault' }).mockResolvedValueOnce({ base64: btoa('image bytes') })
    await expect(loadCover(uri, '../covers/book.png')).resolves.toBe('blob:cover')
    expect(request.mock.calls).toEqual([['host.vault.info'], ['host.vault.read_bytes', { path: 'covers/book.png' }]])
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/png', size: 11 }))
  })
  it('does not read unsupported images or remote covers and propagates read errors', async () => {
    request.mockResolvedValue({ root: '/vault' })
    await expect(loadCover(uri, '../covers/book.svg')).rejects.toThrow('PNG')
    await expect(loadCover(uri, 'https://example.test/book.png')).rejects.toThrow('知识库')
    expect(request.mock.calls.every(([method]) => method === 'host.vault.info')).toBe(true)
    request.mockResolvedValueOnce({ root: '/vault' }).mockRejectedValueOnce(new Error('missing cover'))
    await expect(loadCover(uri, 'book.png')).rejects.toThrow('missing cover')
  })
})
