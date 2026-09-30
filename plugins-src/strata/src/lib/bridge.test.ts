// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { api } from './bridge'
afterEach(() => { delete window.notemd })
it('opens only the backend-validated path with the selected date scope', async () => {
  const request = vi.fn().mockResolvedValueOnce({ path: 'notes/source.md', lineStart: 12 }).mockResolvedValueOnce({})
  window.notemd = { request }
  await api.openSource('candidate:abc', { from: '2026-09-01', to: '2026-09-30' })
  expect(request.mock.calls).toEqual([
    ['plugin.open_source', { nodeId: 'candidate:abc', evidenceId: undefined, from: '2026-09-01', to: '2026-09-30' }],
    ['host.editor.open', { path: 'notes/source.md' }],
  ])
})
it('does not open a source after a stale or unapproved evidence rejection', async () => {
  const request = vi.fn().mockRejectedValue(new Error('SOURCE_CHANGED')); window.notemd = { request }
  await expect(api.openSource('node:1', { from: '2026-09-01', to: '2026-09-30' }, 'e:1')).rejects.toThrow('SOURCE_CHANGED')
  expect(request).toHaveBeenCalledTimes(1)
})
it('fails clearly outside the plugin host', async () => { await expect(api.snapshot({ from: '2026-09-01', to: '2026-09-30' })).rejects.toThrow('note.md') })
