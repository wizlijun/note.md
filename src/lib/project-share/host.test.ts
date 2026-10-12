import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo, ProjectSnapshot } from './types'
import { MULTIPART_BYTES } from './multipart'

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
const snapshot: ProjectSnapshot = { schemaVersion: 1, project_id: info.project_id, snapshotId: 'full-s', entry: info.entry, files: [file] }
const frozenTheme = { themeId: 'current-theme', compiledCss: 'frozen CSS' }
const expires = '2026-11-01T00:00:00Z'
let remote: any
let frozen: number
const operation = (url: unknown) => String(url).split('/').at(-1)
const stateResponse = () => Response.json(remote)
async function server(url: unknown, init: any): Promise<Response> {
  mocks.events.push('network:' + operation(url))
  const op = operation(url)
  if (init.method === 'DELETE') return Response.json({ publicationId: remote?.publicationId ?? 'tombstone' })
  if (op === 'status') return remote ? stateResponse() : new Response('not found', { status: 404 })
  if (op === 'part') {
    const plan = remote.plans.find((plan: any) => plan.name === init.headers['X-Artifact'])
    const part = plan.parts.find((part: any) => part.number === Number(init.headers['X-Part-Number']))
    return Response.json({ number: part.number, etag: part.md5 })
  }
  const body = JSON.parse(init.body)
  if (op === 'begin') {
    remote = { ...remote, publicationId: body.publicationId, active: remote?.active ?? null,
      expires_at: remote?.expires_at ?? expires, plans: body.artifacts,
      upload: { sessionId: body.sessionId, phase: body.phase, snapshotId: body.snapshotId, sealed: [] },
      pending: { publicationId: body.publicationId, entrySnapshotId: remote?.pending?.entrySnapshotId ?? body.snapshotId, expires_at: remote?.expires_at ?? expires } }
  } else if (op === 'seal') remote.upload.sealed.push(body.artifact)
  else if (op === 'commit') {
    if (remote.upload.phase !== 'entry' || !remote.active) remote.active = { publicationId: body.publicationId, snapshotId: remote.upload.snapshotId, expires_at: expires }
    if (remote.upload.phase === 'entry') remote.entry = { publicationId: body.publicationId, snapshotId: remote.upload.snapshotId, expires_at: expires }
  } else throw new Error('Unexpected operation ' + op)
  return stateResponse()
}
function seedPending(phase: 'entry' | 'preparing' | 'full' | undefined, extra: any = {}) {
  mocks.data.projectShares = { [info.project_id]: { ...info, baseUrl: mocks.baseUrl, slug: 'existing', edit_token: 'edit', feedbackToken: 'feedback',
    pending: { phase, snapshotId: phase === 'full' ? 'full-s' : 'entry-s', publicationId: 'p1', previousPublicationId: null,
      entry: info.entry, expiresInSeconds: 604800, approved: [{ path: file.path, hash: file.hash }], frozenTheme, ...extra } } }
}
const identity = async () => (await projectIdentities())[info.project_id]

beforeEach(() => {
  remote = null; frozen = 0; mocks.data = {}; mocks.events = []; mocks.invoke.mockReset(); mocks.fetch.mockReset().mockImplementation(server); mocks.save.mockReset()
  mocks.capture.mockReset().mockResolvedValue(frozenTheme)
  mocks.archive.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]))
  mocks.baseUrl = 'https://share.test'
  mocks.render.mockReset().mockResolvedValue({ themeId: 'current-theme', styleHead: '<style>current</style>', documents: { 'README.md': '<p>hello</p>' }, warnings: ['字体将使用替代'] })
  mocks.bundle.mockReset().mockReturnValue('<html>frozen bundle</html>')
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.invoke.mockImplementation(async (_command: string, { request }: any) => {
    mocks.events.push(request.op)
    if (request.op === 'snapshot') return { ...snapshot, snapshotId: ++frozen === 1 ? 'entry-s' : 'full-s' }
    if (request.op === 'snapshot-get') return { ...snapshot, snapshotId: request.snapshotId }
    if (request.op === 'bundle-get') return '<html>frozen bundle</html>'
    if (request.op === 'published') return { ...info, url: request.url, publishedSnapshotId: request.snapshotId }
    if (request.op === 'inbox') return []
    if (request.op === 'projects') return [info]
    if (request.op === 'get') return info
    return null
  })
})

