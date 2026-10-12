import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { SELF, env } from 'cloudflare:test'
import worker, { type Env } from '../src/index'
import { projectStateKey } from '../src/project'
const bindings = env as unknown as Env
const media = bindings.MEDIA
const fetchUpload = (url: string, init: RequestInit) => worker.fetch(new Request(url, init), bindings)
const receipts = new Map<string, { number: number; etag: string }[]>()
const slug = '2026-10-12-multipart'
const token = 'a'.repeat(32), auth = { Authorization: 'Bearer test-key' }
const base = `http://x/project/${slug}/upload/`
const plan = { name: 'entry', bytes: 5, sha256: 'a'.repeat(64), etag: '62109206880d38a4010a98e11243924a-1', parts: [{ number: 1, bytes: 5, md5: '5d41402abc4b2a76b9719d911017c592' }] }
const readerPlan = { name: 'reader', bytes: 6, sha256: 'c'.repeat(64), etag: 'de264b7e67f6d37b8cf759ff77a66046-1', parts: [{ number: 1, bytes: 6, md5: '1de9b0a30075ae8c303eb420c103c320' }] }
const zipPlan = { name: 'archive', bytes: 3, sha256: 'd'.repeat(64), etag: '7fc597a78db7a5e206de1a686677526c-1', parts: [{ number: 1, bytes: 3, md5: 'adcdbd79a8d84175c229b192aadc02f2' }] }
const begin = (extra = {}) => op('begin', { project_id: 'project', feedback_token_hash: 'b'.repeat(64), previousPublicationId: null, phase: 'entry', snapshotId: 'entry', entry: 'README.md', title: 'Project', expires_in_seconds: 3600, artifacts: [plan], ...extra })
async function op(name: string, extra: Record<string, any> = {}) {
 const args = { edit_token: token, publicationId: 'pub', sessionId: 'session', ...extra }
 if (name === 'seal' && !('parts' in args)) (args as any).parts = receipts.get(`${args.publicationId}:${args.sessionId}:${extra.artifact}`)
 return fetchUpload(base + name, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
}
async function part(body = 'hello', extra = {}) {
 const headers = { ...auth, 'X-Edit-Token': token, 'X-Publication-Id': 'pub', 'X-Upload-Session': 'session', 'X-Artifact': 'entry', 'X-Part-Number': '1', 'Content-Length': String(body.length), ...extra }
 const response = await fetchUpload(base + 'part', { method: 'POST', headers, body })
 if (response.ok) receipts.set(`${headers['X-Publication-Id']}:${headers['X-Upload-Session']}:${headers['X-Artifact']}`, [await response.clone().json() as { number: number; etag: string }])
 return response
}
async function publish() { expect((await begin()).status).toBe(200); expect((await part()).status).toBe(200); expect((await op('seal', { artifact: 'entry' })).status).toBe(200); return op('commit') }
const fullArgs = { edit_token: token, project_id: 'project', feedback_token_hash: 'b'.repeat(64), publicationId: 'pub', previousPublicationId: null, sessionId: 'full', phase: 'full', snapshotId: 'full', entry: 'README.md', title: 'Project', expires_in_seconds: 3600, artifacts: [readerPlan, zipPlan] }
function fullBegin(hooks: Partial<R2Bucket>) {
 const bucket = { get: media.get.bind(media), head: media.head.bind(media), put: media.put.bind(media), delete: media.delete.bind(media), createMultipartUpload: media.createMultipartUpload.bind(media), resumeMultipartUpload: media.resumeMultipartUpload.bind(media), ...hooks } as R2Bucket
 return worker.fetch(new Request(base + 'begin', { method: 'POST', headers: auth, body: JSON.stringify(fullArgs) }), { ...bindings, MEDIA: bucket })
}
async function cleanupStatus(hooks: Partial<R2Bucket> = {}) {
 const calls: string[] = []
 const counted = { get(key: string) { calls.push('get'); return media.get(key) }, head(key: string) { calls.push('head'); return media.head(key) },
  put(key: string, value: any, options: any) { calls.push('put'); return media.put(key, value, options) },
  delete(key: string) { calls.push('delete'); return media.delete(key) },
  resumeMultipartUpload(key: string, uploadId: string) { const native = media.resumeMultipartUpload(key, uploadId); return { key, uploadId, abort() { calls.push('abort'); return native.abort() } } }, ...hooks,
 } as unknown as R2Bucket
 const response = await worker.fetch(new Request(base + 'status', { method: 'POST', headers: auth, body: JSON.stringify({ edit_token: token }) }), { ...bindings, MEDIA: counted })
 return { response, calls }
}
describe('native multipart project publication', () => {
 it('registers before upload, hides uncommitted entry, and commits idempotently', async () => {
  expect((await begin()).status).toBe(200)
  expect((await SELF.fetch('http://x/' + slug)).status).toBe(410)
  expect((await part()).status).toBe(200)
  expect((await op('seal', { artifact: 'entry' })).status).toBe(200)
  expect((await op('seal', { artifact: 'entry' })).status).toBe(200)
  expect((await op('commit')).status).toBe(200)
  expect(await (await SELF.fetch('http://x/' + slug)).text()).toBe('hello')
  expect((await op('commit')).status).toBe(200)
 })
 it('rejects altered plans, previous generation and bad checksum', async () => {
  await begin()
  expect((await begin({ title: 'changed' })).status).toBe(409)
  expect((await begin({ publicationId: 'other', sessionId: 'other', previousPublicationId: 'wrong' })).status).toBe(409)
  expect((await part('world')).status).toBe(200)
  expect((await op('seal', { artifact: 'entry' })).status).toBe(409)
  expect((await op('commit')).status).toBe(409)
  expect((await op('status')).status).toBe(200)
  expect((await (await op('status')).json() as any).upload.sealed).toEqual([])
  expect((await begin({ sessionId: 'retry', replaceSessionId: 'session' })).status).toBe(200)
  expect((await part('hello', { 'X-Upload-Session': 'retry' })).status).toBe(200)
  expect((await op('seal', { sessionId: 'retry', artifact: 'entry' })).status).toBe(200)
  expect((await op('commit', { sessionId: 'retry' })).status).toBe(200)
  expect(await (await SELF.fetch('http://x/' + slug)).text()).toBe('hello')
 })
 it('keeps a registered state invisible to MCP and blocks legacy entry before reading', async () => {
  await begin()
  const old = await SELF.fetch(`http://x/project/${slug}/entry`, { method: 'POST', headers: auth, body: 'invalid JSON' })
  expect(old.status).toBe(409)
  const mcp = await SELF.fetch('http://x/mcp', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'share_get_html', arguments: { slug } } }) })
  expect((await mcp.json() as any).result.isError).toBe(true)
  expect((await SELF.fetch(`http://x/feedback/${slug}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Feedback-Token': 'visitor' }, body: JSON.stringify({ schemaVersion: 1, project_id: 'project', snapshotId: 'entry', submissionId: 'submission', edits: [], annotations: [] }) })).status).toBe(410)
 })
 it('never revives revoked sessions', async () => {
  await publish()
  expect((await SELF.fetch('http://x/' + slug, { method: 'DELETE', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ edit_token: token }) })).status).toBe(200)
  expect((await begin()).status).toBe(410)
  expect((await op('commit')).status).toBe(410)
  expect((await SELF.fetch('http://x/' + slug)).status).toBe(410)
 })
 it('enforces the absolute entry deadline', async () => {
  await begin()
  const state = await (await bindings.MEDIA.get(projectStateKey(slug)))!.json() as any
  state.entry_deadline = '2000-01-01T00:00:00.000Z'
  await bindings.MEDIA.put(projectStateKey(slug), JSON.stringify(state))
  expect((await begin()).status).toBe(410)
  expect((await part()).status).toBe(410)
 })
 it('switches full HTML and original ZIP together, retaining the old complete active throughout an update', async () => {
  await publish()
  async function full(publicationId = 'pub', sessionId = 'full', snapshotId = 'full') {
   expect((await begin({ publicationId, sessionId, previousPublicationId: publicationId === 'pub' ? null : 'pub', phase: 'full', snapshotId, artifacts: [readerPlan, zipPlan] })).status).toBe(200)
   expect((await part('zip', { 'X-Upload-Session': sessionId, 'X-Publication-Id': publicationId, 'X-Artifact': 'archive' })).status).toBe(200)
   expect((await op('seal', { publicationId, sessionId, artifact: 'archive' })).status).toBe(200)
   expect((await op('commit', { publicationId, sessionId })).status).toBe(409)
   expect((await part('reader', { 'X-Upload-Session': sessionId, 'X-Publication-Id': publicationId, 'X-Artifact': 'reader' })).status).toBe(200)
   expect((await op('seal', { publicationId, sessionId, artifact: 'reader' })).status).toBe(200)
   expect((await op('commit', { publicationId, sessionId })).status).toBe(200)
  }
  await full()
  expect(await (await SELF.fetch(`http://x/project/${slug}/download`)).text()).toBe('zip')
  const next = { publicationId: 'next', sessionId: 'nextEntry', previousPublicationId: 'pub', snapshotId: 'nextEntry' }
  expect((await begin(next)).status).toBe(200)
  expect((await part('hello', { 'X-Publication-Id': 'next', 'X-Upload-Session': 'nextEntry' })).status).toBe(200)
  expect((await op('seal', { ...next, artifact: 'entry' })).status).toBe(200)
  expect((await op('commit', next)).status).toBe(200)
  expect(await (await SELF.fetch('http://x/' + slug)).text()).toBe('reader')
  const status = await (await op('status')).json() as any
  expect(status.active.publicationId).toBe('pub'); expect(status.entry.publicationId).toBe('next')
  await full('next', 'nextFull', 'nextFull')
  // The entry request may return late after full has switched. Its exact proof
  // recovers success without replacing or downgrading the new complete active.
  expect((await begin(next)).status).toBe(200)
  expect((await op('commit', next)).status).toBe(200)
  expect((await begin({ ...next, title: 'changed' })).status).toBe(409)
  expect((await begin({ ...next, artifacts: [{ ...plan, sha256: 'e'.repeat(64) }] })).status).toBe(409)
  const completed = await (await op('status')).json() as any
  expect(completed.active.publicationId).toBe('next'); expect(completed.active.snapshotId).toBe('nextFull')
 })
 it('rotates expired native sessions without changing the frozen plan or absolute deadline', async () => {
  await begin()
  const before = await (await bindings.MEDIA.get(projectStateKey(slug)))!.json() as any
  await bindings.MEDIA.resumeMultipartUpload(before.upload.artifacts[0].key, before.upload.artifacts[0].uploadId).abort()
  expect((await part()).status).toBe(410)
  expect((await begin({ sessionId: 'rotated', replaceSessionId: 'session' })).status).toBe(200)
  const after = await (await bindings.MEDIA.get(projectStateKey(slug)))!.json() as any
  expect(after.entry_deadline).toBe(before.entry_deadline)
  expect(after.upload.artifacts[0].key).not.toBe(before.upload.artifacts[0].key)
  expect(after.retired[0].artifacts[0].key).toBe(before.upload.artifacts[0].key)
  expect((await begin({ sessionId: 'badRotation', replaceSessionId: 'rotated', title: 'changed' })).status).toBe(409)
 })
 it('recovers seal when the native complete response is lost and HEAD already proves completion', async () => {
  await begin(); await part()
  const broken = { get: media.get.bind(media), head: media.head.bind(media), put: media.put.bind(media), delete: media.delete.bind(media), resumeMultipartUpload(key: string, uploadId: string) {
   const native = media.resumeMultipartUpload(key, uploadId)
   return { key, uploadId, uploadPart: native.uploadPart.bind(native), abort: native.abort.bind(native), async complete(parts: R2UploadedPart[]) { await native.complete(parts); throw new Error('lost response') } }
  } } as unknown as R2Bucket
  const response = await worker.fetch(new Request(base + 'seal', { method: 'POST', headers: auth, body: JSON.stringify({ edit_token: token, publicationId: 'pub', sessionId: 'session', artifact: 'entry', parts: receipts.get('pub:session:entry') }) }), { ...bindings, MEDIA: broken })
  expect(response.status).toBe(200)
  expect((await op('commit')).status).toBe(200)
  expect((await (await op('status')).json() as any).active.snapshotId).toBe('entry')
 })
 it('uses five native calls for full seal and records complete closure only in the existing commit CAS', async () => {
  await publish(); await fullBegin({})
  await part('reader', { 'X-Upload-Session': 'full', 'X-Artifact': 'reader' })
  const calls: string[] = []
  const counted = { get(key: string) { calls.push('get'); return media.get(key) }, head(key: string) { calls.push('head'); return media.head(key) },
   resumeMultipartUpload(key: string, uploadId: string) { const native = media.resumeMultipartUpload(key, uploadId); return { key, uploadId, async complete(parts: R2UploadedPart[]) { calls.push('complete'); return native.complete(parts) } } },
  } as unknown as R2Bucket
  const response = await worker.fetch(new Request(base + 'seal', { method: 'POST', headers: auth, body: JSON.stringify({ edit_token: token, publicationId: 'pub', sessionId: 'full', artifact: 'reader', parts: receipts.get('pub:full:reader') }) }), { ...bindings, MEDIA: counted })
  expect(response.status).toBe(200); expect((await response.json() as any).upload.sealed).toEqual(['reader'])
  expect(calls).toEqual(['get', 'head', 'complete', 'get', 'head'])
  expect((await (await media.get(projectStateKey(slug)))!.json() as any).upload.artifacts[0].closed).toBeUndefined()
  await part('zip', { 'X-Upload-Session': 'full', 'X-Artifact': 'archive' }); await op('seal', { sessionId: 'full', artifact: 'archive' }); await op('commit', { sessionId: 'full' })
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  expect(state.upload.artifacts.map((a: any) => a.closed)).toEqual(['complete', 'complete'])
  expect(state.retired.find((s: any) => s.sessionId === 'session').artifacts[0].closed).toBe('complete')
 })
 it.each(['size', 'etag', 'customMetadata'])('hard rejects complete result with invalid %s without trusting closure', async field => {
  await begin(); await part()
  const wrapped = { get: media.get.bind(media), head: media.head.bind(media), resumeMultipartUpload(key: string, uploadId: string) {
   const native = media.resumeMultipartUpload(key, uploadId)
   return { key, uploadId, async complete(parts: R2UploadedPart[]) { const object = await native.complete(parts); return { ...object, [field]: field === 'size' ? 999 : field === 'etag' ? '0'.repeat(32) + '-1' : undefined } } }
  } } as unknown as R2Bucket
  const response = await worker.fetch(new Request(base + 'seal', { method: 'POST', headers: auth, body: JSON.stringify({ edit_token: token, publicationId: 'pub', sessionId: 'session', artifact: 'entry', parts: receipts.get('pub:session:entry') }) }), { ...bindings, MEDIA: wrapped })
  expect(response.status).toBe(409)
 })
 it('keeps closure hints separate from native seal commit and receipt validation', async () => {
  await begin()
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  state.upload.artifacts[0].closed = 'complete'
  await media.put(projectStateKey(slug), JSON.stringify(state))
  await part('world')
  expect((await op('seal', { artifact: 'entry' })).status).toBe(409)
  expect((await op('commit')).status).toBe(409)
  expect((await (await op('status')).json() as any).upload.sealed).toEqual([])
 })
 it('does not reuse a seal receipt proof after the fresh frozen plan changes', async () => {
  await begin(); await part()
  let heads = 0
  const wrapped = { get: media.get.bind(media), async head(key: string) { heads++; return media.head(key) }, resumeMultipartUpload(key: string, uploadId: string) {
   const native = media.resumeMultipartUpload(key, uploadId)
   return { key, uploadId, async complete(parts: R2UploadedPart[]) {
    const object = await native.complete(parts)
    const state = await (await media.get(projectStateKey(slug)))!.json() as any
    state.upload.artifacts[0].sha256 = 'f'.repeat(64)
    await media.put(projectStateKey(slug), JSON.stringify(state))
    return object
   } }
  } } as unknown as R2Bucket
  const response = await worker.fetch(new Request(base + 'seal', { method: 'POST', headers: auth, body: JSON.stringify({ edit_token: token, publicationId: 'pub', sessionId: 'session', artifact: 'entry', parts: receipts.get('pub:session:entry') }) }), { ...bindings, MEDIA: wrapped })
  expect(response.status).toBe(200); expect((await response.json() as any).upload.sealed).toEqual([])
  expect(heads).toBe(2)
 })
 it('inherits v1 pending expiry and exposes its already committed entry identity', async () => {
  const oldEntry = await SELF.fetch(`http://x/project/${slug}/entry`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ edit_token: token, project_id: 'project', feedback_token_hash: 'b'.repeat(64), publicationId: 'pub', previousPublicationId: null, snapshotId: 'oldEntry', entry: 'README.md', title: 'Project', expires_in_seconds: 3600, html: 'old' }) })
  const old = await oldEntry.json() as any
  const status = await (await op('status')).json() as any
  expect(status.entry.snapshotId).toBe('oldEntry')
  expect((await begin({ sessionId: 'full', phase: 'full', snapshotId: 'full', artifacts: [readerPlan, zipPlan] })).status).toBe(200)
  const state = await (await bindings.MEDIA.get(projectStateKey(slug)))!.json() as any
  expect(state.publication_expires_at).toBe(old.expires_at)
 })
 it('copies valid KV through a native fixed length stream and retains its active during migration', async () => {
  const expiry = new Date(Date.now() + 600000).toISOString()
  await bindings.SHARES.put(slug, 'old KV', { metadata: { edit_token: token, project_id: 'project', feedback_token_hash: 'b'.repeat(64), expires_at: expiry, size_bytes: 6 } })
  const status = await (await op('status')).json() as any
  expect(status.legacy.bytes).toBe(6); expect(JSON.stringify(status)).not.toContain(token)
  expect(await (await op('legacy')).text()).toBe('old KV')
  const migration = { migrationId: 'migration', snapshotId: 'old', expires_at: expiry }
  expect((await begin({ legacy: migration })).status).toBe(200)
  expect(await (await SELF.fetch('http://x/' + slug)).text()).toBe('old KV')
  expect((await part()).status).toBe(200); expect((await op('seal', { artifact: 'entry' })).status).toBe(200); expect((await op('commit')).status).toBe(200)
  expect(await (await SELF.fetch('http://x/' + slug)).text()).toBe('old KV')
 })
 it('refuses KV migration without verifiable size and leaves the public legacy page intact', async () => {
  await bindings.SHARES.put(slug, 'old KV', { metadata: { edit_token: token, project_id: 'project', feedback_token_hash: 'b'.repeat(64), expires_at: null } })
  expect((await begin({ legacy: { migrationId: 'migration', snapshotId: 'old', expires_at: null } })).status).toBe(409)
  expect(await bindings.MEDIA.head(projectStateKey(slug))).toBeNull()
  expect(await (await SELF.fetch('http://x/' + slug)).text()).toBe('old KV')
 })
 it('rejects absent known length and excessive control bodies before uploading', async () => {
  await begin()
  expect((await part('hello', { 'Content-Length': '' })).status).toBe(411)
  expect((await op('status', { extra: 'x'.repeat(17000) })).status).toBe(413)
 })

 it('keeps the tombstone writable at the cleanup cap and does not add a ninth retirement', async () => {
  await begin()
  const state = await (await bindings.MEDIA.get(projectStateKey(slug)))!.json() as any
  state.retired = Array.from({ length: 8 }, (_, i) => ({ sessionId: `retired${i}`, artifacts: [{ key: `project-share/${slug}/retired/${i}`, uploadId: 'unknown' }], retain_until: new Date(Date.now() + 86400000).toISOString() }))
  await bindings.MEDIA.put(projectStateKey(slug), JSON.stringify(state))
  expect((await begin({ sessionId: 'replacement', replaceSessionId: 'session' })).status).toBe(409)
  expect((await SELF.fetch('http://x/' + slug, { method: 'DELETE', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ edit_token: token }) })).status).toBe(200)
  const stopped = await (await bindings.MEDIA.get(projectStateKey(slug)))!.json() as any
  expect(stopped.revoked).toBe(true); expect(stopped.retired).toHaveLength(8)
 })
 it('cleans one retired session per control request, without scanning or deleting referenced keys', async () => {
  await begin()
  const state = await (await bindings.MEDIA.get(projectStateKey(slug)))!.json() as any
  const keys = ['first', 'second'].map(key => `project-share/${slug}/retired/${key}`)
  for (const key of keys) await bindings.MEDIA.put(key, 'obsolete')
  state.retired = keys.map((key, i) => ({ sessionId: String(i), artifacts: [{ key }] }))
  await bindings.MEDIA.put(projectStateKey(slug), JSON.stringify(state))
  expect((await op('status')).status).toBe(200)
  expect(await bindings.MEDIA.head(keys[0])).toBeNull(); expect(await bindings.MEDIA.head(keys[1])).not.toBeNull()
  expect(await bindings.MEDIA.head(projectStateKey(slug))).not.toBeNull()
  expect((await op('status')).status).toBe(200)
  expect(await bindings.MEDIA.head(keys[1])).toBeNull()
 })
 it('rejects an in-flight part and complete crossing revocation and retains exact cleanup keys', async () => {
  await begin(); await part()
  const wrapped = { get: media.get.bind(media), head: media.head.bind(media), put: media.put.bind(media), delete: media.delete.bind(media),
   resumeMultipartUpload(key: string, uploadId: string) {
    const native = media.resumeMultipartUpload(key, uploadId)
    return { key, uploadId, uploadPart: native.uploadPart.bind(native), abort: native.abort.bind(native), async complete(parts: R2UploadedPart[]) {
     // Complete storage first, then revoke before the caller rechecks its fence.
     const object = await native.complete(parts)
     await SELF.fetch('http://x/' + slug, { method: 'DELETE', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ edit_token: token }) })
     return object
    } }
   },
  } as unknown as R2Bucket
  const response = await worker.fetch(new Request(base + 'seal', { method: 'POST', headers: auth, body: JSON.stringify({ edit_token: token, publicationId: 'pub', sessionId: 'session', artifact: 'entry', parts: receipts.get('pub:session:entry') }) }), { ...bindings, MEDIA: wrapped })
  expect(response.status).toBe(410)
  expect((await SELF.fetch('http://x/' + slug)).status).toBe(410)
  const state = await (await bindings.MEDIA.get(projectStateKey(slug)))!.json() as any
  expect(state.revoked).toBe(true); expect(state.upload.artifacts[0].key).toContain('/uploads/')
  expect(await bindings.MEDIA.head(state.upload.artifacts[0].key)).toBeNull()
 })
 it('protects a concurrent winning active from a losing commit CAS', async () => {
  await begin(); await part(); await op('seal', { artifact: 'entry' })
  let intercepted = false
  const wrapped = { get: media.get.bind(media), head: media.head.bind(media), delete: media.delete.bind(media),
   async put(key: string, value: any, options: any) {
    if (!intercepted && key === projectStateKey(slug) && JSON.parse(value).active?.snapshotId === 'entry') {
     intercepted = true; expect((await op('commit')).status).toBe(200)
    }
    return media.put(key, value, options)
   },
  } as unknown as R2Bucket
  const response = await worker.fetch(new Request(base + 'commit', { method: 'POST', headers: auth, body: JSON.stringify({ edit_token: token, publicationId: 'pub', sessionId: 'session' }) }), { ...bindings, MEDIA: wrapped })
  expect(response.status).toBe(409)
  expect(await (await SELF.fetch('http://x/' + slug)).text()).toBe('hello')
 })
 it('persists the legacy migration exact key in a pre-registration stop tombstone', async () => {
  const key = `project-share/${slug}/legacy/migration/legacy.html`
  await bindings.MEDIA.put(key, 'unknown copied HTML')
  const response = await SELF.fetch('http://x/' + slug, { method: 'DELETE', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ edit_token: token, publicationId: 'pub', previousPublicationId: null, project_id: 'project', legacyMigrationId: 'migration' }) })
  expect(response.status).toBe(200)
  expect(await bindings.MEDIA.head(key)).toBeNull()
  expect((await begin()).status).toBe(410)
 })
 it('requires complete bounded receipt lists and rejects null control JSON', async () => {
  await begin(); await part()
  for (const parts of [[], [{ number: 2, etag: 'opaque' }], [{ number: 1, etag: 'x'.repeat(513) }]]) expect((await op('seal', { artifact: 'entry', parts })).status).toBe(400)
  const response = await fetchUpload(base + 'commit', { method: 'POST', headers: auth, body: 'null' })
  expect(response.status).toBe(400)
 })

 it('blocks an old archive after its attempt CAS interleaves with v2 migration', async () => {
  await SELF.fetch(`http://x/project/${slug}/entry`, { method: 'POST', headers: auth, body: JSON.stringify({ edit_token: token, project_id: 'project', feedback_token_hash: 'b'.repeat(64), publicationId: 'pub', previousPublicationId: null, snapshotId: 'oldEntry', entry: 'README.md', title: 'Project', expires_in_seconds: 3600, html: 'old' }) })
  const source = strToU8('source'), prefix = '.__notemd-full/'
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', source))].map(x => x.toString(16).padStart(2, '0')).join('')
  const bytes = zipSync({ 'README.md': source, [prefix + 'reader.html']: strToU8('legacy full'), [prefix + 'manifest.json']: strToU8(JSON.stringify({ schemaVersion: 1, project_id: 'project', snapshotId: 'full', entry: 'README.md', htmlPath: prefix + 'reader.html', files: [{ path: 'README.md', bytes: source.length, hash }] })) })
  let intercepted = false
  const wrapped = { get: media.get.bind(media), head: media.head.bind(media), delete: media.delete.bind(media),
   async put(key: string, value: any, options: any) {
    const result = await media.put(key, value, options)
    if (!intercepted && key === projectStateKey(slug) && JSON.parse(value).attempt) {
     intercepted = true
     expect((await begin({ phase: 'full', sessionId: 'full', snapshotId: 'full', artifacts: [readerPlan, zipPlan] })).status).toBe(200)
    }
    return result
   },
  } as unknown as R2Bucket
  const response = await worker.fetch(new Request(`http://x/project/${slug}/archive`, { method: 'POST', headers: { ...auth, 'X-Edit-Token': token, 'X-Publication-Id': 'pub', 'X-Snapshot-Id': 'full' }, body: bytes }), { ...bindings, MEDIA: wrapped })
  expect(response.status).toBe(409)
  const state = await (await bindings.MEDIA.get(projectStateKey(slug)))!.json() as any
  expect(state.schemaVersion).toBe(2); expect(state.active.snapshotId).toBe('oldEntry')
  expect(await bindings.MEDIA.head(`project-share/${slug}/pub/full/archive.zip`)).toBeNull()
 })
 it('rechecks business expiry after sealed-object HEADs and preserves a still-valid previous active', async () => {
  await publish()
  const state = await (await bindings.MEDIA.get(projectStateKey(slug)))!.json() as any
  state.active.publicationId = 'previous'; state.active.ready = true
  await bindings.MEDIA.put(projectStateKey(slug), JSON.stringify(state))
  await begin({ phase: 'full', sessionId: 'full', snapshotId: 'full', artifacts: [readerPlan, zipPlan] })
  await part('reader', { 'X-Upload-Session': 'full', 'X-Artifact': 'reader' }); await op('seal', { sessionId: 'full', artifact: 'reader' })
  await part('zip', { 'X-Upload-Session': 'full', 'X-Artifact': 'archive' }); await op('seal', { sessionId: 'full', artifact: 'archive' })
  let intercepted = false
  const wrapped = { get: media.get.bind(media), put: media.put.bind(media), delete: media.delete.bind(media), async head(key: string) {
   const result = await media.head(key)
   if (!intercepted && key.includes('/uploads/')) {
    intercepted = true
    const latest = await (await media.get(projectStateKey(slug)))!.json() as any
    latest.publication_expires_at = '2000-01-01T00:00:00.000Z'
    await media.put(projectStateKey(slug), JSON.stringify(latest))
   }
   return result
  } } as unknown as R2Bucket
  const response = await worker.fetch(new Request(base + 'commit', { method: 'POST', headers: auth, body: JSON.stringify({ edit_token: token, publicationId: 'pub', sessionId: 'full' }) }), { ...bindings, MEDIA: wrapped })
  expect(response.status).toBe(410)
  expect(await (await SELF.fetch('http://x/' + slug)).text()).toBe('hello')
  expect((await (await op('status')).json() as any).active.publicationId).toBe('previous')
 })

 it('recovers committed entry begin/commit after full starts while checking the business fence first', async () => {
  await publish()
  expect((await begin({ phase: 'full', sessionId: 'full', snapshotId: 'full', artifacts: [readerPlan, zipPlan] })).status).toBe(200)
  expect((await begin()).status).toBe(200)
  expect((await op('commit')).status).toBe(200)
  const current = await (await op('status')).json() as any
  expect(current.upload.sessionId).toBe('full'); expect(current.active.snapshotId).toBe('entry')
  expect((await begin({ title: 'changed' })).status).toBe(409)
  const state = await (await bindings.MEDIA.get(projectStateKey(slug)))!.json() as any
  state.publication_expires_at = '2000-01-01T00:00:00.000Z'
  await bindings.MEDIA.put(projectStateKey(slug), JSON.stringify(state))
  expect((await begin()).status).toBe(410)
  expect((await op('commit')).status).toBe(410)
 })

 it('uses six native calls for first entry and full begin, and two for empty recovery', async () => {
  const calls: string[] = []
  const counted = { get(key: string) { calls.push('get'); return media.get(key) }, head(key: string) { calls.push('head'); return media.head(key) },
   put(key: string, value: any, options: any) { calls.push('put'); return media.put(key, value, options) },
   delete(key: string) { calls.push('delete'); return media.delete(key) },
   resumeMultipartUpload(key: string, uploadId: string) { const native = media.resumeMultipartUpload(key, uploadId); return { key, uploadId, uploadPart: native.uploadPart.bind(native), complete: native.complete.bind(native), abort() { calls.push('abort'); return native.abort() } } },
   createMultipartUpload(key: string, options: any) { calls.push('create'); return media.createMultipartUpload(key, options) },
  } as unknown as R2Bucket
  const shares = { getWithMetadata(key: string, type: 'stream') { calls.push('kvGet'); return bindings.SHARES.getWithMetadata(key, type) } } as unknown as KVNamespace
  const start = (extra = {}) => worker.fetch(new Request(base + 'begin', { method: 'POST', headers: auth, body: JSON.stringify({ edit_token: token, project_id: 'project', feedback_token_hash: 'b'.repeat(64), publicationId: 'pub', previousPublicationId: null, sessionId: 'session', phase: 'entry', snapshotId: 'entry', entry: 'README.md', title: 'Project', expires_in_seconds: 3600, artifacts: [plan], ...extra }) }), { ...bindings, MEDIA: counted, SHARES: shares })
  expect((await start()).status).toBe(200)
  expect(calls).toEqual(['get', 'kvGet', 'put', 'create', 'get', 'put'])
  calls.length = 0
  expect((await start()).status).toBe(200)
  expect(calls).toEqual(['get', 'head'])
  await part(); await op('seal', { artifact: 'entry' }); await op('commit')
  calls.length = 0
  expect((await start()).status).toBe(200)
  expect(calls).toEqual(['get', 'head'])
  expect((await (await start()).json() as any).upload.sealed).toEqual(['entry'])
  calls.length = 0
  expect((await start({ phase: 'full', sessionId: 'full', snapshotId: 'full', artifacts: [readerPlan, zipPlan] })).status).toBe(200)
  expect(calls).toEqual(['get', 'put', 'create', 'create', 'get', 'put'])
  await part('reader', { 'X-Upload-Session': 'full', 'X-Artifact': 'reader' }); await op('seal', { sessionId: 'full', artifact: 'reader' })
  await part('zip', { 'X-Upload-Session': 'full', 'X-Artifact': 'archive' }); await op('seal', { sessionId: 'full', artifact: 'archive' }); await op('commit', { sessionId: 'full' })
  calls.length = 0
  const next = { publicationId: 'next', previousPublicationId: 'pub', sessionId: 'nextEntry', snapshotId: 'nextEntry' }
  expect((await start(next)).status).toBe(200)
  expect(calls).toEqual(['get', 'put', 'create', 'get', 'put'])
  await part('hello', { 'X-Publication-Id': 'next', 'X-Upload-Session': 'nextEntry' }); await op('seal', { ...next, artifact: 'entry' }); await op('commit', next)
  calls.length = 0
  expect((await start({ ...next, phase: 'full', sessionId: 'nextFull', snapshotId: 'nextFull', artifacts: [readerPlan, zipPlan] })).status).toBe(200)
  expect(calls).toEqual(['get', 'put', 'create', 'create', 'get', 'put'])
 })
 it('aborts the first unregistered MPU when the second native create fails', async () => {
  await publish()
  const created: R2MultipartUpload[] = []
  await expect(fullBegin({ createMultipartUpload: async (key: string, options: any) => {
   if (created.length) throw new Error('second create failed')
   const upload = await media.createMultipartUpload(key, options); created.push(upload); return upload
  } } as Partial<R2Bucket>)).rejects.toThrow('second create failed')
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  expect(state.upload.artifacts.map((a: any) => a.uploadId)).toEqual([undefined, undefined])
  await expect(created[0].uploadPart(1, 'reader')).rejects.toThrow()
  expect((await fullBegin({})).status).toBe(200)
 })
 it('keeps competing registered uploadIds and aborts only its own duplicate MPUs', async () => {
  await publish()
  const created: R2MultipartUpload[] = []
  let winner: any
  const response = await fullBegin({ createMultipartUpload: async (key: string, options: any) => {
   const upload = await media.createMultipartUpload(key, options); created.push(upload)
   if (created.length === 2) { expect((await fullBegin({})).status).toBe(200); winner = await (await media.get(projectStateKey(slug)))!.json() as any }
   return upload
  } } as Partial<R2Bucket>)
  expect(response.status).toBe(200)
  const after = await (await media.get(projectStateKey(slug)))!.json() as any
  expect(after.upload.artifacts.map((a: any) => a.uploadId)).toEqual(winner.upload.artifacts.map((a: any) => a.uploadId))
  for (const upload of created) await expect(upload.uploadPart(1, 'loser')).rejects.toThrow()
  for (const artifact of after.upload.artifacts) expect((await media.resumeMultipartUpload(artifact.key, artifact.uploadId).uploadPart(1, 'winner')).etag).toBeTruthy()
 })
 it('preserves all registered MPUs after an unknown successful batch CAS and aborts a failed batch', async () => {
  await publish()
  for (const persisted of [false, true]) {
   const created: R2MultipartUpload[] = []
   await expect(fullBegin({ createMultipartUpload: async (key: string, options: any) => { const upload = await media.createMultipartUpload(key, options); created.push(upload); return upload },
    put: async (key: string, value: any, options: any) => {
     if (key === projectStateKey(slug) && JSON.parse(value).upload?.sessionId === 'full' && JSON.parse(value).upload.artifacts.some((a: any) => a.uploadId)) {
      if (persisted) await media.put(key, value, options)
      throw new Error('CAS result unknown')
     }
     return media.put(key, value, options)
    },
   } as Partial<R2Bucket>)).rejects.toThrow('CAS result unknown')
   expect(created).toHaveLength(2)
   const state = await (await media.get(projectStateKey(slug)))!.json() as any
   expect(state.upload.artifacts.map((a: any) => a.uploadId)).toEqual(persisted ? created.map(upload => upload.uploadId) : [undefined, undefined])
   for (const upload of created) {
    if (persisted) expect((await upload.uploadPart(1, 'registered')).etag).toBeTruthy()
    else await expect(upload.uploadPart(1, 'unregistered')).rejects.toThrow()
   }
  }
 })
 it('rechecks revoke after both full MPUs are created without partially registering either', async () => {
  await publish()
  const created: R2MultipartUpload[] = []
  const response = await fullBegin({ createMultipartUpload: async (key: string, options: any) => {
   const upload = await media.createMultipartUpload(key, options); created.push(upload)
   if (created.length === 2) await SELF.fetch('http://x/' + slug, { method: 'DELETE', headers: auth, body: JSON.stringify({ edit_token: token }) })
   return upload
  } } as Partial<R2Bucket>)
  expect(response.status).toBe(410)
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  expect(state.upload.artifacts.map((a: any) => a.uploadId)).toEqual([undefined, undefined])
  for (const upload of created) await expect(upload.uploadPart(1, 'late')).rejects.toThrow()
 })
 it('aborts a losing batch after a concurrent session replacement wins its registration CAS', async () => {
  await publish()
  const created: R2MultipartUpload[] = []
  let replaced = false
  const response = await fullBegin({ createMultipartUpload: async (key: string, options: any) => { const upload = await media.createMultipartUpload(key, options); created.push(upload); return upload },
   put: async (key: string, value: any, options: any) => {
    if (!replaced && JSON.parse(value).upload?.artifacts.every((a: any) => !!a.uploadId)) {
     replaced = true
     expect((await begin({ ...fullArgs, sessionId: 'replacement', replaceSessionId: 'full' })).status).toBe(200)
    }
    return media.put(key, value, options)
   },
  } as Partial<R2Bucket>)
  expect(response.status).toBe(409)
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  expect(state.upload.sessionId).toBe('replacement')
  expect(state.retired.find((s: any) => s.sessionId === 'full').artifacts.map((a: any) => a.key)).toEqual(created.map(upload => upload.key))
  for (const upload of created) await expect(upload.uploadPart(1, 'loser')).rejects.toThrow()
 })
 it('recognizes its registered batch in retirement after an unknown successful CAS', async () => {
  await publish()
  const created: R2MultipartUpload[] = []
  await expect(fullBegin({ createMultipartUpload: async (key: string, options: any) => { const upload = await media.createMultipartUpload(key, options); created.push(upload); return upload },
   put: async (key: string, value: any, options: any) => {
    const saved = await media.put(key, value, options)
    if (JSON.parse(value).upload?.artifacts.every((a: any) => !!a.uploadId)) {
     expect((await begin({ ...fullArgs, sessionId: 'replacement', replaceSessionId: 'full' })).status).toBe(200)
     throw new Error('CAS result unknown')
    }
    return saved
   },
  } as Partial<R2Bucket>)).rejects.toThrow('CAS result unknown')
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  expect(state.retired.find((s: any) => s.sessionId === 'full').artifacts.map((a: any) => a.uploadId)).toEqual(created.map(upload => upload.uploadId))
  for (const upload of created) expect((await upload.uploadPart(1, 'registered')).etag).toBeTruthy()
 })
 it('does not abort a possibly registered batch if unknown-CAS recovery cannot read state', async () => {
  await publish()
  const created: R2MultipartUpload[] = []
  let unreadable = false
  await expect(fullBegin({ get: async (key: string) => { if (unreadable) throw new Error('read failed'); return media.get(key) },
   createMultipartUpload: async (key: string, options: any) => { const upload = await media.createMultipartUpload(key, options); created.push(upload); return upload },
   put: async (key: string, value: any, options: any) => {
    const saved = await media.put(key, value, options)
    if (JSON.parse(value).upload?.artifacts.every((a: any) => !!a.uploadId)) { unreadable = true; throw new Error('CAS result unknown') }
    return saved
   },
  } as Partial<R2Bucket>)).rejects.toThrow('CAS result unknown')
  expect(created).toHaveLength(2)
  for (const upload of created) expect((await upload.uploadPart(1, 'registered')).etag).toBeTruthy()
  expect((await fullBegin({})).status).toBe(200)
 })
 it('cleans one completed retired artifact within six calls without aborting its consumed uploadId', async () => {
  await publish()
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  const keys = ['one', 'two'].map(name => `project-share/${slug}/retired/${name}`)
  for (const key of keys) await media.put(key, 'obsolete')
  state.retired = [{ sessionId: 'retired', artifacts: keys.map(key => ({ key, uploadId: 'consumed' })), retain_until: new Date(Date.now() + 86400000).toISOString() }]
  await media.put(projectStateKey(slug), JSON.stringify(state))
  const { response, calls } = await cleanupStatus()
  expect(response.status).toBe(200)
  expect(calls).toEqual(['get', 'head', 'get', 'delete', 'put', 'head']) // final HEAD describes the current live upload
  expect(await media.head(keys[0])).toBeNull(); expect(await media.head(keys[1])).not.toBeNull()
  const after = await (await media.get(projectStateKey(slug)))!.json() as any
  expect(after.retired[0].artifacts.map((a: any) => a.key)).toEqual([keys[1]])
 })
 it('alternates retained unknown completions with deduplicated revoked artifacts one key at a time', async () => {
  await publish()
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  const liveKey = state.upload.artifacts[0].key, secondKey = `project-share/${slug}/revoked/second`
  await media.put(secondKey, 'second')
  state.revoked = true
  state.upload.artifacts.push({ ...state.upload.artifacts[0], key: secondKey })
  const unknown = await media.createMultipartUpload(`project-share/${slug}/unknown`)
  state.retired = [{ sessionId: 'unknown', artifacts: [{ key: unknown.key, uploadId: unknown.uploadId }], retain_until: new Date(Date.now() + 86400000).toISOString() }]
  await media.put(projectStateKey(slug), JSON.stringify(state))
  expect((await cleanupStatus()).calls).toEqual(['get', 'head', 'get', 'abort', 'put'])
  expect(await media.head(liveKey)).not.toBeNull()
  expect((await cleanupStatus()).calls).toEqual(['get', 'get', 'delete', 'put'])
  expect(await media.head(liveKey)).toBeNull(); expect(await media.head(secondKey)).not.toBeNull()
  await cleanupStatus()
  expect((await cleanupStatus()).calls).toEqual(['get', 'get', 'delete', 'put'])
  expect(await media.head(secondKey)).toBeNull()
  const after = await (await media.get(projectStateKey(slug)))!.json() as any
  expect(after.retired).toHaveLength(1); expect(after.upload.artifacts).toHaveLength(2)
  await media.put(liveKey, 'late complete')
  await cleanupStatus(); await cleanupStatus()
  expect(await media.head(liveKey)).toBeNull()
 })
 it('cleans known complete retirement within four calls using the successful CAS snapshot', async () => {
  await publish()
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  expect(state.upload.artifacts[0].closed).toBe('complete')
  state.retired = [{ sessionId: 'retired', artifacts: state.upload.artifacts.map((a: any) => ({ key: a.key, uploadId: a.uploadId, closed: a.closed })) }]
  state.revoked = true; state.active = null; delete state.upload
  await media.put(projectStateKey(slug), JSON.stringify(state))
  expect((await cleanupStatus()).calls).toEqual(['get', 'get', 'delete', 'put'])
  expect((await (await media.get(projectStateKey(slug)))!.json() as any).retired).toEqual([])
 })
 it('persists NoSuchUpload closure once and still deletes late objects while retaining exact tombstone keys', async () => {
  await begin()
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  const artifact = state.upload.artifacts[0]
  await media.resumeMultipartUpload(artifact.key, artifact.uploadId).abort()
  state.revoked = true
  await media.put(projectStateKey(slug), JSON.stringify(state))
  expect((await cleanupStatus()).calls).toEqual(['get', 'head', 'get', 'abort', 'put'])
  expect((await (await media.get(projectStateKey(slug)))!.json() as any).upload.artifacts[0].closed).toBe('aborted')
  expect((await cleanupStatus()).calls).toEqual(['get', 'get', 'delete', 'put'])
  await media.put(artifact.key, 'late complete')
  expect((await cleanupStatus()).calls).toEqual(['get', 'get', 'delete', 'put'])
  expect(await media.head(artifact.key)).toBeNull()
  expect((await (await media.get(projectStateKey(slug)))!.json() as any).upload.artifacts[0].key).toBe(artifact.key)
 })
 it('retains an aborted retirement through seven days while deleting late writes without repeating abort', async () => {
  await begin()
  const key = `project-share/${slug}/retired/aborted`, native = await media.createMultipartUpload(key)
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  state.revoked = true; state.active = null; delete state.upload
  state.retired = [{ sessionId: 'retired', artifacts: [{ key, uploadId: native.uploadId }], retain_until: new Date(Date.now() + 7 * 86400000).toISOString() }]
  await media.put(projectStateKey(slug), JSON.stringify(state))
  expect((await cleanupStatus()).calls).toEqual(['get', 'head', 'get', 'abort', 'put'])
  await media.put(key, 'late complete')
  expect((await cleanupStatus()).calls).toEqual(['get', 'get', 'delete', 'put'])
  const retained = await (await media.get(projectStateKey(slug)))!.json() as any
  expect(retained.retired[0].artifacts).toEqual([{ key, uploadId: native.uploadId, closed: 'aborted' }])
  retained.retired[0].retain_until = '2000-01-01T00:00:00.000Z'
  await media.put(projectStateKey(slug), JSON.stringify(retained))
  expect((await cleanupStatus()).calls).toEqual(['get', 'get', 'delete', 'put'])
  expect((await (await media.get(projectStateKey(slug)))!.json() as any).retired).toEqual([])
 })
 it('recovers the successful cleanup CAS snapshot when its native response is lost', async () => {
  await publish()
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  state.revoked = true
  await media.put(projectStateKey(slug), JSON.stringify(state))
  const { response } = await cleanupStatus({ put: async (key: string, value: any, options: any) => { await media.put(key, value, options); throw new Error('lost CAS response') } } as Partial<R2Bucket>)
  expect(response.status).toBe(200); expect((await response.json() as any).revoked).toBe(true)
  const after = await (await media.get(projectStateKey(slug)))!.json() as any
  expect(after.cleanup_cursor).toBe(0); expect(after.upload.artifacts[0].closed).toBe('complete')
  expect(await media.head(after.upload.artifacts[0].key)).toBeNull()
 })
 it('preserves a failed retirement and rechecks a newly referenced object before deletion', async () => {
  await begin()
  const key = `project-share/${slug}/retired/object`
  await media.put(key, 'keep')
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  state.retired = [{ sessionId: 'retired', artifacts: [{ key, uploadId: 'consumed' }] }]
  await media.put(projectStateKey(slug), JSON.stringify(state))
  await cleanupStatus({ delete: async () => { throw new Error('storage failure') } } as Partial<R2Bucket>)
  expect((await (await media.get(projectStateKey(slug)))!.json() as any).retired).toHaveLength(1)
  await cleanupStatus({ head: async (target: string) => {
   const object = await media.head(target)
   if (target === key) { const current = await (await media.get(projectStateKey(slug)))!.json() as any; current.active = { publicationId: 'winner', snapshotId: 'winner', htmlKey: key, entry: 'README.md', title: '', expires_at: null }; await media.put(projectStateKey(slug), JSON.stringify(current)) }
   return object
  } } as Partial<R2Bucket>)
  expect(await media.head(key)).not.toBeNull()
  expect((await (await media.get(projectStateKey(slug)))!.json() as any).retired).toHaveLength(1)
 })
 it('returns cleanup_progress at the retirement threshold without creating another MPU', async () => {
  await begin()
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  state.retired = Array.from({ length: 7 }, (_, i) => ({ sessionId: `retired${i}`, artifacts: [{ key: `project-share/${slug}/retired/${i}` }] }))
  await media.put(projectStateKey(slug), JSON.stringify(state))
  let creates = 0
  const wrapped = { get: media.get.bind(media), head: media.head.bind(media), delete: media.delete.bind(media), put: media.put.bind(media), async createMultipartUpload() { creates++; throw new Error('must not create') } } as unknown as R2Bucket
  const response = await worker.fetch(new Request(base + 'begin', { method: 'POST', headers: auth, body: JSON.stringify({ edit_token: token, project_id: 'project', feedback_token_hash: 'b'.repeat(64), publicationId: 'pub', previousPublicationId: null, sessionId: 'replacement', replaceSessionId: 'session', phase: 'entry', snapshotId: 'entry', entry: 'README.md', title: 'Project', expires_in_seconds: 3600, artifacts: [plan] }) }), { ...bindings, MEDIA: wrapped })
  expect(response.status).toBe(409); expect((await response.json() as any).error).toBe('cleanup_progress')
  expect(creates).toBe(0)
  const after = await (await media.get(projectStateKey(slug)))!.json() as any
  expect(after.upload.sessionId).toBe('session'); expect(after.retired).toHaveLength(6)
  expect((await begin({ sessionId: 'replacement', replaceSessionId: 'session' })).status).toBe(200)
 })
 it('keeps exact retirement records when cleanup loses its progress CAS', async () => {
  await begin()
  const key = `project-share/${slug}/retired/cas`
  await media.put(key, 'obsolete')
  const state = await (await media.get(projectStateKey(slug)))!.json() as any
  state.retired = [{ sessionId: 'retired', artifacts: [{ key }] }]
  await media.put(projectStateKey(slug), JSON.stringify(state))
  const { response } = await cleanupStatus({ put: async (target: string, value: any, options: any) => {
   const winner = await (await media.get(projectStateKey(slug)))!.json() as any
   winner.publicationId = 'winner'
   await media.put(projectStateKey(slug), JSON.stringify(winner))
   return media.put(target, value, options)
  } } as Partial<R2Bucket>)
  expect((await response.json() as any).publicationId).toBe('winner')
  const after = await (await media.get(projectStateKey(slug)))!.json() as any
  expect(after.publicationId).toBe('winner'); expect(after.retired[0].artifacts).toEqual([{ key }])
  expect((await cleanupStatus()).response.status).toBe(200)
  expect((await (await media.get(projectStateKey(slug)))!.json() as any).retired).toEqual([])
 })
 it('checks same-publication revocation and expiry before threshold cleanup', async () => {
  await begin()
  const original = await (await media.get(projectStateKey(slug)))!.json() as any
  for (const guard of [{ revoked: true }, { publication_expires_at: '2000-01-01T00:00:00.000Z' }]) {
   const state = { ...original, ...guard, retired: Array.from({ length: 7 }, (_, i) => ({ sessionId: `retired${i}`, artifacts: [{ key: `project-share/${slug}/retired/${i}` }] })) }
   await media.put(projectStateKey(slug), JSON.stringify(state))
   const calls: string[] = []
   const wrapped = { get(key: string) { calls.push('get'); return media.get(key) },
    head: async () => { throw new Error('must not HEAD') }, delete: async () => { throw new Error('must not delete') },
    put: async () => { throw new Error('must not CAS') }, createMultipartUpload: async () => { throw new Error('must not create') },
   } as unknown as R2Bucket
   const response = await worker.fetch(new Request(base + 'begin', { method: 'POST', headers: auth, body: JSON.stringify({ edit_token: token, project_id: 'project', feedback_token_hash: 'b'.repeat(64), publicationId: 'pub', previousPublicationId: null, sessionId: 'session', phase: 'entry', snapshotId: 'entry', entry: 'README.md', title: 'Project', expires_in_seconds: 3600, artifacts: [plan] }) }), { ...bindings, MEDIA: wrapped })
   expect(response.status).toBe(410); expect(calls).toEqual(['get'])
   expect((await (await media.get(projectStateKey(slug)))!.json() as any).retired).toHaveLength(7)
  }
 })
 it('revalidates revoke after native creation and aborts the never-registered upload', async () => {
  let created: R2MultipartUpload | undefined
  const wrapped = { get: media.get.bind(media), head: media.head.bind(media), put: media.put.bind(media), delete: media.delete.bind(media), resumeMultipartUpload: media.resumeMultipartUpload.bind(media),
   async createMultipartUpload(key: string, options: any) {
    created = await media.createMultipartUpload(key, options)
    await SELF.fetch('http://x/' + slug, { method: 'DELETE', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ edit_token: token }) })
    return created
   },
  } as unknown as R2Bucket
  const response = await worker.fetch(new Request(base + 'begin', { method: 'POST', headers: auth, body: JSON.stringify({ edit_token: token, project_id: 'project', feedback_token_hash: 'b'.repeat(64), publicationId: 'pub', previousPublicationId: null, sessionId: 'session', phase: 'entry', snapshotId: 'entry', entry: 'README.md', title: 'Project', expires_in_seconds: 3600, artifacts: [plan] }) }), { ...bindings, MEDIA: wrapped })
  expect(response.status).toBe(410)
  expect((await (await media.get(projectStateKey(slug)))!.json() as any).revoked).toBe(true)
  await expect(created!.uploadPart(1, 'hello')).rejects.toThrow()
 })
 it('keeps the uploadId registration CAS fence after its fresh read', async () => {
  let intercepted = false, created: R2MultipartUpload | undefined
  const wrapped = { get: media.get.bind(media), head: media.head.bind(media), delete: media.delete.bind(media), resumeMultipartUpload: media.resumeMultipartUpload.bind(media),
   async createMultipartUpload(key: string, options: any) { created = await media.createMultipartUpload(key, options); return created },
   async put(key: string, value: any, options: any) {
    if (!intercepted && key === projectStateKey(slug) && JSON.parse(value).upload?.artifacts[0].uploadId) {
     intercepted = true
     await SELF.fetch('http://x/' + slug, { method: 'DELETE', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ edit_token: token }) })
    }
    return media.put(key, value, options)
   },
  } as unknown as R2Bucket
  const response = await worker.fetch(new Request(base + 'begin', { method: 'POST', headers: auth, body: JSON.stringify({ edit_token: token, project_id: 'project', feedback_token_hash: 'b'.repeat(64), publicationId: 'pub', previousPublicationId: null, sessionId: 'session', phase: 'entry', snapshotId: 'entry', entry: 'README.md', title: 'Project', expires_in_seconds: 3600, artifacts: [plan] }) }), { ...bindings, MEDIA: wrapped })
  expect(response.status).toBe(409)
  expect((await (await media.get(projectStateKey(slug)))!.json() as any).revoked).toBe(true)
  await expect(created!.uploadPart(1, 'hello')).rejects.toThrow()
 })

})
