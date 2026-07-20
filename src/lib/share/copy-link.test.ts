import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn(),
}))
vi.mock('./records', () => {
  let bag: Record<string, any> = {}
  return {
    getRecord: (p: string) => bag[p],
    _put: (p: string, r: any) => { bag[p] = r },
    _reset: () => { bag = {} },
  }
})

import { copyShareLink } from './copy-link'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import * as records from './records'

describe('copyShareLink', () => {
  beforeEach(() => {
    ;(records as any)._reset()
    vi.clearAllMocks()
  })

  it('throws corrupt_record when no record', async () => {
    await expect(copyShareLink('/x.md')).rejects.toMatchObject({ kind: 'corrupt_record' })
  })

  it('writes record url to clipboard and returns it', async () => {
    ;(records as any)._put('/x.md', {
      slug: 's', edit_token: 't', url: 'https://w/s',
      created_at: 't', expires_at: null, filename: 'x.md',
    })
    const url = await copyShareLink('/x.md')
    expect(url).toBe('https://w/s')
    expect(writeText).toHaveBeenCalledWith('https://w/s')
  })

  it('skips the clipboard when opts.clipboard is false, still returns the url', async () => {
    ;(records as any)._put('/x.md', {
      slug: 's', edit_token: 't', url: 'https://w/s',
      created_at: 't', expires_at: null, filename: 'x.md',
    })
    const url = await copyShareLink('/x.md', { clipboard: false })
    expect(url).toBe('https://w/s')
    expect(writeText).not.toHaveBeenCalled()
  })
})
