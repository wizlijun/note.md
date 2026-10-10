import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo, ProjectSnapshot } from './types'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), fetch: vi.fn(), save: vi.fn(), data: {} as Record<string, any>, events: [] as string[], baseUrl: 'https://share.test', render: vi.fn(), bundle: vi.fn(), capture: vi.fn(), archive: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => ({
  get: async (key: string) => structuredClone(mocks.data[key]),
  set: async (key: string, value: any) => { mocks.data[key] = structuredClone(value) },
  save: async () => { mocks.events.push('persist'); await mocks.save() },
}) } }))
vi.mock('../settings.svelte', () => ({ getPluginScopedKey: (key: string) => ({ 'share.baseUrl': mocks.baseUrl, 'share.apiKey': 'owner', 'share.defaultExpiry': '7d' })[key] }))
vi.mock('./bundle', () => ({ buildProjectBundle: mocks.bundle }))
vi.mock('./presentation', () => ({ captureProjectTheme: mocks.capture, renderProjectPresentation: mocks.render }))
vi.mock('./archive', () => ({ buildProjectArchive: mocks.archive }))
import { publishProject, projectIdentities, pullProjectFeedback, stopProjectShare, listProjects, createProject, deleteProject, cancelProjectDeletion } from './host'

const info: ProjectInfo = { project_id: 'project_1', sourceRoot: '/project', mirrorRoot: '/vault/sync/project_1', entry: 'README.md', files: [] }
const file = { path: 'README.md', hash: 'a'.repeat(64), bytes: 5, markdown: 'hello' }
const snapshot: ProjectSnapshot = { schemaVersion: 1, project_id: info.project_id, snapshotId: 'snapshot_1', entry: info.entry, files: [file] }

const receipt = (url: unknown = '') => Response.json({ stage: String(url).endsWith('/archive') ? 'ready' : 'entry', expires_at: '2026-11-01T00:00:00Z' })
const frozenTheme = { themeId: 'current-theme', compiledCss: 'frozen CSS' }

beforeEach(() => {
  mocks.data = {}; mocks.events = []; mocks.invoke.mockReset(); mocks.fetch.mockReset().mockImplementation(async url => receipt(url)); mocks.save.mockReset()
  mocks.capture.mockReset().mockResolvedValue(frozenTheme)
  mocks.archive.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]))
  mocks.baseUrl = 'https://share.test'
  mocks.render.mockReset().mockResolvedValue({ themeId: 'current-theme', styleHead: '<style>current</style>', documents: { 'README.md': '<p>hello</p>' }, warnings: ['字体将使用替代'] })
  mocks.bundle.mockReset().mockReturnValue('<html>frozen bundle</html>')
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.invoke.mockImplementation(async (_command: string, { request }: any) => {
    if (request.op === 'snapshot' || request.op === 'snapshot-get') return snapshot
    if (request.op === 'bundle-get') return '<html>frozen bundle</html>'
    if (request.op === 'published') return { ...info, url: request.url, publishedSnapshotId: request.snapshotId }
    if (request.op === 'inbox') return []
    if (request.op === 'projects') return [info]
    if (request.op === 'get') return info
    return null
  })
})