describe('frozen host multipart publication', () => {
  it('uploads entry as binary before freezing the full project, and uploads source ZIP and reader separately', async () => {
    const onEntryPublished = vi.fn(async ({ identity: saved }) => {
      expect(saved.pending.phase).toBe('preparing'); expect(saved.url).toBeTruthy(); expect(frozen).toBe(1)
      expect(mocks.archive).not.toHaveBeenCalled()
    })
    const result = await publishProject(info, [file], 'title', { onEntryPublished })
    expect(onEntryPublished).toHaveBeenCalledOnce()
    const begins = mocks.fetch.mock.calls.filter(([url]) => operation(url) === 'begin').map(([, init]) => JSON.parse(init.body))
    expect(begins.map(body => body.artifacts.map((plan: any) => plan.name))).toEqual([['entry'], ['archive', 'reader']])
    expect(begins.every(body => !('html' in body))).toBe(true)
    expect(mocks.fetch.mock.calls.filter(([url]) => operation(url) === 'part').every(([, init]) => init.body instanceof Uint8Array)).toBe(true)
    expect(mocks.archive).toHaveBeenCalledWith(expect.anything(), '<html>frozen bundle</html>', 'source')
    expect(result.identity.pending).toBeUndefined(); expect(result.identity.publishedSnapshotId).toBe('full-s')
    expect(mocks.capture).toHaveBeenCalledOnce()
    expect(mocks.render.mock.calls.every(([, options]) => options.frozenTheme.compiledCss === 'frozen CSS')).toBe(true)
  })
  it('persists plans and each confirmed receipt, then resumes only the missing part without rendering', async () => {
    mocks.archive.mockResolvedValue(new Uint8Array(MULTIPART_BYTES + 3).fill(97))
    let failed = false
    mocks.fetch.mockImplementation(async (url, init) => {
      if (operation(url) === 'part') {
        const pending = (await identity()).pending as any
        expect(pending.protocol).toBe(2); expect(pending.upload.sessionId).toBe(init.headers['X-Upload-Session'])
        if (init.headers['X-Artifact'] === 'archive' && init.headers['X-Part-Number'] === '2' && !failed) { failed = true; throw new Error('lost part') }
      }
      return server(url, init)
    })
    await expect(publishProject(info, [file])).rejects.toThrow('lost part')
    const before = (await identity()).pending as any
    expect(before.upload.receipts.archive).toHaveLength(1)
    mocks.fetch.mockClear(); mocks.render.mockClear(); mocks.bundle.mockClear(); mocks.capture.mockClear(); mocks.invoke.mockClear()
    await publishProject(info, [], 'ignored', { useCurrentTheme: false })
    expect(mocks.fetch.mock.calls.filter(([url]) => operation(url) === 'part').map(([, init]) => [init.headers['X-Artifact'], init.headers['X-Part-Number']])).toEqual([['archive', '2'], ['reader', '1']])
    expect(mocks.render).not.toHaveBeenCalled(); expect(mocks.bundle).not.toHaveBeenCalled(); expect(mocks.capture).not.toHaveBeenCalled()
    expect(mocks.invoke.mock.calls.some(([, { request }]) => request.op === 'snapshot')).toBe(false)
  })
  it('recovers a lost full commit response from exact active IDs without uploading again', async () => {
    mocks.fetch.mockImplementation(async (url, init) => {
      const response = await server(url, init)
      if (operation(url) === 'commit' && remote.upload.phase === 'full') throw new Error('commit unknown')
      return response
    })
    await expect(publishProject(info, [file])).rejects.toThrow('commit unknown')
    expect((await identity()).pending?.phase).toBe('full')
    mocks.fetch.mockClear(); mocks.fetch.mockImplementation(server); mocks.archive.mockClear()
    await publishProject(info, [])
    expect(mocks.fetch).toHaveBeenCalledOnce(); expect(operation(mocks.fetch.mock.calls[0][0])).toBe('status')
    expect(mocks.archive).not.toHaveBeenCalled(); expect((await identity()).pending).toBeUndefined()
  })
  it('does not clear pending for a ready previous active or a matching publication with wrong snapshot', async () => {
    seedPending('full')
    remote = { publicationId: 'p1', active: { publicationId: 'old', snapshotId: 'old-s', expires_at: expires }, expires_at: expires }
    mocks.fetch.mockImplementation(async (url, init) => {
      if (operation(url) === 'commit') return Response.json({ ...remote, active: { publicationId: 'p1', snapshotId: 'wrong-s', expires_at: expires } })
      return server(url, init)
    })
    await expect(publishProject(info, [])).rejects.toThrow('身份')
    expect((await identity()).pending?.snapshotId).toBe('full-s')
    expect(mocks.invoke.mock.calls.some(([, { request }]) => request.op === 'published')).toBe(false)
  })
  it('rebuilds old full pending using the exact legacy format', async () => {
    seedPending('full'); remote = { publicationId: 'p1', active: null, expires_at: expires }
    await publishProject(info, [])
    expect(mocks.archive).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: 'full-s' }), '<html>frozen bundle</html>', 'legacy')
  })
  it.each(['entry', 'preparing'] as const)('continues old %s without resubmitting a confirmed entry or renewing expiry', async phase => {
    seedPending(phase)
    remote = { publicationId: 'p1', active: { publicationId: 'p1', snapshotId: 'entry-s', expires_at: expires }, entry: { publicationId: 'p1', snapshotId: 'entry-s', expires_at: expires }, pending: { publicationId: 'p1', entrySnapshotId: 'entry-s', expires_at: expires }, expires_at: expires }
    await publishProject(info, [])
    const begins = mocks.fetch.mock.calls.filter(([url]) => operation(url) === 'begin').map(([, init]) => JSON.parse(init.body))
    expect(begins).toHaveLength(1); expect(begins[0].phase).toBe('full')
  })
  it('persists local pending when marking the exact remote publication locally fails', async () => {
    seedPending('full'); remote = { publicationId: 'p1', active: { publicationId: 'p1', snapshotId: 'full-s', expires_at: expires }, expires_at: expires }
    const original = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (command, args) => { if (args.request.op === 'published') throw new Error('local published failed'); return original(command, args) })
    await expect(publishProject(info, [])).rejects.toThrow('local published failed')
    expect((await identity()).pending?.snapshotId).toBe('full-s'); expect(mocks.archive).not.toHaveBeenCalled()
  })
  it('never sends a network request if the frozen plan cannot be saved', async () => {
    mocks.save.mockRejectedValue(new Error('disk full'))
    await expect(publishProject(info, [file])).rejects.toThrow('disk full')
    await expect(publishProject(info, [])).rejects.toThrow('disk full')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('checks reconstructed artifacts against frozen SHA and plans before transmitting', async () => {
    seedPending('full'); remote = { publicationId: 'p1', active: null, expires_at: expires }
    mocks.fetch.mockImplementation(async (url, init) => { if (operation(url) === 'part') throw new Error('offline'); return server(url, init) })
    await expect(publishProject(info, [])).rejects.toThrow('offline')
    mocks.archive.mockResolvedValue(new Uint8Array([9, 9, 9])); mocks.fetch.mockClear()
    await expect(publishProject(info, [])).rejects.toThrow('冻结')
    expect(mocks.fetch.mock.calls.every(([url]) => operation(url) === 'status')).toBe(true)
  })
  it('recovers an older no-phase successful publish by local HTML SHA without sending a new publication', async () => {
    seedPending(undefined); delete mocks.data.projectShares[info.project_id].pending.publicationId
    remote = { publicationId: null, active: null, legacy: { bytes: 26, expires_at: expires, project_id: info.project_id } }
    mocks.fetch.mockImplementation(async (url, init) => operation(url) === 'legacy' ? new Response('<html>frozen bundle</html>') : server(url, init))
    const result = await publishProject(info, [])
    expect(result.identity.expiresAt).toBe(expires); expect(result.identity.pending).toBeUndefined()
    expect(mocks.fetch.mock.calls.map(([url]) => operation(url))).toEqual(['status', 'legacy'])
    expect(mocks.render).not.toHaveBeenCalled()
  })
  it('does not silently renew an older no-phase publish with missing remote state', async () => {
    seedPending(undefined); delete mocks.data.projectShares[info.project_id].pending.publicationId
    await expect(publishProject(info, [])).rejects.toThrow('不续期')
    const first = (await identity()).pending as any
    await expect(publishProject(info, [])).rejects.toThrow('不续期')
    expect((await identity()).pending).toEqual(first)
    expect(mocks.fetch.mock.calls.every(([url]) => operation(url) === 'status')).toBe(true)
  })
})

