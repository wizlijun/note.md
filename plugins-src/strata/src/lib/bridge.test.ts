// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { api } from './bridge'
import { buildAtlas } from './atlas'
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

it('saves compact geometry and restores it with current source data', async () => {
  const nodes = [{ id: 'a', title: 'Current title', features: ['topic'], sourceGroups: [{ groupId: 'source', groupVersion: 'v1', priority: 2, dates: ['2026-09-30'] }] }]
  const atlas = buildAtlas(nodes, 'epoch')
  // A large source payload must not become a layout request or consume its budget.
  atlas.nodes[0].sourceGroups[0].canonicalIds = ['x'.repeat(17 * 1024 * 1024)]
  const request = vi.fn().mockResolvedValue({ ok: true }); window.notemd = { request }
  await api.saveAtlas('vault', atlas)
  const [method, params] = request.mock.calls[0]
  expect(method).toBe('plugin.atlas.save')
  expect(JSON.stringify(params).length).toBeLessThan(4096)
  expect(params.atlas.nodes[0]).not.toHaveProperty('sourceGroups')
  expect(params.atlas.nodes[0]).not.toHaveProperty('title')
  expect(params.atlas.nodes[0]).not.toHaveProperty('features')
  const refreshed = buildAtlas([{ ...nodes[0], title: 'Updated title', sourceGroups: [] }], 'epoch', params.atlas)
  expect(refreshed.nodes[0].x).toBe(atlas.nodes[0].x)
  expect(refreshed.nodes[0].y).toBe(atlas.nodes[0].y)
  expect(refreshed.nodes[0].title).toBe('Updated title')
  expect(refreshed.nodes[0].sourceGroups).toEqual([])
})
