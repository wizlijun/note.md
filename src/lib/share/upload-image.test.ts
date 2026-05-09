import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client', () => ({ postBytes: vi.fn(), del: vi.fn() }))
vi.mock('./records', () => {
  let bag: Record<string, any> = {}
  return {
    getRecord: (p: string) => bag[p],
    putRecord: vi.fn(async (p: string, r: any) => { bag[p] = r }),
    _put: (p: string, r: any) => { bag[p] = r },
    _reset: () => { bag = {} },
  }
})
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
}))

import { uploadImage } from './upload-image'
import { postBytes, del } from './client'
import * as records from './records'
import { ShareError } from './types'

describe('uploadImage', () => {
  beforeEach(() => {
    ;(records as any)._reset()
    vi.clearAllMocks()
  })

  it('rejects unsupported extension', async () => {
    await expect(uploadImage({ path: '/x.bin', filename: 'x.bin', baseUrl: 'https://w', defaultExpiry: 'never' }))
      .rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('posts bytes with mime + edit_token + filename headers; writes record', async () => {
    ;(postBytes as any).mockResolvedValue({
      id: 'abc', ext: 'png', url: 'https://w/f/abc.png', expires_at: null, size_bytes: 4,
    })
    const r = await uploadImage({
      path: '/foo.png', filename: 'foo.png',
      baseUrl: 'https://w', defaultExpiry: 'never',
    })
    expect(r.url).toBe('https://w/f/abc.png')
    const [path, , mime, headers] = (postBytes as any).mock.calls[0]
    expect(path).toBe('/upload')
    expect(mime).toBe('image/png')
    expect(headers['X-Filename']).toBe('foo.png')
    expect(headers['X-Edit-Token']).toMatch(/^[0-9a-f]{32}$/)
    expect(records.getRecord('/foo.png')?.id).toBe('abc')
  })

  it('deletes prior image best-effort on update', async () => {
    ;(records as any)._put('/foo.png', {
      kind: 'image', id: 'OLD', ext: 'png', edit_token: 'oldtok',
      url: 'u', created_at: 't', expires_at: null, filename: 'foo.png', size_bytes: 1,
    })
    ;(postBytes as any).mockResolvedValue({
      id: 'NEW', ext: 'png', url: 'https://w/f/NEW.png', expires_at: null, size_bytes: 4,
    })
    ;(del as any).mockResolvedValue({})
    await uploadImage({ path: '/foo.png', filename: 'foo.png', baseUrl: 'https://w', defaultExpiry: 'never' })
    expect((del as any).mock.calls[0][0]).toBe('/f/OLD.png')
  })

  it('swallows delete errors of prior image', async () => {
    ;(records as any)._put('/foo.png', {
      kind: 'image', id: 'OLD', ext: 'png', edit_token: 'oldtok',
      url: 'u', created_at: 't', expires_at: null, filename: 'foo.png', size_bytes: 1,
    })
    ;(postBytes as any).mockResolvedValue({
      id: 'NEW', ext: 'png', url: 'https://w/f/NEW.png', expires_at: null, size_bytes: 4,
    })
    ;(del as any).mockRejectedValue(new ShareError('network'))
    const r = await uploadImage({ path: '/foo.png', filename: 'foo.png', baseUrl: 'https://w', defaultExpiry: 'never' })
    expect(r.url).toContain('NEW.png')
  })
})