describe('project management and service boundaries', () => {
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
    await publishProject(info, [file])
    mocks.fetch.mockClear(); mocks.baseUrl = 'https://another-service.test'
    await expect(pullProjectFeedback(info.project_id)).rejects.toThrow('另一个分享服务')
    await expect(stopProjectShare(info.project_id)).rejects.toThrow('另一个分享服务')
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

describe('multipart recovery boundaries', () => {
  it('continues an uncommitted registered entry instead of assuming its pending identity is visible', async () => {
    let interrupted = false
    mocks.fetch.mockImplementation(async (url, init) => {
      if (operation(url) === 'part' && !interrupted) { interrupted = true; throw new Error('entry part unknown') }
      return server(url, init)
    })
    await expect(publishProject(info, [file])).rejects.toThrow('entry part unknown')
    expect(remote.active).toBeNull()
    mocks.fetch.mockClear()
    await publishProject(info, [])
    expect(mocks.fetch.mock.calls.filter(([url]) => operation(url) === 'part').map(([, init]) => init.headers['X-Artifact'])).toEqual(['entry', 'archive', 'reader'])
  })
  it('recovers a lost entry commit receipt without reuploading or recommitting the entry', async () => {
    let interrupted = false
    mocks.fetch.mockImplementation(async (url, init) => {
      const response = await server(url, init)
      if (operation(url) === 'commit' && remote.upload.phase === 'entry' && !interrupted) { interrupted = true; throw new Error('entry commit unknown') }
      return response
    })
    await expect(publishProject(info, [file])).rejects.toThrow('entry commit unknown')
    mocks.fetch.mockClear()
    await publishProject(info, [])
    expect(mocks.fetch.mock.calls.filter(([url]) => operation(url) === 'begin').map(([, init]) => JSON.parse(init.body).phase)).toEqual(['full'])
    expect((await identity()).expiresAt).toBe(expires)
  })
  it('stops after a failed receipt save and retries that save before progressing to the next part', async () => {
    mocks.archive.mockResolvedValue(new Uint8Array(MULTIPART_BYTES + 3))
    mocks.save.mockImplementation(async () => {
      if (mocks.data.projectShares?.[info.project_id]?.pending?.upload?.receipts.archive?.length) throw new Error('receipt disk full')
    })
    await expect(publishProject(info, [file])).rejects.toThrow('receipt disk full')
    expect(mocks.fetch.mock.calls.filter(([url]) => operation(url) === 'part').map(([, init]) => init.headers['X-Artifact'])).toEqual(['entry', 'archive'])
    mocks.fetch.mockClear()
    await expect(publishProject(info, [])).rejects.toThrow('receipt disk full')
    expect(mocks.fetch).not.toHaveBeenCalled()
    mocks.save.mockResolvedValue(undefined)
    await publishProject(info, [])
    expect(mocks.fetch.mock.calls.filter(([url]) => operation(url) === 'part').map(([, init]) => [init.headers['X-Artifact'], init.headers['X-Part-Number']])).toEqual([['archive', '2'], ['reader', '1']])
  })
  it('keeps pending visible in Store memory if saving the successful local completion fails', async () => {
    seedPending('full')
    remote = { publicationId: 'p1', active: { publicationId: 'p1', snapshotId: 'full-s', expires_at: expires }, expires_at: expires }
    mocks.save.mockImplementation(async () => { if (!mocks.data.projectShares[info.project_id].pending) throw new Error('completion disk full') })
    await expect(publishProject(info, [])).rejects.toThrow('completion disk full')
    expect((await identity()).pending?.snapshotId).toBe('full-s')
    mocks.save.mockResolvedValue(undefined)
    expect((await publishProject(info, [])).identity.pending).toBeUndefined()
  })
  it('recovers a lost seal response from the server sealed artifact without retransmitting it', async () => {
    let interrupted = false
    mocks.fetch.mockImplementation(async (url, init) => {
      const response = await server(url, init)
      if (operation(url) === 'seal' && JSON.parse(init.body).artifact === 'archive' && !interrupted) { interrupted = true; throw new Error('seal unknown') }
      return response
    })
    await expect(publishProject(info, [file])).rejects.toThrow('seal unknown')
    const priorServer = server
    mocks.fetch.mockImplementation(async (url, init) => {
      if (operation(url) === 'begin' && remote.upload?.sessionId === JSON.parse(init.body).sessionId) return stateResponse()
      return priorServer(url, init)
    })
    mocks.fetch.mockClear()
    await publishProject(info, [])
    expect(mocks.fetch.mock.calls.filter(([url]) => operation(url) === 'part').map(([, init]) => init.headers['X-Artifact'])).toEqual(['reader'])
  })
  it('rotates only an expired native session and preserves its frozen publication and artifacts', async () => {
    let interrupted = false
    let original: any
    mocks.fetch.mockImplementation(async (url, init) => {
      if (operation(url) === 'part' && init.headers['X-Artifact'] === 'archive' && !interrupted) {
        interrupted = true; original = structuredClone((await identity()).pending)
        return Response.json({ error: 'upload_expired' }, { status: 410 })
      }
      return server(url, init)
    })
    const result = await publishProject(info, [file])
    const fullBegins = mocks.fetch.mock.calls.filter(([url, init]) => operation(url) === 'begin' && JSON.parse(init.body).phase === 'full').map(([, init]) => JSON.parse(init.body))
    expect(fullBegins).toHaveLength(2)
    expect(fullBegins[1].replaceSessionId).toBe(original.upload.sessionId)
    expect(fullBegins[1].sessionId).not.toBe(original.upload.sessionId)
    expect(fullBegins[1].artifacts).toEqual(fullBegins[0].artifacts)
    expect(fullBegins[1].publicationId).toBe(fullBegins[0].publicationId)
    expect(result.identity.expiresAt).toBe(expires)
  })
  it('does not rotate a revoked or expired publication or accept a bad part receipt', async () => {
    mocks.fetch.mockImplementation(async (url, init) => operation(url) === 'part' ? Response.json({ error: 'publication_expired' }, { status: 410 }) : server(url, init))
    await expect(publishProject(info, [file])).rejects.toThrow('publication_expired')
    expect(mocks.fetch.mock.calls.filter(([url]) => operation(url) === 'begin')).toHaveLength(1)
    mocks.fetch.mockImplementation(async (url, init) => operation(url) === 'part' ? Response.json({ number: 1, etag: '0'.repeat(32) }) : server(url, init))
    await expect(publishProject(info, [])).rejects.toThrow('校验回执')
    expect((await identity()).pending?.upload?.receipts.entry).toBeUndefined()
  })
  it('does not overwrite another publication generation', async () => {
    seedPending('full'); remote = { publicationId: 'other', active: null, expires_at: expires }
    await expect(publishProject(info, [])).rejects.toThrow('代际身份')
    expect(mocks.fetch).toHaveBeenCalledOnce(); expect(mocks.archive).not.toHaveBeenCalled()
  })
  it('migrates an unmatched legacy KV page with one durable generation and its original expiry', async () => {
    seedPending(undefined); delete mocks.data.projectShares[info.project_id].pending.publicationId
    remote = { publicationId: null, active: null, legacy: { bytes: 8, expires_at: expires, project_id: info.project_id } }
    mocks.fetch.mockImplementation(async (url, init) => operation(url) === 'legacy' ? new Response('old page') : server(url, init))
    const result = await publishProject(info, [])
    const begin = JSON.parse(mocks.fetch.mock.calls.find(([url]) => operation(url) === 'begin')![1].body)
    expect(begin.phase).toBe('legacy'); expect(begin.artifacts.map((plan: any) => plan.name)).toEqual(['entry'])
    expect(begin.legacy).toMatchObject({ snapshotId: 'entry-s', expires_at: expires, migrationId: expect.any(String) })
    expect(result.identity.publicationId).toBe(begin.publicationId)
    expect(result.identity.expiresAt).toBe(expires)
    expect(mocks.render).not.toHaveBeenCalled(); expect(mocks.archive).not.toHaveBeenCalled()
  })
  it('freezes title and theme across entry retries and remembers successful choices on the same URL', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('unknown status'))
    await expect(publishProject(info, [file], 'frozen title', { useCurrentTheme: false })).rejects.toThrow('unknown status')
    const first = await publishProject(info, [], 'ignored title', { useCurrentTheme: true })
    expect(first.identity.shareTitle).toBe('frozen title'); expect(first.identity.useCurrentTheme).toBe(false)
    mocks.render.mockClear()
    const second = await publishProject(info, [file])
    expect(second.identity.url).toBe(first.identity.url); expect(second.identity.shareTitle).toBe('frozen title')
    expect(mocks.render.mock.calls.every(([, options]) => options.useCurrentTheme === false)).toBe(true)
    expect((await publishProject(info, [file], '   ')).identity.shareTitle).toBe('README')
  })
  it('does not change a previously published identity when rendering its next entry fails', async () => {
    await publishProject(info, [file], 'published title')
    const previous = await identity()
    mocks.fetch.mockClear(); mocks.render.mockRejectedValueOnce(new Error('broken template'))
    await expect(publishProject(info, [file], 'new title')).rejects.toThrow('broken template')
    expect(await identity()).toEqual(previous); expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('rechecks exactly the approved source hashes after the entry is visible', async () => {
    const invoke = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (command, args) => {
      if (args.request.op === 'snapshot' && frozen === 1) { expect(args.request.hashes).toEqual({ [file.path]: file.hash }); throw new Error('source hash changed') }
      return invoke(command, args)
    })
    await expect(publishProject(info, [file])).rejects.toThrow('source hash changed')
    expect((await identity()).url).toBeTruthy()
    expect((await identity()).pending).toMatchObject({ phase: 'preparing', approved: [{ path: file.path, hash: file.hash }] })
    expect(mocks.archive).not.toHaveBeenCalled()
  })
})

it('keeps a previous complete publication and title visible until the next full commit', async () => {
  const previous = { ...info, baseUrl: mocks.baseUrl, slug: 'existing', edit_token: 'edit', feedbackToken: 'feedback', publicationId: 'old-p', publishedSnapshotId: 'old-s', expiresAt: expires, url: 'https://share.test/existing', shareTitle: 'old title' }
  mocks.data.projectShares = { [info.project_id]: previous }
  remote = { publicationId: 'old-p', active: { publicationId: 'old-p', snapshotId: 'old-s', expires_at: expires }, expires_at: expires }
  mocks.render.mockResolvedValueOnce({ themeId: 'current', styleHead: '', documents: {}, warnings: [] }).mockRejectedValueOnce(new Error('full render failed'))
  await expect(publishProject(info, [file], 'new title')).rejects.toThrow('full render failed')
  expect(await identity()).toMatchObject({ publishedSnapshotId: 'old-s', expiresAt: expires, shareTitle: 'old title', url: previous.url })
  expect((await identity()).publicationId).not.toBe('old-p')
  expect(mocks.invoke.mock.calls.some(([, { request }]) => request.op === 'published')).toBe(false)
  expect(JSON.parse(mocks.fetch.mock.calls.find(([url]) => operation(url) === 'begin')![1].body).previousPublicationId).toBe('old-p')
})

it('keeps a full pending stage durable before constructing and uploading its artifacts', async () => {
  mocks.save.mockImplementation(async () => { if (mocks.data.projectShares?.[info.project_id]?.pending?.phase === 'full') throw new Error('full disk full') })
  await expect(publishProject(info, [file])).rejects.toThrow('full disk full')
  expect(mocks.archive).not.toHaveBeenCalled()
  expect(mocks.fetch.mock.calls.filter(([url]) => operation(url) === 'begin')).toHaveLength(1)
  mocks.save.mockResolvedValue(undefined); mocks.render.mockClear(); mocks.bundle.mockClear()
  await publishProject(info, [])
  expect(mocks.render).not.toHaveBeenCalled(); expect(mocks.bundle).not.toHaveBeenCalled()
})

it('recovers an unknown migrated no-phase commit from v2 active identity after restart', async () => {
  seedPending(undefined); delete mocks.data.projectShares[info.project_id].pending.publicationId
  remote = { publicationId: null, active: null, legacy: { bytes: 8, expires_at: expires, project_id: info.project_id } }
  mocks.fetch.mockImplementation(async (url, init) => {
    if (operation(url) === 'legacy') return new Response('old page')
    const response = await server(url, init)
    if (operation(url) === 'commit') { delete remote.legacy; throw new Error('legacy commit unknown') }
    return response
  })
  await expect(publishProject(info, [])).rejects.toThrow('legacy commit unknown')
  expect((await identity()).pending?.phase).toBe('legacy')
  mocks.fetch.mockImplementation(server); mocks.fetch.mockClear()
  const result = await publishProject(info, [])
  expect(result.identity.pending).toBeUndefined(); expect(mocks.fetch).toHaveBeenCalledOnce()
  expect(operation(mocks.fetch.mock.calls[0][0])).toBe('status')
})

it('retains exact cached entry IDs and legacy migration cleanup identity when stopping', async () => {
  seedPending('entry', { legacy: { migrationId: 'exact-migration', snapshotId: 'old-s', expires_at: expires } })
  mocks.data.projectShares[info.project_id].publishedSnapshotId = 'old-s'
  await stopProjectShare(info.project_id)
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ publicationId: 'p1', previousPublicationId: null, entrySnapshotId: 'entry-s', legacySnapshotId: 'old-s', legacyMigrationId: 'exact-migration' })
})

