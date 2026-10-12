import type { Env } from './index'
import type { ProjectReceipt } from '../../src/lib/project-share/types'
import { FEEDBACK_ID_RE } from './feedback'
import { activeProjectMetadata, readProjectState } from './project'
import { boundedBody, digest, projectPath } from './project-zip'

const MAX_RECEIPT_BYTES = 65536
const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }
const FILE_OUTCOMES = ['accepted', 'partial', 'rejected', 'forwarded']
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && FEEDBACK_ID_RE.test(value)
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function validReceipt(value: unknown, projectId: string, submissionId: string): value is ProjectReceipt {
  if (!record(value) || !keys(value, ['schemaVersion', 'project_id', 'submissionId', 'decidedAt', 'outcome', 'files', 'annotations', 'reply', 'includedInSnapshotId'])
    || value.schemaVersion !== 1 || !validId(value.project_id) || value.project_id !== projectId
    || !validId(value.submissionId) || value.submissionId !== submissionId
    || typeof value.decidedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value.decidedAt) || !Number.isFinite(Date.parse(value.decidedAt))
    || typeof value.outcome !== 'string' || ![...FILE_OUTCOMES, 'superseded'].includes(value.outcome)
    || !Array.isArray(value.files) || !value.files.every(file => record(file)
      && keys(file, ['path', 'outcome', 'accepted', 'total']) && projectPath(file.path)
      && typeof file.outcome === 'string' && FILE_OUTCOMES.includes(file.outcome)
      && count(file.accepted) && count(file.total) && file.accepted <= file.total)
    || !record(value.annotations) || !keys(value.annotations, ['promoted', 'total'])
    || !count(value.annotations.promoted) || !count(value.annotations.total) || value.annotations.promoted > value.annotations.total
    || (Object.hasOwn(value, 'reply') && (typeof value.reply !== 'string' || value.reply.length > 2000))
    || (Object.hasOwn(value, 'includedInSnapshotId') && !validId(value.includedInSnapshotId))) return false
  return true
}
function response(message: string | null, status: number): Response {
  return new Response(message, { status, headers: HEADERS })
}

export async function handleReceipt(req: Request, env: Env, url: URL): Promise<Response> {
  const match = /^\/feedback\/([^/]+)\/receipt\/([^/]+)$/.exec(url.pathname)
  if (!match) return response('Not Found', 404)
  const [, slug, submissionId] = match
  if (!['GET', 'PUT', 'DELETE'].includes(req.method)) return response('Method Not Allowed', 405)
  if (req.method !== 'GET' && (!env.SHARE_API_KEY || req.headers.get('Authorization') !== `Bearer ${env.SHARE_API_KEY}`)) return response('Unauthorized', 401)
  if (!validId(submissionId)) return response('Invalid submissionId', 400)
  const loaded = await readProjectState(env, slug)
  if (req.method === 'GET') {
    const meta = loaded && activeProjectMetadata(loaded.state)
    if (!meta) return response('Share expired', 410)
    const token = req.headers.get('X-Feedback-Token')
    if (!token || !meta.feedback_token_hash || await digest(new TextEncoder().encode(token)) !== meta.feedback_token_hash) return response('Forbidden', 403)
    const object = await env.MEDIA.get(`receipts/${meta.project_id}/${submissionId}.json`)
    return object ? new Response(object.body, { headers: { ...HEADERS, 'Content-Type': 'application/json' } }) : response('Not Found', 404)
  }
  if (!loaded) return response('Not Found', 404)
  const projectId = loaded.state.project_id
  const key = `receipts/${projectId}/${submissionId}.json`
  if (req.method === 'DELETE') {
    await env.MEDIA.delete(key)
    return response(null, 204)
  }
  // Only check existence: the immutable feedback envelope remains opaque here.
  if (!await env.MEDIA.head(`feedback/${projectId}/${submissionId}.json`)) return response('Feedback not found', 404)
  let bytes: Uint8Array
  try { bytes = await boundedBody(req, MAX_RECEIPT_BYTES) }
  catch { return response('Receipt exceeds 64 KiB', 413) }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { return response('Bad JSON', 400) }
  if (!validReceipt(value, projectId, submissionId)) return response('Invalid receipt', 400)
  await env.MEDIA.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } })
  return response(null, 204)
}
