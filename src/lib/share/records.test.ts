import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../settings.svelte', () => {
  let bag: Record<string, unknown> = {}
  return {
    getPluginScopedKey: (k: string) => bag[k],
    mergePluginScoped: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(bag, patch)
    }),
    _bag: () => bag,
    _resetBag: () => { bag = {} },
  }
})

import { getRecord, putRecord, deleteRecord } from './records'
import * as settings from '../settings.svelte'
import type { HtmlShareRecord } from './types'

describe('share records', () => {
  beforeEach(() => (settings as any)._resetBag())

  it('returns undefined when no record', () => {
    expect(getRecord('/foo.md')).toBeUndefined()
  })

  it('roundtrips html record', async () => {
    await putRecord('/foo.md', {
      slug: 'a-b', edit_token: 't', url: 'https://w/a-b',
      created_at: '2026-05-09T00:00:00Z', expires_at: null, filename: 'foo.md',
    })
    const r = getRecord('/foo.md')
    expect((r as HtmlShareRecord | undefined)?.slug).toBe('a-b')
  })

  it('deletes record by path', async () => {
    await putRecord('/foo.md', {
      slug: 'a', edit_token: 't', url: 'u',
      created_at: 'x', expires_at: null, filename: 'foo.md',
    })
    await deleteRecord('/foo.md')
    expect(getRecord('/foo.md')).toBeUndefined()
  })

  it('preserves other path records on delete', async () => {
    await putRecord('/a.md', { slug: 'a', edit_token: 't', url: 'u', created_at: 'x', expires_at: null, filename: 'a.md' })
    await putRecord('/b.md', { slug: 'b', edit_token: 't', url: 'u', created_at: 'x', expires_at: null, filename: 'b.md' })
    await deleteRecord('/a.md')
    expect((getRecord('/b.md') as HtmlShareRecord | undefined)?.slug).toBe('b')
  })
})
