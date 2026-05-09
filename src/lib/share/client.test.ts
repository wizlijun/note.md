import { describe, it, expect, beforeEach, vi } from 'vitest'
import { post, del, _setSettingsForTests } from './client'
import { ShareError } from './types'

const setCfg = (patch: Partial<{ baseUrl: string; apiKey: string }>) =>
  _setSettingsForTests({
    baseUrl: 'https://w.example.com',
    apiKey: 'k',
    ...patch,
  })

const mockFetch = (init: { status: number; body?: any; throws?: boolean }) => {
  global.fetch = vi.fn().mockImplementation(async () => {
    if (init.throws) throw new Error('boom')
    return {
      ok: init.status >= 200 && init.status < 300,
      status: init.status,
      statusText: 'STATUS',
      json: async () => init.body ?? {},
    } as any
  })
}

describe('client', () => {
  beforeEach(() => setCfg({}))

  it('throws not_configured when baseUrl missing', async () => {
    _setSettingsForTests({})
    await expect(post('/publish', {})).rejects.toMatchObject({ kind: 'not_configured' })
  })

  it('throws not_configured when apiKey missing', async () => {
    _setSettingsForTests({ baseUrl: 'https://w' })
    await expect(post('/publish', {})).rejects.toMatchObject({ kind: 'not_configured' })
  })

  it('throws network on fetch failure', async () => {
    mockFetch({ status: 0, throws: true })
    await expect(post('/publish', {})).rejects.toMatchObject({ kind: 'network' })
  })

  it('throws auth on 401', async () => {
    mockFetch({ status: 401 })
    await expect(post('/publish', {})).rejects.toMatchObject({ kind: 'auth' })
  })

  it('throws too_large on 413', async () => {
    mockFetch({ status: 413 })
    await expect(post('/publish', {})).rejects.toMatchObject({ kind: 'too_large' })
  })

  it('throws server on 503', async () => {
    mockFetch({ status: 503 })
    await expect(post('/publish', {})).rejects.toMatchObject({ kind: 'server' })
  })

  it('returns parsed json on 200', async () => {
    mockFetch({ status: 200, body: { ok: true } })
    expect(await post('/publish', { x: 1 })).toEqual({ ok: true })
  })

  it('strips trailing slash from baseUrl', async () => {
    _setSettingsForTests({ baseUrl: 'https://w.example.com/', apiKey: 'k' })
    mockFetch({ status: 200 })
    await post('/publish', {})
    const call = (global.fetch as any).mock.calls[0]
    expect(call[0]).toBe('https://w.example.com/publish')
  })

  it('sends Authorization Bearer header', async () => {
    mockFetch({ status: 200 })
    await post('/publish', {})
    const call = (global.fetch as any).mock.calls[0]
    expect(call[1].headers.authorization).toBe('Bearer k')
  })

  it('del passes body for DELETE', async () => {
    mockFetch({ status: 200 })
    await del('/abc-123', { edit_token: 'tok' })
    const call = (global.fetch as any).mock.calls[0]
    expect(call[1].method).toBe('DELETE')
    expect(JSON.parse(call[1].body)).toEqual({ edit_token: 'tok' })
  })

  it('del treats 404 as success (idempotent unshare)', async () => {
    mockFetch({ status: 404 })
    expect(await del('/x', { edit_token: 't' })).toBeTruthy()
  })

  it('del throws forbidden on 403', async () => {
    mockFetch({ status: 403 })
    await expect(del('/x', { edit_token: 't' })).rejects.toMatchObject({ kind: 'forbidden' })
  })
})