it('uses the remotely acknowledged tombstone generation for a new publication after stopping', async () => {
  seedPending('entry')
  mocks.fetch.mockResolvedValueOnce(Response.json({ publicationId: 'server-tombstone' }))
  await stopProjectShare(info.project_id)
  expect((await identity()).publicationId).toBe('server-tombstone')
  await publishProject(info, [file])
  expect(JSON.parse(mocks.fetch.mock.calls.find(([url]) => operation(url) === 'begin')![1].body).previousPublicationId).toBe('server-tombstone')
})

it.each(['revoked', 'expired'] as const)('does not clear frozen pending for an exact target that is %s', async kind => {
  seedPending('full')
  remote = { publicationId: 'p1', revoked: kind === 'revoked', active: { publicationId: 'p1', snapshotId: 'full-s', expires_at: kind === 'expired' ? '2000-01-01T00:00:00Z' : expires }, expires_at: expires }
  await expect(publishProject(info, [])).rejects.toThrow(kind === 'revoked' ? '已撤回' : '已到期')
  expect((await identity()).pending?.snapshotId).toBe('full-s')
  expect(mocks.invoke.mock.calls.some(([, { request }]) => request.op === 'published')).toBe(false)
  expect(mocks.fetch).toHaveBeenCalledOnce(); expect(mocks.archive).not.toHaveBeenCalled()
})

