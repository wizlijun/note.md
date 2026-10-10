import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo, ProjectSnapshot } from './types'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), fetch: vi.fn(), save: vi.fn(), data: {} as Record<string, any>, events: [] as string[], baseUrl: 'https://share.test' }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => ({
  get: async (key: string) => structuredClone(mocks.data[key]),
  set: async (key: string, value: any) => { mocks.data[key] = structuredClone(value) },
  save: async () => { mocks.events.push('persist'); await mocks.save() },
}) } }))
vi.mock('../settings.svelte', () => ({ getPluginScopedKey: (key: string) => ({ 'share.baseUrl': mocks.baseUrl, 'share.apiKey': 'owner', 'share.defaultExpiry': '7d' })[key] }))
vi.mock('./bundle', () => ({ buildProjectBundle: () => '<html>frozen bundle</html>' }))
import { publishProject, projectIdentities, pullProjectFeedback, stopProjectShare } from './host'

const info: ProjectInfo = { project_id: 'project_1', sourceRoot: '/project', mirrorRoot: '/vault/sync/project_1', entry: 'README.md', files: [] }
const file = { path: 'README.md', hash: 'a'.repeat(64), bytes: 5, markdown: 'hello' }
const snapshot: ProjectSnapshot = { schemaVersion: 1, project_id: info.project_id, snapshotId: 'snapshot_1', entry: info.entry, files: [file] }

beforeEach(() => {
  mocks.data = {}; mocks.events = []; mocks.invoke.mockReset(); mocks.fetch.mockReset(); mocks.save.mockReset()
  mocks.baseUrl = 'https://share.test'
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.invoke.mockImplementation(async (_command: string, { request }: any) => {
    if (request.op === 'snapshot') return snapshot
    if (request.op === 'bundle-get') return '<html>frozen bundle</html>'
    if (request.op === 'published') return { ...info, url: request.url, publishedSnapshotId: request.snapshotId }
    if (request.op === 'inbox') return []
    return null
  })
})

describe('host project share', () => {
  it('never sends a different service API key to the previously bound service', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({}))
    await publishProject(info, [file])
    mocks.fetch.mockClear(); mocks.baseUrl = 'https://another-service.test'
    await expect(pullProjectFeedback(info.project_id)).rejects.toThrow('另一个分享服务')
    await expect(stopProjectShare(info.project_id)).rejects.toThrow('另一个分享服务')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('persists identity and frozen snapshot before upload, then retries unknown results with the same body', async () => {
    const bodies: string[] = []
    mocks.fetch.mockImplementation(async (_url, init) => {
      mocks.events.push('upload'); bodies.push(init.body)
      if (bodies.length === 1) throw new Error('connection lost after upload')
      return Response.json({ expires_at: '2026-11-01T00:00:00Z' })
    })
    await expect(publishProject(info, [file])).rejects.toThrow('connection lost')
    const identity = (await projectIdentities())[info.project_id]
    expect(identity.slug).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/)
    expect(identity.pending?.snapshotId).toBe(snapshot.snapshotId)
    expect(mocks.events.indexOf('persist')).toBeLessThan(mocks.events.indexOf('upload'))
    const result = await publishProject(info, [])
    expect(bodies[1]).toBe(bodies[0])
    expect(result.identity.pending).toBeUndefined()
    expect(result.identity.url).toContain(identity.slug)
    expect(mocks.invoke.mock.calls.filter(([, input]) => input.request.op === 'snapshot')).toHaveLength(1)
    expect(bodies[0]).not.toContain('/project')
  })
  it('never uploads if identity cannot be saved', async () => {
    mocks.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(publishProject(info, [file])).rejects.toThrow('disk full')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('lists IDs and downloads unseen feedback sequentially, preserving local decisions', async () => {
    const existing = { envelope: { payload: { submissionId: 'old' } }, status: 'accepted' }
    mocks.invoke.mockImplementation(async (_command: string, { request }: any) => request.op === 'inbox' ? [existing] : null)
    const urls: string[] = []
    mocks.fetch.mockImplementation(async url => {
      urls.push(String(url))
      if (String(url).includes('?')) return Response.json({ items: [{ submissionId: 'old' }, { submissionId: 'new' }] })
      return Response.json({ payload: { project_id: info.project_id, submissionId: 'new' } })
    })
    await pullProjectFeedback(info.project_id)
    expect(urls).toHaveLength(2)
    expect(urls[1]).toMatch(/\/project_1\/new$/)
    expect(mocks.invoke.mock.calls.filter(([, input]) => input.request.op === 'feedback')).toHaveLength(1)
    expect(mocks.invoke.mock.calls.find(([, input]) => input.request.op === 'feedback')?.[1].request.envelope.payload.submissionId).toBe('new')
  })
  it('keeps local state when stop is unknown, and keeps credentials after confirmed stop', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({}))
    await publishProject(info, [file])
    const original = (await projectIdentities())[info.project_id]
    mocks.fetch.mockRejectedValueOnce(new Error('offline'))
    await expect(stopProjectShare(info.project_id)).rejects.toThrow('offline')
    expect((await projectIdentities())[info.project_id].url).toBe(original.url)
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await stopProjectShare(info.project_id)
    const stopped = (await projectIdentities())[info.project_id]
    expect(stopped.url).toBeUndefined()
    expect(stopped.slug).toBe(original.slug)
    expect(stopped.feedbackToken).toBe(original.feedbackToken)
  })
})
