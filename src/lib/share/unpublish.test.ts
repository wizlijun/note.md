import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client', () => ({ del: vi.fn() }))
vi.mock('./records', () => {
  let bag: Record<string, any> = {}
  return {
    getRecord: (p: string) => bag[p],
    deleteRecord: vi.fn(async (p: string) => { delete bag[p] }),
    _put: (p: string, r: any) => { bag[p] = r },
    _reset: () => { bag = {} },
  }
})

import { unpublish } from './unpublish'
import { del } from './client'
import * as records from './records'
import { ShareError } from './types'

describe('unpublish', () => {
  beforeEach(() => {
    ;(records as any)._reset()
    vi.clearAllMocks()
  })

  it('throws corrupt_record when no record exists', async () => {
    await expect(unpublish({ path: '/foo.md', baseUrl: 'https://w' }))
      .rejects.toMatchObject({ kind: 'corrupt_record' })
  })

  it('html: DELETE /<slug> with edit_token; clears record', async () => {
    ;(records as any)._put('/foo.md', {
      slug: 's', edit_token: 'tok', url: 'u', created_at: 't', expires_at: null, filename: 'foo.md',
    })
    ;(del as any).mockResolvedValue({})
    await unpublish({ path: '/foo.md', baseUrl: 'https://w' })
    expect((del as any).mock.calls[0][0]).toBe('/s')
    expect((del as any).mock.calls[0][1]).toEqual({ edit_token: 'tok' })
    expect((records as any)._put).toBeDefined()
  })

  it('image: DELETE /f/<id>.<ext>', async () => {
    ;(records as any)._put('/foo.png', {
      kind: 'image', id: 'abc', ext: 'png', edit_token: 'tok',
      url: 'u', created_at: 't', expires_at: null, filename: 'foo.png', size_bytes: 100,
    })
    ;(del as any).mockResolvedValue({})
    await unpublish({ path: '/foo.png', baseUrl: 'https://w' })
    expect((del as any).mock.calls[0][0]).toBe('/f/abc.png')
  })

  it('clears local record on 404 from worker (idempotent)', async () => {
    ;(records as any)._put('/foo.md', {
      slug: 's', edit_token: 'tok', url: 'u', created_at: 't', expires_at: null, filename: 'foo.md',
    })
    ;(del as any).mockResolvedValue({ ok: true })
    await unpublish({ path: '/foo.md', baseUrl: 'https://w' })
    expect(records.deleteRecord).toHaveBeenCalledWith('/foo.md')
  })

  it('does not clear record on forbidden', async () => {
    ;(records as any)._put('/foo.md', {
      slug: 's', edit_token: 'tok', url: 'u', created_at: 't', expires_at: null, filename: 'foo.md',
    })
    ;(del as any).mockRejectedValue(new ShareError('forbidden'))
    await expect(unpublish({ path: '/foo.md', baseUrl: 'https://w' }))
      .rejects.toMatchObject({ kind: 'forbidden' })
    expect(records.deleteRecord).not.toHaveBeenCalled()
  })
})
