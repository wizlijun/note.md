import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chooseJsonFile, copyText, isHostOrigin, onFileViewOpen,
  openEditor, readDialogText, settingsGet, settingsSet, vaultList, vaultRead,
} from './bridge'

const request = vi.fn()
let stop: (() => void) | undefined

function send(overrides: Record<string, unknown> = {}, origin = 'tauri://localhost', source: MessageEventSource = window) {
  window.dispatchEvent(new MessageEvent('message', { origin, source, data: {
    type: 'file_view.open', viewId: 'knowledge', requestId: 7,
    uri: '/vault/research/demo.knowledge.json', content: '{"schema":"knowledge-representation-dataset/3.0.0"}',
    ...overrides,
  } }))
}

beforeEach(() => {
  request.mockReset()
  Object.assign(window, { notemd: { pluginId: 'notemd.knowledge-browser', locale: 'zh', theme: 'system', request } })
})
afterEach(() => { stop?.(); stop = undefined; vi.restoreAllMocks() })

describe('file-view bridge', () => {
  it('accepts only the exact host parent envelope and acknowledges completed validation', async () => {
    const consume = vi.fn(async () => true)
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    stop = onFileViewOpen(consume)
    send({}, 'https://evil.test')
    send({}, 'tauri://localhost', {} as Window)
    send({ viewId: 'other' })
    send()
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'file_view.ready', requestId: 7 }, 'tauri://localhost'))
    expect(consume).toHaveBeenCalledTimes(1)
    expect(isHostOrigin('http://127.0.0.1:1420')).toBe(true)
    expect(isHostOrigin('http://localhost.evil.test')).toBe(false)
  })

  it('falls back for unsupported input or consumer failure', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    stop = onFileViewOpen(async snapshot => snapshot.requestId !== 7)
    send()
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'file_view.fallback', requestId: 7 }, 'tauri://localhost'))
    stop(); stop = undefined
    post.mockClear()
    stop = onFileViewOpen(async () => { throw new Error('invalid') })
    send({ requestId: 8 })
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'file_view.fallback', requestId: 8 }, 'tauri://localhost'))
  })

  it('aborts stale work and never acknowledges its result', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    const releases: Array<() => void> = []
    const signals: AbortSignal[] = []
    stop = onFileViewOpen((_snapshot, signal) => {
      signals.push(signal)
      return new Promise<void>(resolve => releases.push(resolve))
    })
    send({ requestId: 1 })
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    send({ requestId: 2 })
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[0].aborted).toBe(true)
    releases[0]()
    releases[1]()
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post).toHaveBeenCalledWith({ type: 'file_view.ready', requestId: 2 }, 'tauri://localhost')
  })

})

describe('host RPC wrappers', () => {
  it('uses the declared Vault, editor, dialog, clipboard and settings methods', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'host.vault.list') return { entries: [{ name: 'a.json', is_dir: false }] }
      if (method === 'host.vault.read') return { content: '{}' }
      if (method === 'host.dialog.open') return { paths: ['/tmp/a.json'] }
      if (method === 'host.fs.read_text') return { content: '{"a":1}' }
      if (method === 'host.settings.get') return { settings: { preferences: { schemaVersion: 1 } } }
      return { ok: true }
    })
    await expect(vaultList('research')).resolves.toEqual([{ name: 'a.json', is_dir: false }])
    await expect(vaultRead('research/a.json')).resolves.toBe('{}')
    await expect(chooseJsonFile()).resolves.toBe('/tmp/a.json')
    await expect(readDialogText('/tmp/a.json')).resolves.toBe('{"a":1}')
    await openEditor('research/a.json', 'knowledge')
    await copyText('ref')
    await expect(settingsGet()).resolves.toHaveProperty('preferences.schemaVersion', 1)
    await settingsSet('preferences', { schemaVersion: 1 })
    expect(request).toHaveBeenCalledWith('host.editor.open', { path: 'research/a.json', fileView: 'knowledge' })
    expect(request).toHaveBeenCalledWith('host.clipboard.write', { text: 'ref' })
    expect(request).toHaveBeenCalledWith('host.settings.set', { key: 'preferences', value: { schemaVersion: 1 } })
  })
})
