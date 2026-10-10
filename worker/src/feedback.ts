import type { Env } from './index'
import { activeProjectMetadata, readProjectState } from './project'

export const FEEDBACK_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/
export const FEEDBACK_HASH_RE = /^[a-f0-9]{64}$/
const MAX_FEEDBACK_BYTES = 5 * 1024 * 1024
const PAGE_SIZE = 100

interface ProjectFeedback {
  schemaVersion: 1
  project_id: string
  snapshotId: string
  submissionId: string
  edits: { path: string; baseHash: string; afterMarkdown: string }[]
  annotations: { path: string; quote: string; comment: string; start?: number; end?: number }[]
  name?: string
}
interface FeedbackEnvelope {
  payload: ProjectFeedback
  requestHash: string
  receivedAt: string
}
interface ShareMetadata {
  project_id?: string
  feedback_token_hash?: string
  expires_at: string | null
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && FEEDBACK_ID_RE.test(value)
}
function relativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/^[\/]|[\\:\0]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
function offset(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}
function validPayload(value: unknown): value is ProjectFeedback {
  return record(value) && value.schemaVersion === 1
    && validId(value.project_id) && validId(value.snapshotId) && validId(value.submissionId)
    && (value.name === undefined || typeof value.name === 'string')
    && Array.isArray(value.edits) && value.edits.every(edit => record(edit)
      && relativePath(edit.path) && typeof edit.baseHash === 'string' && FEEDBACK_HASH_RE.test(edit.baseHash)
      && typeof edit.afterMarkdown === 'string')
    && Array.isArray(value.annotations) && value.annotations.every(note => record(note)
      && relativePath(note.path) && typeof note.quote === 'string' && typeof note.comment === 'string'
      && offset(note.start) && offset(note.end)
      && (note.start === undefined || note.end === undefined || (note.end as number) >= (note.start as number)))
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('')
}

// Count bytes while reading: Content-Length can be missing or inaccurate.
async function readBody(req: Request): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('Content-Length'))
  if (declared > MAX_FEEDBACK_BYTES) return null
  if (!req.body) return new Uint8Array()
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_FEEDBACK_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function submitFeedback(req: Request, env: Env, slug: string): Promise<Response> {
  const project = await readProjectState(env, slug)
  const share = project ? null : await env.SHARES.getWithMetadata<ShareMetadata>(slug)
  const meta = project ? activeProjectMetadata(project.state) : share?.value ? share.metadata : null
  if (!meta) return new Response('Share expired', { status: 410 })
  if (meta.expires_at !== null && !(Date.parse(meta.expires_at) > Date.now())) {
    return new Response('Share expired', { status: 410 })
  }
  const token = req.headers.get('X-Feedback-Token')
  if (!validId(meta.project_id) || !meta.feedback_token_hash || !token
    || await sha256(new TextEncoder().encode(token)) !== meta.feedback_token_hash) {
    return new Response('Forbidden', { status: 403 })
  }
  const bytes = await readBody(req)
  if (!bytes) return new Response('Feedback exceeds 5 MiB', { status: 413 })
  let payload: unknown
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) }
  catch { return new Response('Bad JSON', { status: 400 }) }
  if (!validPayload(payload)) return new Response('Invalid feedback', { status: 400 })
  if (payload.project_id !== meta.project_id) return new Response('Forbidden', { status: 403 })

  const envelope: FeedbackEnvelope = {
    payload, requestHash: await sha256(bytes), receivedAt: new Date().toISOString(),
  }
  const key = `feedback/${payload.project_id}/${payload.submissionId}.json`
  // R2's conditional create is atomic, including across concurrent isolates.
  const created = await env.MEDIA.put(key, JSON.stringify(envelope), {
    onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
  })
  if (created) return Response.json(envelope)
  const original = await env.MEDIA.get(key)
  if (!original) return new Response('Retry feedback submission', { status: 503 })
  const receipt = await original.json<FeedbackEnvelope>()
  if (receipt.requestHash !== envelope.requestHash) return new Response('Submission conflict', { status: 409 })
  return Response.json(receipt)
}

async function listFeedback(env: Env, url: URL): Promise<Response> {
  const projectId = url.searchParams.get('project_id')
  if (!validId(projectId)) return new Response('Invalid project_id', { status: 400 })
  let cursor: string | undefined
  const cursorArg = url.searchParams.get('cursor')
  if (cursorArg !== null) {
    try {
      const parsed: unknown = JSON.parse(atob(cursorArg))
      if (!record(parsed) || parsed.project_id !== projectId || typeof parsed.cursor !== 'string' || !parsed.cursor) {
        return new Response('Invalid cursor', { status: 400 })
      }
      cursor = parsed.cursor
    } catch { return new Response('Invalid cursor', { status: 400 }) }
  }
  let page: R2Objects
  try { page = await env.MEDIA.list({ prefix: `feedback/${projectId}/`, limit: PAGE_SIZE, cursor }) }
  catch { return new Response('Invalid cursor', { status: 400 }) }
  // List keys only: 100 full 5 MiB submissions would exceed Worker memory.
  // The owner downloads unseen submissions through the single-object route.
  const prefix = `feedback/${projectId}/`
  const items = page.objects.flatMap(object => {
    const submissionId = object.key.slice(prefix.length).replace(/\.json$/, '')
    return object.key.endsWith('.json') && validId(submissionId) ? [{ submissionId }] : []
  })
  return Response.json({
    items,
    ...(page.truncated ? { cursor: btoa(JSON.stringify({ project_id: projectId, cursor: page.cursor })) } : {}),
  })
}

export async function handleFeedback(req: Request, env: Env, url: URL): Promise<Response> {
  const parts = url.pathname.slice(1).split('/')
  if (req.method === 'POST' && parts.length === 2 && parts[1]) return submitFeedback(req, env, parts[1])
  if (req.method === 'GET') {
    if (req.headers.get('Authorization') !== `Bearer ${env.SHARE_API_KEY}`) {
      return new Response('Unauthorized', { status: 401 })
    }
    if (parts.length === 1) return listFeedback(env, url)
    if (parts.length !== 3 || !validId(parts[1]) || !validId(parts[2])) {
      return new Response('Invalid feedback path', { status: 400 })
    }
    const object = await env.MEDIA.get(`feedback/${parts[1]}/${parts[2]}.json`)
    return object ? Response.json(await object.json<FeedbackEnvelope>()) : new Response('Not Found', { status: 404 })
  }
  return new Response('Not Found', { status: 404 })
}
