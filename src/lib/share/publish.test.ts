import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./client', () => ({
  post: vi.fn(),
}))
vi.mock('./records', () => {
  let bag: Record<string, any> = {}
  return {
    getRecord: (p: string) => bag[p],
    putRecord: vi.fn(async (p: string, r: any) => { bag[p] = r }),
    _reset: () => { bag = {} },
  }
})
vi.mock('./slug', () => ({
  generateSlug: vi.fn(() => '2026-05-09-foo-XYZ'),
}))

import { publishHtml, vaultRelativeSrc } from './publish'
import { post } from './client'
import * as records from './records'
import type { HtmlShareRecord } from './types'

describe('publishHtml', () => {
  beforeEach(() => {
    ;(records as any)._reset()
    vi.clearAllMocks()
  })

  it('posts html with new slug + edit_token; writes record on 200', async () => {
    ;(post as any).mockResolvedValue({})
    const r = await publishHtml({
      path: '/vault/notes/foo.md', filename: 'foo.md', html: '<p>hi</p>',
      baseUrl: 'https://w', defaultExpiry: 'never', slugRandomSuffix: true,
      src: 'notes/foo.md',
    })
    expect((post as any).mock.calls[0][0]).toBe('/publish')
    const body = (post as any).mock.calls[0][1]
    expect(body.slug).toBe('2026-05-09-foo-XYZ')
    expect(body.edit_token).toMatch(/^[0-9a-f]{32}$/)
    expect(body.html).toBe('<p>hi</p>')
    expect(body.expires_in_seconds).toBeNull()
    expect(body.metadata.src).toBe('notes/foo.md')
    expect(r.url).toBe('https://w/2026-05-09-foo-XYZ')
    expect(r.isUpdate).toBe(false)
    expect((records.getRecord('/vault/notes/foo.md') as HtmlShareRecord | undefined)?.slug).toBe('2026-05-09-foo-XYZ')
  })

  it('reuses slug + edit_token from existing record (update flow)', async () => {
    await (records as any).putRecord('/foo.md', {
      slug: 'old-slug', edit_token: 'oldtok',
      url: 'https://w/old-slug', created_at: 't', expires_at: null, filename: 'foo.md',
    })
    ;(post as any).mockResolvedValue({})
    const r = await publishHtml({
      path: '/foo.md', filename: 'foo.md', html: '<p>v2</p>',
      baseUrl: 'https://w', defaultExpiry: 'never', slugRandomSuffix: true,
      src: '/foo.md',
    })
    expect((post as any).mock.calls[0][1].slug).toBe('old-slug')
    expect((post as any).mock.calls[0][1].edit_token).toBe('oldtok')
    expect(r.isUpdate).toBe(true)
  })

  it('maps expiry strings to seconds', async () => {
    ;(post as any).mockResolvedValue({})
    await publishHtml({
      path: '/foo.md', filename: 'foo.md', html: 'h',
      baseUrl: 'https://w', defaultExpiry: '7d', slugRandomSuffix: true,
      src: '/foo.md',
    })
    expect((post as any).mock.calls[0][1].expires_in_seconds).toBe(604800)
  })
})

describe('vaultRelativeSrc', () => {
  it('returns the path relative to the vault root when under it', () => {
    expect(vaultRelativeSrc('/vault/notes/foo.md', '/vault')).toBe('notes/foo.md')
    expect(vaultRelativeSrc('/vault/foo.md', '/vault/')).toBe('foo.md')
  })
  it('returns the absolute path when outside the vault (or no vault)', () => {
    expect(vaultRelativeSrc('/elsewhere/x.md', '/vault')).toBe('/elsewhere/x.md')
    expect(vaultRelativeSrc('/vault', '/vault')).toBe('/vault') // the root itself, not a child
    expect(vaultRelativeSrc('/any/x.md', null)).toBe('/any/x.md')
  })
})
