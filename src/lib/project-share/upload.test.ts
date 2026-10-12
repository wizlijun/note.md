// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadProjectArchive } from './upload'

let request: FakeRequest
class FakeRequest {
  upload: { onprogress?: (event: { loaded: number }) => void; onload?: () => void } = {}
  status = 200
  responseText = '{"stage":"ready"}'
  onload?: () => void
  onerror?: () => void
  onabort?: () => void
  ontimeout?: () => void
  open = vi.fn()
  setRequestHeader = vi.fn()
  send = vi.fn()
  constructor() { request = this }
}
beforeEach(() => vi.stubGlobal('XMLHttpRequest', FakeRequest))
afterEach(() => vi.unstubAllGlobals())
const headers = { Authorization: 'Bearer test-owner', 'Content-Type': 'application/zip', 'X-Publication-Id': 'p1' }
const archive = new Uint8Array([1, 2, 3, 4])

describe('project archive upload', () => {
  it('reports request-body bytes and waits for the response after upload completion', async () => {
    const progress = vi.fn()
    const done = vi.fn()
    const result = uploadProjectArchive('https://share.test/archive', headers, archive, progress)
    void result.then(done)
    expect(request.open).toHaveBeenCalledWith('POST', 'https://share.test/archive')
    for (const [name, value] of Object.entries(headers)) expect(request.setRequestHeader).toHaveBeenCalledWith(name, value)
    expect(request.send).toHaveBeenCalledWith(archive)
    expect(progress).toHaveBeenLastCalledWith({ phase: 'uploading', loaded: 0, total: 4 })
    request.upload.onprogress?.({ loaded: 2 })
    expect(progress).toHaveBeenLastCalledWith({ phase: 'uploading', loaded: 2, total: 4 })
    request.upload.onload?.()
    expect(progress).toHaveBeenLastCalledWith({ phase: 'processing' })
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    request.onload?.()
    expect(await (await result).json()).toEqual({ stage: 'ready' })
  })

  it.each(['onerror', 'onabort', 'ontimeout'] as const)('rejects %s without retrying or claiming completion', async event => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const result = uploadProjectArchive('https://share.test/archive', headers, archive, vi.fn())
    const rejected = expect(result).rejects.toThrow()
    request[event]?.()
    await rejected
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves HTTP error status and body for the existing pending-package error handling', async () => {
    const result = uploadProjectArchive('https://share.test/archive', headers, archive, vi.fn())
    request.status = 409; request.responseText = 'generation changed'; request.onload?.()
    const response = await result
    expect(response.ok).toBe(false)
    expect(response.status).toBe(409)
    expect(await response.text()).toBe('generation changed')
  })

  it('keeps the existing fetch path when no progress observer is requested', async () => {
    const response = Response.json({ stage: 'ready' })
    const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch', fetch)
    expect(await uploadProjectArchive('https://share.test/archive', headers, archive)).toBe(response)
    expect(fetch).toHaveBeenCalledWith('https://share.test/archive', { method: 'POST', headers, body: archive })
  })
})
