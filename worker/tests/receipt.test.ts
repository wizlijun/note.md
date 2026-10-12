import { beforeEach, describe, expect, it } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import worker, { type Env } from '../src/index'
import { projectStateKey, type ProjectState } from '../src/project'

const bindings = env as unknown as Env
const AUTH = { Authorization: 'Bearer test-key' }
const SLUG = '2026-10-13-receipt-project'
const PROJECT = 'p_fixture'
const TOKEN = 'visitor-receipt-token'
const url = `http://x/feedback/${SLUG}/receipt/s1`
const key = `receipts/${PROJECT}/s1.json`
const feedbackKey = `feedback/${PROJECT}/s1.json`
const receipt = () => ({
  schemaVersion: 1, project_id: PROJECT, submissionId: 's1', decidedAt: '2026-10-13T00:00:00Z',
  outcome: 'partial', files: [{ path: '文档/README.md', outcome: 'partial', accepted: 1, total: 2 }],
  annotations: { promoted: 0, total: 1 }, reply: '谢谢', includedInSnapshotId: 'snapshot_2',
})
async function hash(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('')
}
async function state(update: Partial<ProjectState> = {}) {
  const value: ProjectState = { schemaVersion: 2, publicationId: 'pub_1', project_id: PROJECT,
    edit_token_hash: await hash('a'.repeat(32)), feedback_token_hash: await hash(TOKEN), revoked: false,
    active: { publicationId: 'pub_1', snapshotId: 'snapshot_1', htmlKey: 'project-share/entry.html', entry: 'README.md', title: 'Project', expires_at: null }, ...update }
  await bindings.MEDIA.put(projectStateKey(SLUG), JSON.stringify(value))
  return value
}
async function request(method: string, body?: unknown, headers: Record<string, string> = AUTH, target = url) {
  const response = await SELF.fetch(target, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  return response
}
const get = (headers = { 'X-Feedback-Token': TOKEN }) => request('GET', undefined, headers)
const put = (body: unknown = receipt(), headers = AUTH) => request('PUT', body, headers)

beforeEach(async () => {
  await state()
  const payload = { schemaVersion: 1, project_id: PROJECT, snapshotId: 'snapshot_1', submissionId: 's1', edits: [], annotations: [] }
  await bindings.MEDIA.put(feedbackKey, JSON.stringify({ payload, requestHash: 'a'.repeat(64), receivedAt: '2026-10-13T00:00:00Z' }))
})

describe('independent collaboration receipts', () => {
  it('writes, reads exact JSON, replaces and idempotently deletes only the receipt', async () => {
    const originalFeedback = await (await bindings.MEDIA.get(feedbackKey))!.text()
    expect((await put()).status).toBe(204)
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual(receipt())
    expect(await (await bindings.MEDIA.get(key))!.json()).toEqual(receipt())
    expect(await (await SELF.fetch(`http://x/feedback?project_id=${PROJECT}`, { headers: AUTH })).json()).toEqual({ items: [{ submissionId: 's1' }] })
    expect((await put({ ...receipt(), reply: '更新' })).status).toBe(204)
    expect((await (await get()).json() as any).reply).toBe('更新')
    expect((await request('DELETE')).status).toBe(204)
    expect((await request('DELETE')).status).toBe(204)
    expect((await get()).status).toBe(404)
    expect(await (await bindings.MEDIA.get(feedbackKey))!.text()).toBe(originalFeedback)
  })
  it('keeps Bearer and visitor credentials separate and requires a configured owner key', async () => {
    for (const headers of [{}, { 'X-Feedback-Token': TOKEN }, { Authorization: 'Bearer wrong' }]) {
      expect((await put(receipt(), headers)).status).toBe(401)
      expect((await request('DELETE', undefined, headers)).status).toBe(401)
    }
    expect((await put()).status).toBe(204)
    for (const headers of [{}, AUTH, { 'X-Feedback-Token': 'wrong' }]) expect((await get(headers as any)).status).toBe(403)
    for (const method of ['PUT', 'DELETE']) {
      const response = await worker.fetch(new Request(url, { method, headers: { Authorization: 'Bearer ' }, ...(method === 'PUT' ? { body: JSON.stringify(receipt()) } : {}) }), { ...bindings, SHARE_API_KEY: '' })
      expect(response.status).toBe(401)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    }
  })
  it.each(['expired', 'revoked', 'no-active', 'missing'] as const)('gates visitor access for %s but permits owner maintenance of existing state', async kind => {
    await put()
    const value = await state()
    if (kind === 'missing') await bindings.MEDIA.delete(projectStateKey(SLUG))
    else await state(kind === 'revoked' ? { revoked: true } : kind === 'no-active' ? { active: null } : { active: { ...value.active!, expires_at: '2000-01-01T00:00:00Z' } })
    expect((await get()).status).toBe(410)
    expect((await put()).status).toBe(kind === 'missing' ? 404 : 204)
    expect((await request('DELETE')).status).toBe(kind === 'missing' ? 404 : 204)
  })
  it('persists both records after real revoke while blocking visitor access', async () => {
    await put()
    expect((await SELF.fetch(`http://x/${SLUG}`, { method: 'DELETE', headers: AUTH, body: JSON.stringify({ edit_token: 'a'.repeat(32) }) })).status).toBe(200)
    expect((await get()).status).toBe(410)
    expect(await bindings.MEDIA.head(key)).not.toBeNull()
    expect(await bindings.MEDIA.head(feedbackKey)).not.toBeNull()
    expect((await put()).status).toBe(204)
    expect((await request('DELETE')).status).toBe(204)
  })
  it('requires a feedback object in the slug project and does not read its content', async () => {
    await bindings.MEDIA.delete(feedbackKey)
    await bindings.MEDIA.put('feedback/other/s1.json', '{}')
    expect((await put()).status).toBe(404)
    await bindings.MEDIA.put(feedbackKey, 'opaque feedback envelope')
    expect((await put()).status).toBe(204)
  })
  it('returns CORS for preflight and unsupported methods', async () => {
    const response = await request('OPTIONS', undefined, {})
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('PUT')
    expect(response.headers.get('Allow')).toContain('PUT')
    expect((await request('POST', receipt())).status).toBe(405)
  })
})

describe('receipt strict validation', () => {
  const base = receipt()
  it.each([
    null, [], { ...base, schemaVersion: 2 }, { ...base, project_id: 'other' }, { ...base, submissionId: 'other' },
    { ...base, project_id: '../bad' }, { ...base, submissionId: 'a/b' }, { ...base, includedInSnapshotId: 'a/b' },
    { ...base, outcome: 'branched' }, { ...base, afterMarkdown: 'private' }, { ...base, annotations: { ...base.annotations, quote: 'private' } },
    { ...base, files: [{ ...base.files[0], comment: 'private' }] }, { ...base, files: [{ ...base.files[0], outcome: 'superseded' }] },
    { ...base, files: null }, { ...base, annotations: [] }, { ...base, reply: 1 }, { ...base, reply: '😀'.repeat(1001) },
    ...['not-a-date', '2026-10-13', '2026-10-13T00:00:00+00:00', '2026-13-01T00:00:00Z'].map(decidedAt => ({ ...base, decidedAt })),
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null].flatMap(count => [
      { ...base, files: [{ ...base.files[0], accepted: count }] }, { ...base, files: [{ ...base.files[0], total: count }] },
      { ...base, annotations: { ...base.annotations, promoted: count } }, { ...base, annotations: { ...base.annotations, total: count } },
    ]),
    { ...base, files: [{ ...base.files[0], accepted: 3 }] }, { ...base, annotations: { promoted: 2, total: 1 } },
    ...['../a.md', '/a.md', 'C:/a.md', 'a\\b.md', 'a//b.md', 'a/./b.md', 'a\0b.md'].map(path => ({ ...base, files: [{ ...base.files[0], path }] })),
  ])('rejects invalid body %#', async body => {
    expect((await put(body)).status).toBe(400)
    expect(await bindings.MEDIA.head(key)).toBeNull()
  })
  it('accepts all outcomes, zero safe counts and optional fields absent', async () => {
    for (const outcome of ['accepted', 'partial', 'rejected', 'superseded', 'forwarded']) {
      expect((await put({ schemaVersion: 1, project_id: PROJECT, submissionId: 's1', decidedAt: '2026-10-13T00:00:00.123Z', outcome,
        files: [], annotations: { promoted: 0, total: 0 } })).status).toBe(204)
    }
    expect((await put({ ...receipt(), reply: '😀'.repeat(1000), files: [{ path: 'README.md', outcome: 'forwarded', accepted: 0, total: Number.MAX_SAFE_INTEGER }] })).status).toBe(204)
  })
  it('rejects bad JSON and malformed receipt IDs', async () => {
    const response = await SELF.fetch(url, { method: 'PUT', headers: AUTH, body: '{bad' })
    expect(response.status).toBe(400)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect((await request('PUT', receipt(), AUTH, url.replace('/s1', '/bad%2Fid'))).status).toBe(400)
  })
  it('accepts exactly 64 KiB and rejects larger streamed or declared bodies', async () => {
    const json = JSON.stringify(receipt())
    const exact = json + ' '.repeat(65536 - new TextEncoder().encode(json).byteLength)
    expect((await SELF.fetch(url, { method: 'PUT', headers: AUTH, body: exact })).status).toBe(204)
    const declared = await SELF.fetch(url, { method: 'PUT', headers: { ...AUTH, 'Content-Length': '65537' }, body: json })
    expect(declared.status).toBe(413)
    expect(declared.headers.get('Access-Control-Allow-Origin')).toBe('*')
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(32768)) }, cancel() { cancelled = true } })
    const streamed = await worker.fetch(new Request(url, { method: 'PUT', headers: { ...AUTH, 'Content-Length': '1' }, body }), bindings)
    expect(streamed.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(streamed.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})
