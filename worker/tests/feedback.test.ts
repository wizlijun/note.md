import { beforeEach, describe, expect, it } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import worker, { type Env } from '../src/index'

const bindings = env as unknown as Env
const AUTH = { Authorization: 'Bearer test-key' }
const SLUG = '2026-10-10-project-share'
const PROJECT = 'project_01'
const TOKEN = 'visitor-secret-token'
const MAX_BYTES = 5 * 1024 * 1024
const payload = (submissionId = 'submission_01') => ({
  schemaVersion: 1, project_id: PROJECT, snapshotId: 'snapshot_01', submissionId,
  edits: [{ path: '文档/README.md', baseHash: 'a'.repeat(64), afterMarkdown: '# Changed' }],
  annotations: [{ path: '文档/README.md', quote: 'Before', comment: 'Comment', start: 0, end: 6 }],
  name: 'Visitor',
})
async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('')
}
async function publish(metadata: Record<string, unknown> = {}) {
  return SELF.fetch('http://x/publish', {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, edit_token: 'a'.repeat(32), html: '<p>Project</p>', metadata }),
  })
}
function submit(body: unknown = payload(), token: string | null = TOKEN, extraHeaders = {}) {
  return SELF.fetch(`http://x/feedback/${SLUG}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { 'X-Feedback-Token': token }), ...extraHeaders },
    body: JSON.stringify(body),
  })
}
async function storedKeys() {
  return (await bindings.MEDIA.list({ prefix: `feedback/${PROJECT}/` })).objects.map(o => o.key)
}

beforeEach(async () => {
  expect((await publish({ project_id: PROJECT, feedback_token_hash: await hash(TOKEN) })).status).toBe(200)
})

describe('project publish metadata', () => {
  it('confirms the project expiry and honors explicit never without altering legacy TTL', async () => {
    const body = { slug: SLUG, edit_token: 'a'.repeat(32), html: '<p>Project</p>', expires_in_seconds: null,
      metadata: { project_id: PROJECT, feedback_token_hash: await hash(TOKEN) } }
    const response = await SELF.fetch('http://x/publish', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await response.json() as any).expires_at).toBeNull()
    expect((await bindings.SHARES.getWithMetadata<Record<string, unknown>>(SLUG)).metadata?.expires_at).toBeNull()
    expect((await submit()).status).toBe(200)
    const legacy = await SELF.fetch('http://x/publish', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, metadata: {} }) })
    expect((await legacy.json() as any).expires_at).toBeUndefined()
    expect((await bindings.SHARES.getWithMetadata<Record<string, unknown>>(SLUG)).metadata?.expires_at).toBeTypeOf('string')
  })
  it('persists the project and token hash without changing legacy defaults', async () => {
    const share = await bindings.SHARES.getWithMetadata<Record<string, unknown>>(SLUG)
    expect(share.metadata?.project_id).toBe(PROJECT)
    expect(share.metadata?.feedback_token_hash).toBe(await hash(TOKEN))
    expect(JSON.stringify(share.metadata)).not.toContain(TOKEN)
    expect((await publish()).status).toBe(200)
    expect((await bindings.SHARES.getWithMetadata<Record<string, unknown>>(SLUG)).metadata?.project_id).toBeUndefined()
    expect((await submit()).status).toBe(403)
  })
  it.each([
    { project_id: PROJECT }, { feedback_token_hash: 'a'.repeat(64) },
    { project_id: '../escape', feedback_token_hash: 'a'.repeat(64) },
    { project_id: PROJECT, feedback_token_hash: 'not-a-hash' },
    { project_id: PROJECT, feedback_token_hash: null },
  ])('rejects invalid or partial metadata %j', async metadata => {
    expect((await publish(metadata)).status).toBe(400)
    expect((await submit()).status).toBe(200)
  })
})

describe('feedback authorization and envelopes', () => {
  it('requires the current visitor token and permits owner list/download only', async () => {
    expect((await submit(payload(), 'wrong')).status).toBe(403)
    expect((await submit(payload(), null)).status).toBe(403)
    expect(await storedKeys()).toEqual([])
    const r = await submit()
    expect(r.status).toBe(200)
    const receipt = await r.json() as { payload: ReturnType<typeof payload>; requestHash: string; receivedAt: string }
    expect(receipt.payload).toEqual(payload())
    expect(receipt.requestHash).toBe(await hash(JSON.stringify(payload())))
    expect(Number.isNaN(Date.parse(receipt.receivedAt))).toBe(false)
    const list = await SELF.fetch(`http://x/feedback?project_id=${PROJECT}`, { headers: AUTH })
    expect(await list.json()).toEqual({ items: [{ submissionId: receipt.payload.submissionId }] })
    const download = await SELF.fetch(`http://x/feedback/${PROJECT}/submission_01`, { headers: AUTH })
    expect(await download.json()).toEqual(receipt)
    for (const url of [`http://x/feedback?project_id=${PROJECT}`, `http://x/feedback/${PROJECT}/submission_01`]) {
      expect((await SELF.fetch(url, { headers: { 'X-Feedback-Token': TOKEN } })).status).toBe(401)
      expect((await SELF.fetch(url, { headers: { Authorization: 'Bearer wrong-owner' } })).status).toBe(401)
    }
    expect(await storedKeys()).toEqual([`feedback/${PROJECT}/submission_01.json`])
  })
  it('keeps visitor credentials out of publish and rejects rotated tokens', async () => {
    expect((await SELF.fetch('http://x/publish', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{}' })).status).toBe(401)
    await publish({ project_id: PROJECT, feedback_token_hash: await hash('new-token') })
    expect((await submit()).status).toBe(403)
    expect((await submit(payload(), 'new-token')).status).toBe(200)
  })
  it('rejects expired and missing shares even with a formerly valid token', async () => {
    const share = await bindings.SHARES.getWithMetadata<Record<string, unknown>>(SLUG)
    await bindings.SHARES.put(SLUG, share.value!, { metadata: { ...share.metadata, expires_at: '2000-01-01T00:00:00.000Z' } })
    expect((await submit()).status).toBe(410)
    await bindings.SHARES.delete(SLUG)
    expect((await submit()).status).toBe(410)
    expect(await storedKeys()).toEqual([])
  })
  it('rejects cross-project submissions and isolates owner project prefixes', async () => {
    expect((await submit({ ...payload(), project_id: 'other_project' })).status).toBe(403)
    await submit()
    expect(await (await SELF.fetch('http://x/feedback?project_id=project_0', { headers: AUTH })).json()).toEqual({ items: [] })
    expect((await SELF.fetch('http://x/feedback/other_project/submission_01', { headers: AUTH })).status).toBe(404)
  })
  it('does not trust an unknown snapshot or base hash as an applicable local edit', async () => {
    expect((await submit({ ...payload(), snapshotId: 'unknown_snapshot', edits: [{ ...payload().edits[0], baseHash: 'b'.repeat(64) }] })).status).toBe(200)
  })
  it('allows feedback preflight and includes CORS on success and failure', async () => {
    const preflight = await SELF.fetch(`http://x/feedback/${SLUG}`, { method: 'OPTIONS', headers: { Origin: 'https://viewer.example', 'Access-Control-Request-Headers': 'X-Feedback-Token,Content-Type' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('x-feedback-token')
    for (const r of [await submit(), await submit(payload(), 'wrong'), await SELF.fetch('http://x/feedback?project_id=bad')]) {
      expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*')
    }
  })
})

describe('immutable feedback retries', () => {
  it('returns the exact original envelope for repeated bytes and 409 for changed bytes', async () => {
    const first = await (await submit()).json()
    const repeated = await (await submit()).json()
    expect(repeated).toEqual(first)
    expect((await submit({ ...payload(), name: 'Changed' })).status).toBe(409)
    expect(await (await bindings.MEDIA.get(`feedback/${PROJECT}/submission_01.json`))!.json()).toEqual(first)
  })
  it('conditionally creates only one original envelope under concurrent matching retries', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => submit()))
    expect(responses.map(r => r.status)).toEqual(Array(8).fill(200))
    const receipts = await Promise.all(responses.map(r => r.json()))
    expect(receipts.every(r => JSON.stringify(r) === JSON.stringify(receipts[0]))).toBe(true)
    expect(await storedKeys()).toHaveLength(1)
  })
  it('never overwrites a concurrent submission with different content', async () => {
    const responses = await Promise.all([submit(), submit({ ...payload(), name: 'Different' })])
    expect(responses.map(r => r.status).sort()).toEqual([200, 409])
    expect(await storedKeys()).toHaveLength(1)
  })
})

describe('feedback validation and size guard', () => {
  it.each(['../secret.md', '/absolute.md', 'a/../../b.md', 'a\\b.md', 'C:/a.md', 'a//b.md', './a.md', 'a/./b.md', 'a\0b.md'])('rejects unsafe relative path %s', async path => {
    expect((await submit({ ...payload(), edits: [{ ...payload().edits[0], path }] })).status).toBe(400)
    expect((await submit({ ...payload(), annotations: [{ ...payload().annotations[0], path }] })).status).toBe(400)
    expect(await storedKeys()).toEqual([])
  })
  it.each([
    null, [], { ...payload(), schemaVersion: 2 }, { ...payload(), submissionId: '../escape' },
    { ...payload(), snapshotId: 'a/b' }, { ...payload(), edits: null }, { ...payload(), annotations: {} },
    { ...payload(), name: 42 }, { ...payload(), edits: [{ path: 'a.md', baseHash: 'bad', afterMarkdown: 2 }] },
    { ...payload(), annotations: [{ path: 'a.md', quote: 1, comment: 'text' }] },
    { ...payload(), annotations: [{ path: 'a.md', quote: '', comment: '', start: -1 }] },
    { ...payload(), annotations: [{ path: 'a.md', quote: '', comment: '', start: 3, end: 2 }] },
  ])('rejects malformed feedback %j', async body => {
    expect((await submit(body)).status).toBe(400)
    expect(await storedKeys()).toEqual([])
  })
  it('rejects bad JSON', async () => {
    expect((await SELF.fetch(`http://x/feedback/${SLUG}`, { method: 'POST', headers: { 'X-Feedback-Token': TOKEN }, body: '{bad' })).status).toBe(400)
  })
  it('accepts exactly 5 MiB and rejects larger streamed bodies without Content-Length', async () => {
    const original = JSON.stringify(payload())
    const bytes = new TextEncoder().encode(original).byteLength
    const exact = original + ' '.repeat(MAX_BYTES - bytes)
    expect((await SELF.fetch(`http://x/feedback/${SLUG}`, { method: 'POST', headers: { 'X-Feedback-Token': TOKEN }, body: exact })).status).toBe(200)
    const chunks = [new TextEncoder().encode(exact), new Uint8Array([32])]
    const body = new ReadableStream<Uint8Array>({ pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close() } })
    expect((await SELF.fetch(`http://x/feedback/${SLUG}`, { method: 'POST', headers: { 'X-Feedback-Token': TOKEN }, body })).status).toBe(413)
    expect(await storedKeys()).toHaveLength(1)
  })
  it('cancels an oversized stream even when Content-Length understates it', async () => {
    let pulled = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024 * 1024)) },
      cancel() { cancelled = true },
    })
    const req = new Request(`http://x/feedback/${SLUG}`, {
      method: 'POST', headers: { 'X-Feedback-Token': TOKEN, 'Content-Length': '1' }, body,
    })
    expect((await worker.fetch(req, bindings)).status).toBe(413)
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThanOrEqual(7)
    expect(await storedKeys()).toEqual([])
  })
  it('rejects a declared oversized body before parsing', async () => {
    expect((await submit(payload(), TOKEN, { 'Content-Length': String(MAX_BYTES + 1) })).status).toBe(413)
    expect(await storedKeys()).toEqual([])
  })
})