describe('host project share', () => {
  it('publishes only the entry first, exposes its link, then freezes the approved full scope with the same theme', async () => {
    const linked = { ...file, path: 'docs/next.md', hash: 'b'.repeat(64) }
    let frozen = 0
    const snapshots = new Map<string, ProjectSnapshot>()
    mocks.invoke.mockImplementation(async (_command, { request }) => {
      mocks.events.push(request.op)
      if (request.op === 'get') return info
      if (request.op === 'snapshot') {
        const value = { ...snapshot, snapshotId: 's' + ++frozen, files: [file, linked].filter(f => request.paths.includes(f.path)) }
        snapshots.set(value.snapshotId, value)
        return value
      }
      if (request.op === 'snapshot-get') return snapshots.get(request.snapshotId)
      if (request.op === 'bundle-get') return '<html>' + request.snapshotId + '</html>'
      if (request.op === 'published') return { ...info, url: request.url, publishedSnapshotId: request.snapshotId }
      return null
    })
    mocks.fetch.mockImplementation(async (url, init) => {
      const saved = (await projectIdentities())[info.project_id]
      if (String(url).endsWith('/entry')) {
        expect(saved.pending?.phase).toBe('entry')
        expect(JSON.parse(init.body).previousPublicationId).toBeNull()
        expect(frozen).toBe(1)
      } else {
        expect(saved.pending?.phase).toBe('full')
        expect(init.headers['X-Snapshot-Id']).toBe('s2')
        expect(init.body).toBeInstanceOf(Uint8Array)
      }
      return receipt(url)
    })
    const callback = vi.fn(async ({ identity, info: active }) => {
      expect(identity.url).toBeTruthy()
      expect(identity.pending.phase).toBe('preparing')
      expect(active.publishedSnapshotId).toBe('s1')
      expect(frozen).toBe(1)
      mocks.capture.mockResolvedValue({ themeId: 'changed-later', compiledCss: 'new CSS' })
    })
    const result = await publishProject(info, [file, linked], 'title', { onEntryPublished: callback })
    expect(callback).toHaveBeenCalledOnce()
    expect(mocks.capture).toHaveBeenCalledOnce()
    expect(mocks.render.mock.calls.every(([, options]) => options.frozenTheme.compiledCss === 'frozen CSS')).toBe(true)
    expect(mocks.invoke.mock.calls.filter(([, { request }]) => request.op === 'snapshot').map(([, { request }]) => request.paths)).toEqual([[file.path], [file.path, linked.path]])
    expect(result.identity.publishedSnapshotId).toBe('s2')
    expect(result.identity.pending).toBeUndefined()
  })
  it('retains the entry link after archive failure and retries cached full inputs without rendering', async () => {
    mocks.fetch.mockImplementation(async url => {
      if (String(url).endsWith('/archive')) throw new Error('archive upload unknown')
      return receipt(url)
    })
    await expect(publishProject(info, [file])).rejects.toThrow('archive upload unknown')
    const saved = (await projectIdentities())[info.project_id]
    expect(saved.url).toBeTruthy()
    expect(saved.pending?.phase).toBe('full')
    const priorRequest = mocks.fetch.mock.calls.at(-1)![1]
    mocks.render.mockClear(); mocks.bundle.mockClear(); mocks.capture.mockClear(); mocks.invoke.mockClear()
    mocks.fetch.mockImplementation(async url => receipt(url))
    await publishProject(info, [], 'ignored title', { useCurrentTheme: false })
    const nextRequest = mocks.fetch.mock.calls.at(-1)![1]
    expect(nextRequest.body).toEqual(priorRequest.body)
    expect(nextRequest.headers).toEqual(priorRequest.headers)
    expect(mocks.render).not.toHaveBeenCalled()
    expect(mocks.bundle).not.toHaveBeenCalled()
    expect(mocks.capture).not.toHaveBeenCalled()
    expect(mocks.invoke.mock.calls.some(([, { request }]) => request.op === 'snapshot')).toBe(false)
  })
  it('does not upload the full archive until its cached snapshot and pending phase are durable', async () => {
    mocks.save.mockImplementation(async () => {
      if (mocks.data.projectShares?.[info.project_id]?.pending?.phase === 'full') throw new Error('disk full')
    })
    await expect(publishProject(info, [file])).rejects.toThrow('disk full')
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(mocks.archive).not.toHaveBeenCalled()
    mocks.save.mockResolvedValue(undefined)
    mocks.render.mockClear(); mocks.bundle.mockClear()
    await publishProject(info, [])
    expect(mocks.fetch.mock.calls.at(-1)![0]).toMatch(/\/archive$/)
    expect(mocks.render).not.toHaveBeenCalled()
    expect(mocks.bundle).not.toHaveBeenCalled()
  })
  it('keeps an existing complete baseline active while a new generation is preparing', async () => {
    const previous = { ...info, baseUrl: mocks.baseUrl, slug: 'existing', edit_token: 'edit', feedbackToken: 'feedback', publicationId: 'old-p', publishedSnapshotId: 'old-s', expiresAt: 'old-expiry', url: 'https://share.test/existing', shareTitle: 'old title' }
    mocks.data.projectShares = { [info.project_id]: previous }
    mocks.fetch.mockResolvedValueOnce(Response.json({ stage: 'ready', active: { publicationId: 'old-p', snapshotId: 'old-s', expires_at: 'old-expiry' } }))
    mocks.render.mockResolvedValueOnce({ themeId: 'current', styleHead: '', documents: {}, warnings: [] }).mockRejectedValueOnce(new Error('full render failed'))
    await expect(publishProject(info, [file], 'new title')).rejects.toThrow('full render failed')
    const saved = (await projectIdentities())[info.project_id]
    expect(saved).toMatchObject({ publishedSnapshotId: 'old-s', expiresAt: 'old-expiry', shareTitle: 'old title', url: previous.url })
    expect(saved.publicationId).not.toBe('old-p')
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).previousPublicationId).toBe('old-p')
    expect(mocks.invoke.mock.calls.some(([, { request }]) => request.op === 'published')).toBe(false)
  })
  it('retains approved hashes and the entry when a source changes before full freezing', async () => {
    const baseInvoke = mocks.invoke.getMockImplementation()!
    let attempts = 0
    mocks.invoke.mockImplementation(async (command, args) => {
      if (args.request.op === 'snapshot' && ++attempts > 1) {
        expect(args.request.hashes).toEqual({ [file.path]: file.hash })
        throw new Error('source hash changed')
      }
      return baseInvoke(command, args)
    })
    await expect(publishProject(info, [file])).rejects.toThrow('source hash changed')
    const saved = (await projectIdentities())[info.project_id]
    expect(saved.url).toBeTruthy()
    expect(saved.pending).toMatchObject({ phase: 'preparing', approved: [{ path: file.path, hash: file.hash }] })
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })
  it('aligns the stopped generation with the server after an unknown entry upload', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('unknown entry result'))
    await expect(publishProject(info, [file])).rejects.toThrow('unknown entry result')
    const pending = (await projectIdentities())[info.project_id].pending
    if (!pending?.phase) throw new Error('Expected staged pending')
    mocks.fetch.mockImplementationOnce(async (_url, init) => {
      expect(init.method).toBe('DELETE')
      expect(JSON.parse(init.body)).toMatchObject({ project_id: info.project_id, publicationId: pending.publicationId, previousPublicationId: null, entrySnapshotId: pending.snapshotId })
      return Response.json({ publicationId: 'server-tombstone' })
    })
    await stopProjectShare(info.project_id)
    const stopped = (await projectIdentities())[info.project_id]
    expect(stopped.pending).toBeUndefined()
    expect(stopped.publicationId).toBe('server-tombstone')
    mocks.fetch.mockImplementationOnce(async (_url, init) => {
      expect(JSON.parse(init.body).previousPublicationId).toBe('server-tombstone')
      return receipt()
    })
    await publishProject(info, [file])
  })
  it('sends exact cached entry and prior legacy IDs only while entry publication is unknown', async () => {
    mocks.data.projectShares = { [info.project_id]: { project_id: info.project_id, sourceRoot: info.sourceRoot, entry: info.entry,
      baseUrl: mocks.baseUrl, slug: '2026-10-10-project', edit_token: 'a'.repeat(32), feedbackToken: 'feedback', publishedSnapshotId: 'legacy_s0',
      pending: { phase: 'entry', publicationId: 'p1', previousPublicationId: null, snapshotId: 'entry_s1', entry: info.entry, expiresInSeconds: 3600 } } }
    mocks.fetch.mockResolvedValueOnce(Response.json({ publicationId: 'p1' }))
    await stopProjectShare(info.project_id)
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ entrySnapshotId: 'entry_s1', legacySnapshotId: 'legacy_s0' })
    const saved = mocks.data.projectShares[info.project_id]
    mocks.data.projectShares[info.project_id] = { ...saved, pending: { phase: 'full', publicationId: 'p2', previousPublicationId: 'p1', snapshotId: 'full_s2' } }
    mocks.fetch.mockResolvedValueOnce(Response.json({ publicationId: 'p2' }))
    await stopProjectShare(info.project_id)
    const body = JSON.parse(mocks.fetch.mock.calls[1][1].body)
    expect(body.entrySnapshotId).toBeUndefined()
    expect(body.legacySnapshotId).toBeUndefined()
  })
  it('defaults legacy projects to the current theme and remembers each successful project choice', async () => {
    mocks.fetch.mockImplementation(async url => receipt(url))
    const first = await publishProject(info, [file])
    expect(mocks.render).toHaveBeenLastCalledWith(snapshot, { useCurrentTheme: true, frozenTheme })
    expect(first.identity.useCurrentTheme).toBe(true)
    const second = await publishProject(info, [file], undefined, { useCurrentTheme: false })
    expect(mocks.render).toHaveBeenLastCalledWith(snapshot, { useCurrentTheme: false, frozenTheme })
    expect(second.identity.useCurrentTheme).toBe(false)
    await publishProject(info, [file])
    expect(mocks.render).toHaveBeenLastCalledWith(snapshot, { useCurrentTheme: false, frozenTheme })
  })
  it('freezes the theme option in pending and ignores changed options on retry', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('unknown'))
    await expect(publishProject(info, [file], 'theme', { useCurrentTheme: false })).rejects.toThrow('unknown')
    expect((await projectIdentities())[info.project_id].pending?.useCurrentTheme).toBe(false)
    mocks.render.mockClear()
    mocks.fetch.mockResolvedValueOnce(receipt())
    const result = await publishProject(info, [], 'theme', { useCurrentTheme: true })
    expect(mocks.render).toHaveBeenCalledOnce()
    expect(result.identity.useCurrentTheme).toBe(false)
  })
  it('bakes the frozen snapshot before persisting the titled bundle and pending identity', async () => {
    mocks.render.mockImplementation(async (input) => { mocks.events.push('render'); expect(input).toEqual(snapshot); return { themeId: 'picked', styleHead: '', documents: {}, warnings: ['图表错误'] } })
    mocks.invoke.mockImplementation(async (_command, { request }) => {
      mocks.events.push(request.op)
      if (request.op === 'get') return info
      if (request.op === 'snapshot' || request.op === 'snapshot-get') return snapshot
      if (request.op === 'published') return { ...info, url: request.url }
      return null
    })
    mocks.fetch.mockImplementationOnce(async () => {
      mocks.events.push('upload')
      expect((await projectIdentities())[info.project_id].pending?.shareTitle).toBe('分享标题')
      return receipt()
    })
    const result = await publishProject(info, [file], '  分享标题  ')
    expect(mocks.bundle).toHaveBeenCalledWith(snapshot, expect.stringContaining('/feedback/'), { title: '分享标题', publicationPending: true, archiveUrl: expect.stringMatching(/\/project\/[^/]+\/download$/), presentation: { themeId: 'picked', styleHead: '', documents: {}, warnings: ['图表错误'] } })
    expect(mocks.events.indexOf('render')).toBeLessThan(mocks.events.indexOf('bundle'))
    expect(mocks.events.indexOf('bundle')).toBeLessThan(mocks.events.indexOf('persist'))
    expect(mocks.events.indexOf('persist')).toBeLessThan(mocks.events.indexOf('upload'))
    expect(result.identity.shareTitle).toBe('分享标题')
    expect(result.warnings).toEqual(['图表错误'])
  })
  it('does not persist pending or upload when presentation cannot be baked', async () => {
    mocks.render.mockRejectedValueOnce(new Error('theme unavailable'))
    await expect(publishProject(info, [file], 'new title')).rejects.toThrow('theme unavailable')
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.invoke.mock.calls.some(([, args]) => args.request.op === 'bundle')).toBe(false)
    expect((await projectIdentities())[info.project_id]).toBeUndefined()
  })
  it('freezes a pending title and retries without rendering or accepting a changed title', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('unknown'))
    await expect(publishProject(info, [file], 'frozen title')).rejects.toThrow('unknown')
    expect((await projectIdentities())[info.project_id].pending?.shareTitle).toBe('frozen title')
    mocks.render.mockClear(); mocks.bundle.mockClear()
    mocks.fetch.mockResolvedValueOnce(receipt())
    const result = await publishProject(info, [], 'later title')
    expect(mocks.render).toHaveBeenCalledOnce()
    expect(mocks.bundle).toHaveBeenCalledOnce()
    expect(result.identity.shareTitle).toBe('frozen title')
    expect(result.warnings).toEqual(['字体将使用替代'])
  })
  it('retries legacy pending metadata without inventing a new title or rendering again', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('unknown'))
    await expect(publishProject(info, [file])).rejects.toThrow('unknown')
    delete mocks.data.projectShares[info.project_id].pending.phase
    delete mocks.data.projectShares[info.project_id].pending.shareTitle
    delete mocks.data.projectShares[info.project_id].pending.useCurrentTheme
    delete mocks.data.projectShares[info.project_id].pending.warnings
    mocks.render.mockClear(); mocks.bundle.mockClear()
    mocks.fetch.mockResolvedValueOnce(receipt())
    const result = await publishProject(info, [], 'new input cannot change the old bundle')
    expect(result.identity.shareTitle).toBeUndefined()
    expect(result.identity.useCurrentTheme).toBe(true)
    expect(result.warnings).toEqual([])
    expect(mocks.render).not.toHaveBeenCalled()
    expect(mocks.bundle).not.toHaveBeenCalled()
  })
  it('preserves an existing live identity and its remembered title when baking fails', async () => {
    mocks.fetch.mockResolvedValueOnce(receipt())
    await publishProject(info, [file], 'published title', { useCurrentTheme: false })
    const previous = (await projectIdentities())[info.project_id]
    mocks.fetch.mockClear()
    mocks.render.mockRejectedValueOnce(new Error('broken template'))
    await expect(publishProject(info, [file], 'unpublished title', { useCurrentTheme: true })).rejects.toThrow('broken template')
    expect((await projectIdentities())[info.project_id]).toEqual(previous)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('remembers successful custom titles on the original URL and supports empty title fallback', async () => {
    mocks.fetch.mockImplementation(async url => receipt(url))
    const first = await publishProject(info, [file], 'custom')
    const second = await publishProject(info, [file])
    expect(second.identity.url).toBe(first.identity.url)
    expect(second.identity.shareTitle).toBe('custom')
    const third = await publishProject(info, [file], '  ')
    expect(third.identity.shareTitle).toBe('README')
  })
  it('lists unpublished host drafts and preserves orphaned publishing credentials for management', async () => {
    mocks.data.projectShares = { orphan: { project_id: 'orphan', sourceRoot: '/old', entry: 'old.md', url: 'https://share.test/old' } }
    const projects = await listProjects()
    expect(projects.map(project => project.project_id)).toEqual(['project_1', 'orphan'])
    expect(projects[0].entry).toBe('README.md')
    expect(projects[1].orphaned).toBe(true)
    expect(projects[1].url).toBe('https://share.test/old')
  })
  it('creates a local project without requiring service configuration or publishing', async () => {
    mocks.baseUrl = ''
    mocks.invoke.mockResolvedValueOnce(info)
    expect(await createProject('/project/README.md')).toEqual(info)
    expect(mocks.invoke).toHaveBeenCalledWith('project_share', { request: { op: 'create', sourceFile: '/project/README.md' } })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('deletes a draft offline and checks buffers again before removing its local files', async () => {
    mocks.baseUrl = ''
    const beforeDelete = vi.fn(async () => { mocks.events.push('buffers') })
    mocks.invoke.mockImplementation(async (_command, { request }) => {
      mocks.events.push(request.op)
      if (request.op === 'projects') return [info]
      return null
    })
    await deleteProject(info.project_id, beforeDelete)
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(beforeDelete).toHaveBeenCalledOnce()
    expect(mocks.events.indexOf('begin-delete')).toBeLessThan(mocks.events.indexOf('buffers'))
    expect(mocks.events.indexOf('buffers')).toBeLessThan(mocks.events.indexOf('delete'))
  })
  it('keeps a pending project and credentials when remote deletion is unknown', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('upload unknown'))
    await expect(publishProject(info, [file])).rejects.toThrow('upload unknown')
    const original = await projectIdentities()
    mocks.invoke.mockClear()
    mocks.fetch.mockRejectedValueOnce(new Error('offline'))
    await expect(deleteProject(info.project_id)).rejects.toThrow('offline')
    expect(await projectIdentities()).toEqual(original)
    expect(mocks.invoke.mock.calls.some(([, args]) => args.request.op === 'begin-delete')).toBe(true)
    expect(mocks.invoke.mock.calls.some(([, args]) => args.request.op === 'delete')).toBe(false)
  })
  it.each([204, 404])('revokes pending publication before local deletion on HTTP %s', async status => {
    mocks.fetch.mockRejectedValueOnce(new Error('upload unknown'))
    await expect(publishProject(info, [file])).rejects.toThrow('upload unknown')
    const identity = (await projectIdentities())[info.project_id]
    mocks.events = []
    mocks.fetch.mockImplementationOnce(async (url, init) => {
      expect(url).toBe(identity.baseUrl + '/' + identity.slug)
      expect(init.method).toBe('DELETE')
      mocks.events.push('revoke')
      return new Response(null, { status })
    })
    mocks.invoke.mockImplementation(async (_command, { request }) => {
      mocks.events.push(request.op)
      if (request.op === 'projects') return [info]
      return null
    })
    await deleteProject(info.project_id)
    expect(mocks.events.indexOf('begin-delete')).toBeLessThan(mocks.events.indexOf('revoke'))
    expect(mocks.events.indexOf('revoke')).toBeLessThan(mocks.events.indexOf('stopped'))
    expect(mocks.events.indexOf('stopped')).toBeLessThan(mocks.events.indexOf('delete'))
    expect((await projectIdentities())[info.project_id]).toBeUndefined()
  })
  it('does not discard an active project without its owner credentials', async () => {
    mocks.invoke.mockResolvedValueOnce([{ ...info, url: 'https://share.test/active' }])
    await expect(deleteProject(info.project_id)).rejects.toThrow('凭据')
    expect(mocks.invoke.mock.calls.some(([, args]) => args.request.op === 'delete')).toBe(false)
  })
  it('can explicitly cancel deletion without changing publishing credentials', async () => {
    await cancelProjectDeletion(info.project_id)
    expect(mocks.invoke).toHaveBeenCalledWith('project_share', { request: { op: 'cancel-delete', project_id: info.project_id } })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('checks the host deletion state even when a caller retains stale project information', async () => {
    mocks.invoke.mockResolvedValueOnce({ ...info, deleting: true })
    await expect(publishProject(info, [file])).rejects.toThrow('正在删除')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('retains owner credentials if buffers change after a successful remote revoke', async () => {
    mocks.fetch.mockResolvedValueOnce(receipt())
    await publishProject(info, [file])
    mocks.invoke.mockClear()
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(deleteProject(info.project_id, async () => { throw new Error('unsaved mirror') })).rejects.toThrow('unsaved mirror')
    const retained = (await projectIdentities())[info.project_id]
    expect(retained.slug).toBeTruthy()
    expect(retained.url).toBeUndefined()
    expect(mocks.invoke.mock.calls.some(([, args]) => args.request.op === 'delete')).toBe(false)
  })
  it('never sends a different service API key to the previously bound service', async () => {
    mocks.fetch.mockResolvedValueOnce(receipt())
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
      return receipt(_url)
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
    expect(mocks.invoke.mock.calls.filter(([, input]) => input.request.op === 'snapshot')).toHaveLength(2)
    expect(bodies[0]).not.toContain('/project')
  })
  it('never uploads if identity cannot be saved', async () => {
    mocks.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(publishProject(info, [file])).rejects.toThrow('disk full')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('rechecks durable identity storage before retrying a pending bundle from memory', async () => {
    mocks.save.mockRejectedValue(new Error('disk full'))
    await expect(publishProject(info, [file])).rejects.toThrow('disk full')
    await expect(publishProject(info, [])).rejects.toThrow('disk full')
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.save).toHaveBeenCalledTimes(2)
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
    mocks.fetch.mockResolvedValueOnce(receipt())
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