it('rejects an expired current entry while retaining a previous complete baseline', async () => {
  seedPending('full')
  remote = { publicationId: 'p1', active: { publicationId: 'old', snapshotId: 'old-s', expires_at: expires }, pending: { publicationId: 'p1', entrySnapshotId: 'entry-s', expires_at: '2000-01-01T00:00:00Z' }, expires_at: expires }
  await expect(publishProject(info, [])).rejects.toThrow('已到期')
  expect((await identity()).pending?.snapshotId).toBe('full-s'); expect(mocks.archive).not.toHaveBeenCalled()
})

it('allows a new explicit successor of a revoked previous generation', async () => {
  mocks.data.projectShares = { [info.project_id]: { ...info, baseUrl: mocks.baseUrl, slug: 'existing', edit_token: 'edit', feedbackToken: 'feedback', publicationId: 'old-p' } }
  remote = { publicationId: 'old-p', revoked: true, active: null, expires_at: '2000-01-01T00:00:00Z' }
  mocks.fetch.mockImplementation(async (url, init) => {
    if (operation(url) === 'begin') { remote.revoked = false; remote.expires_at = expires }
    return server(url, init)
  })
  expect((await publishProject(info, [file])).identity.pending).toBeUndefined()
})

it('persists opaque native part receipts unchanged and supplies them to seal after restart', async () => {
  let interrupted = false
  const opaque = 'Native-ETag_aBcD-Z9+/='
  mocks.fetch.mockImplementation(async (url, init) => {
    if (operation(url) === 'part' && init.headers['X-Artifact'] === 'archive') return Response.json({ number: 1, etag: opaque })
    if (operation(url) === 'seal' && JSON.parse(init.body).artifact === 'archive') {
      expect(JSON.parse(init.body).parts).toEqual([{ number: 1, etag: opaque }])
      if (!interrupted) { interrupted = true; throw new Error('opaque seal unknown') }
    }
    return server(url, init)
  })
  await expect(publishProject(info, [file])).rejects.toThrow('opaque seal unknown')
  expect((await identity()).pending?.upload?.receipts.archive).toEqual([{ number: 1, etag: opaque }])
  mocks.fetch.mockClear()
  await publishProject(info, [])
  expect(mocks.fetch.mock.calls.filter(([url]) => operation(url) === 'part').map(([, init]) => init.headers['X-Artifact'])).toEqual(['reader'])
})

