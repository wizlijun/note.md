import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_START_TIME, isHostOrigin, loadSettings, normalizeStartTime, onDocument, openLink, openTimelineDate, saveSettings, sourcePath, startTimeMinute, vaultRelativePath } from './bridge'
import { DEFAULT_RULES } from './classification'

const request = vi.fn()
let stop: (() => void) | undefined
const content = '---\ntype: Timeline\n---\n- 09:00–10:00 — 开发：构建页面。'
function send(data: Record<string, unknown>, origin = 'tauri://localhost', source: MessageEventSource = window) {
  window.dispatchEvent(new MessageEvent('message', { origin, source, data: { type: 'file_view.open', viewId: 'timeline', requestId: 3, uri: '/vault/diary/day.md', content, ...data } }))
}
beforeEach(() => {
  request.mockReset()
  Object.assign(window, { notemd: { locale: 'zh', theme: 'light', request } })
})
afterEach(() => { stop?.(); stop = undefined; vi.restoreAllMocks() })

describe('document handshake', () => {
  it('renders valid input and acknowledges the exact request', () => {
    const render = vi.fn(), post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    stop = onDocument(render)
    send({})
    expect(render).toHaveBeenCalledOnce()
    expect(post).toHaveBeenLastCalledWith({ type: 'file_view.ready', requestId: 3 }, 'tauri://localhost')
    expect(request).not.toHaveBeenCalled()
  })
  it('falls back on malformed content or rendering failure', () => {
    const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    stop = onDocument(() => { throw new Error('render failed') })
    send({ content: 'broken' })
    expect(post).toHaveBeenLastCalledWith({ type: 'file_view.fallback', requestId: 3 }, 'tauri://localhost')
    send({ requestId: 4 })
    expect(post).toHaveBeenLastCalledWith({ type: 'file_view.fallback', requestId: 4 }, 'tauri://localhost')
  })
  it('rejects foreign origins, other frames and malformed envelopes', () => {
    const render = vi.fn(), post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    stop = onDocument(render)
    send({}, 'https://attacker.example')
    send({}, 'tauri://localhost', {} as Window)
    for (const data of [{ requestId: '3' }, { viewId: 'wrong' }, { uri: null }]) send(data)
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
  it('opens an existing timeline in the corresponding archive year without writing files', async () => {
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    stop = onDocument(() => {})
    send({ uri: '/vault/diary/2026/2026-12-31.timeline.md' })
    request.mockImplementation(async (method) => method === 'host.vault.info' ? { root: '/vault' } : method === 'host.vault.exists' ? { exists: true } : {})
    await openTimelineDate('2027-01-01')
    expect(request.mock.calls).toEqual([
      ['host.vault.info'],
      ['host.vault.exists', { path: 'diary/2027/2027-01-01.timeline.md' }],
      ['host.editor.open', { path: 'diary/2027/2027-01-01.timeline.md', fileView: 'timeline', replaceCurrent: true, currentPath: 'diary/2026/2026-12-31.timeline.md' }],
    ])
  })

  it('does not open or create a missing date and rejects unsupported filenames', async () => {
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    stop = onDocument(() => {})
    send({ uri: '/vault/diary/2026-09-09.timeline.md' })
    request.mockImplementation(async (method) => method === 'host.vault.info' ? { root: '/vault' } : { exists: false })
    await expect(openTimelineDate('2026-09-10')).rejects.toThrow('2026-09-10 暂无时间线')
    expect(request.mock.calls.map(([method]) => method)).toEqual(['host.vault.info', 'host.vault.exists'])
    request.mockClear()
    send({ uri: '/vault/diary/undated.md' })
    await expect(openTimelineDate('2026-09-10')).rejects.toThrow('YYYY-MM-DD.timeline.md')
    expect(request).not.toHaveBeenCalled()
  })

  it('loads legacy rules with the default opening time and persists one atomic configuration', async () => {
    request.mockResolvedValue({ settings: {} })
    expect(await loadSettings()).toEqual({ classification: DEFAULT_RULES, startTime: DEFAULT_START_TIME })
    request.mockResolvedValue({ settings: { classification: [] } })
    expect(await loadSettings()).toEqual({ classification: [], startTime: '09:00' })
    request.mockResolvedValue({ settings: { timeline: { classification: DEFAULT_RULES, startTime: '13:45' }, classification: [{ bad: true }] } })
    expect(await loadSettings()).toEqual({ classification: DEFAULT_RULES, startTime: '13:45' })
    request.mockRejectedValue(new Error('disk full'))
    await expect(saveSettings({ classification: DEFAULT_RULES, startTime: '13:45' })).rejects.toThrow('disk full')
    expect(request).toHaveBeenLastCalledWith('host.settings.set', { key: 'timeline', value: { classification: DEFAULT_RULES, startTime: '13:45' } })
    await expect(loadSettings()).rejects.toThrow('disk full')
  })
  it('strictly validates opening times and rejects corrupt persisted settings', async () => {
    expect(normalizeStartTime('09:00')).toBe('09:00')
    expect(startTimeMinute('23:59')).toBe(1439)
    for (const value of ['9:00', '09:0', '24:00', '12:60', ' 09:00 ', '', null]) expect(normalizeStartTime(value)).toBeNull()
    await expect(saveSettings({ classification: DEFAULT_RULES, startTime: '9:00' })).rejects.toThrow('HH:mm')
    request.mockResolvedValue({ settings: { timeline: { classification: DEFAULT_RULES, startTime: '24:00' } } })
    await expect(loadSettings()).rejects.toThrow('时间线设置格式无效')
  })
  it('resolves encoded relative sources inside the Vault and rejects escapes/schemes', async () => {
    expect(sourcePath('/vault/diary/day.md', '../meetings/a%20b.md#line10', '/vault')).toBe('meetings/a b.md')
    expect(sourcePath('C:\\vault\\diary\\day.md', '../source.md#L10', 'C:\\vault')).toBe('source.md')
    expect(sourcePath('/vault/diary/a#b.md', '../source.md', '/vault')).toBe('source.md')
    expect(vaultRelativePath('/vault/diary/day.md', '/vault')).toBe('diary/day.md')
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
