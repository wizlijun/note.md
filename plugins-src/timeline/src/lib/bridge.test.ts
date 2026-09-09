import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editMarkdown, isHostOrigin, loadRules, onDocument, openLink, saveRules, sourcePath } from './bridge'
import { DEFAULT_RULES } from './classification'

const request = vi.fn()
let stop: (() => void) | undefined
const content = '---\ntype: Timeline\n---\n- 09:00–10:00 — 开发：构建页面。'
function send(data: Record<string, unknown>, origin = 'tauri://localhost', source: MessageEventSource = window) {
  window.dispatchEvent(new MessageEvent('message', { origin, source, data: { type: 'custom_editor.open', editorId: 'timeline', requestId: 3, uri: '/vault/diary/day.md', content, ...data } }))
}
beforeEach(() => {
  request.mockReset()
  Object.assign(window, { notemd: { locale: 'zh', theme: 'light', request } })
})
afterEach(() => { stop?.(); stop = undefined; vi.restoreAllMocks() })

describe('document handshake', () => {
  it('renders valid input and acknowledges the exact request, edits only request Markdown', () => {
    const render = vi.fn(), post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    stop = onDocument(render)
    send({})
    expect(render).toHaveBeenCalledOnce()
    expect(post).toHaveBeenLastCalledWith({ type: 'custom_editor.ready', requestId: 3 }, 'tauri://localhost')
    editMarkdown()
    expect(post).toHaveBeenLastCalledWith({ type: 'custom_editor.fallback', requestId: 3, reason: 'edit' }, 'tauri://localhost')
    expect(request).not.toHaveBeenCalled()
  })
  it('falls back on malformed content or rendering failure', () => {
    const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    stop = onDocument(() => { throw new Error('render failed') })
    send({ content: 'broken' })
    expect(post).toHaveBeenLastCalledWith({ type: 'custom_editor.fallback', requestId: 3 }, 'tauri://localhost')
    send({ requestId: 4 })
    expect(post).toHaveBeenLastCalledWith({ type: 'custom_editor.fallback', requestId: 4 }, 'tauri://localhost')
  })
  it('rejects foreign origins, other frames and malformed envelopes', () => {
    const render = vi.fn(), post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    stop = onDocument(render)
    send({}, 'https://attacker.example')
    send({}, 'tauri://localhost', {} as Window)
    for (const data of [{ requestId: '3' }, { editorId: 'wrong' }, { uri: null }]) send(data)
    expect(render).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
    expect(isHostOrigin('http://localhost.attacker.test:1420')).toBe(false)
    expect(isHostOrigin('http://localhost:1420')).toBe(true)
    stop(); stop = undefined
    send({})
    expect(render).not.toHaveBeenCalled()
  })
})

describe('settings and sources', () => {
  it('persists a single validated configuration and propagates read/write failures', async () => {
    request.mockResolvedValue({ settings: {} })
    expect(await loadRules()).toEqual(DEFAULT_RULES)
    request.mockResolvedValue({ settings: { classification: [] } })
    expect(await loadRules()).toEqual([])
    request.mockRejectedValue(new Error('disk full'))
    await expect(saveRules(DEFAULT_RULES)).rejects.toThrow('disk full')
    expect(request).toHaveBeenLastCalledWith('host.settings.set', { key: 'classification', value: DEFAULT_RULES })
    await expect(loadRules()).rejects.toThrow('disk full')
  })
  it('resolves encoded relative sources inside the Vault and rejects escapes/schemes', async () => {
    expect(sourcePath('/vault/diary/day.md', '../meetings/a%20b.md#line10', '/vault')).toBe('meetings/a b.md')
    expect(sourcePath('C:\\vault\\diary\\day.md', '../source.md#L10', 'C:\\vault')).toBe('source.md')
    expect(sourcePath('/vault/diary/a#b.md', '../source.md', '/vault')).toBe('source.md')
    for (const target of ['../../outside.md', '../%2e%2e/outside.md', 'javascript:alert(1)', 'https://example.com', '//host/a.md']) {
      expect(() => sourcePath('/vault/diary/day.md', target, '/vault')).toThrow()
    }
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    stop = onDocument(() => {})
    send({})
    request.mockResolvedValue({ root: '/vault' })
    await openLink('../meetings/a.md#line20')
    expect(request).toHaveBeenLastCalledWith('host.editor.open', { path: 'meetings/a.md' })
  })
})