it('preserves uppercase native MD5 receipts while still checking the frozen transmission digest', async () => {
  mocks.fetch.mockImplementation(async (url, init) => {
    const response = await server(url, init)
    if (operation(url) === 'part') {
      const part = await response.json()
      return Response.json({ ...part, etag: part.etag.toUpperCase() })
    }
    if (operation(url) === 'seal') expect(JSON.parse(init.body).parts.every((part: any) => part.etag === part.etag.toUpperCase())).toBe(true)
    return response
  })
  expect((await publishProject(info, [file])).identity.pending).toBeUndefined()
})

it('does not commit an opaque receipt artifact when native seal rejects the frozen final checksum', async () => {
  mocks.fetch.mockImplementation(async (url, init) => {
    if (operation(url) === 'part' && init.headers['X-Artifact'] === 'archive') return Response.json({ number: 1, etag: 'Opaque-RECEIPT' })
    if (operation(url) === 'seal' && JSON.parse(init.body).artifact === 'archive') return Response.json({ error: 'Artifact checksum mismatch' }, { status: 409 })
    return server(url, init)
  })
  await expect(publishProject(info, [file])).rejects.toThrow('Artifact checksum mismatch')
  expect((await identity()).pending?.phase).toBe('full')
  expect(mocks.fetch.mock.calls.filter(([url]) => operation(url) === 'commit')).toHaveLength(1)
  expect((await identity()).publishedSnapshotId).toBe('entry-s')
})

it.each(['', 'a'.repeat(513), 'receipt\ninvalid'])('rejects malformed native ETags without persisting a receipt', async etag => {
  mocks.fetch.mockImplementation(async (url, init) => operation(url) === 'part' ? Response.json({ number: 1, etag }) : server(url, init))
  await expect(publishProject(info, [file])).rejects.toThrow('校验回执')
  expect((await identity()).pending?.upload?.receipts.entry).toBeUndefined()
})