describe('owner feedback pagination', () => {
  it('paginates immutable envelopes without leaking another project', async () => {
    for (let i = 0; i < 101; i++) {
      const p = payload(`submission_${String(i).padStart(3, '0')}`)
      await bindings.MEDIA.put(`feedback/${PROJECT}/${p.submissionId}.json`, JSON.stringify({ payload: p, requestHash: 'a'.repeat(64), receivedAt: '2026-10-10T00:00:00.000Z' }))
    }
    await bindings.MEDIA.put('feedback/other/submission_01.json', '{}')
    const first = await (await SELF.fetch(`http://x/feedback?project_id=${PROJECT}`, { headers: AUTH })).json() as { items: unknown[]; cursor: string }
    expect(first.items).toHaveLength(100)
    expect(first.cursor).toBeTypeOf('string')
    const second = await (await SELF.fetch(`http://x/feedback?project_id=${PROJECT}&cursor=${encodeURIComponent(first.cursor)}`, { headers: AUTH })).json() as { items: { submissionId: string }[]; cursor?: string }
    expect(second.items).toHaveLength(1)
    expect(second.items[0]).toEqual({ submissionId: 'submission_100' })
    expect(second.cursor).toBeUndefined()
    expect((await SELF.fetch(`http://x/feedback?project_id=other&cursor=${encodeURIComponent(first.cursor)}`, { headers: AUTH })).status).toBe(400)
    expect((await SELF.fetch(`http://x/feedback?project_id=${PROJECT}&cursor=garbage`, { headers: AUTH })).status).toBe(400)
  })
  it.each(['http://x/feedback', 'http://x/feedback?project_id=../bad', 'http://x/feedback/project_01/bad%2Fid'])('rejects unsafe owner routing %s', async url => {
    expect((await SELF.fetch(url, { headers: AUTH })).status).toBe(400)
  })
})
