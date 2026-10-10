import type { Env } from './index'
import { boundedBody, digest, MAX_FILE_BYTES, MAX_ZIP_BYTES, projectPath, validateProjectZip } from './project-zip'

const SLUG = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?$/
const ID = /^[a-zA-Z0-9_-]{1,128}$/
const TOKEN = /^[a-zA-Z0-9]{16,128}$/
const validId = (value: unknown): value is string => typeof value === 'string' && ID.test(value)
function parseLegacySnapshotId(html: string, projectId: string): string {
  try {
    const raw = /<script\b[^>]*\bid=["']project-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)
    const snapshot = raw && JSON.parse(raw[1]).snapshot
    if (snapshot?.project_id === projectId && validId(snapshot.snapshotId)) return snapshot.snapshotId
  } catch { /* Older pages may not expose a structured snapshot. */ }
  return 'legacy'
}
interface Version {
  publicationId: string
  snapshotId: string
  htmlKey: string
  archiveKey?: string
  archiveHash?: string
  ready?: boolean
  entry: string
  title: string
  expires_at: string | null
}
interface Pending {
  publicationId: string
  snapshotId: string
  entryHash: string
  entry: string
  title: string
  expires_at: string | null
}
export interface ProjectState {
  schemaVersion: 1
  publicationId: string
  project_id: string
  edit_token_hash: string
  feedback_token_hash: string
  revoked: boolean
  active: Version
  pending?: Pending
  entry?: Pending
  cleanup?: string[]
  attempt?: { snapshotId: string; archiveKey: string; htmlKey: string }
  created_at?: string
}
interface Loaded { state: ProjectState; etag: string }
export const projectStateKey = (slug: string) => `project-share/${slug}/state.json`
function versionKey(slug: string, publicationId: string, snapshotId: string, name: string): string {
  return `project-share/${slug}/${publicationId}/${snapshotId}/${name}`
}
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
export async function readProjectState(env: Env, slug: string): Promise<Loaded | null> {
  if (!SLUG.test(slug)) return null
  const object = await env.MEDIA.get(projectStateKey(slug))
  if (!object) return null
  const state = await object.json<ProjectState>()
  if (state.schemaVersion !== 1 || !ID.test(state.publicationId) || !state.active || typeof state.revoked !== 'boolean') throw new Error('invalid project share state')
  return { state, etag: object.etag }
}
function alive(expiry: string | null): boolean {
  return expiry === null || Date.parse(expiry) > Date.now()
}
export function activeProjectMetadata(state: ProjectState): { project_id: string; feedback_token_hash: string; expires_at: string | null } | null {
  return state.revoked || !alive(state.active.expires_at) ? null
    : { project_id: state.project_id, feedback_token_hash: state.feedback_token_hash, expires_at: state.active.expires_at }
}
async function checkOwner(state: ProjectState, token: unknown): Promise<void> {
  if (typeof token !== 'string' || !TOKEN.test(token) || await digest(new TextEncoder().encode(token)) !== state.edit_token_hash) throw new HttpError(403, 'Owner token mismatch')
}
async function writeState(env: Env, slug: string, state: ProjectState, etag?: string): Promise<void> {
  const result = await env.MEDIA.put(projectStateKey(slug), JSON.stringify(state), {
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
  })
  if (!result) throw new HttpError(409, 'Publication changed; retry with current state')
}
async function immutable(env: Env, key: string, bytes: Uint8Array, hash: string, contentType: string): Promise<boolean> {
  const created = await env.MEDIA.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' },
    customMetadata: { sha256: hash }, httpMetadata: { contentType } })
  if (created) return true
  const existing = await env.MEDIA.head(key)
  if (!existing || existing.customMetadata?.sha256 !== hash) throw new HttpError(409, 'Publication object differs from original')
  return false
}
function objectKeys(slug: string, state: ProjectState): string[] {
  return [state.active.htmlKey, state.active.archiveKey,
    state.attempt?.archiveKey, state.attempt?.htmlKey,
    state.pending && versionKey(slug, state.pending.publicationId, state.pending.snapshotId, 'entry.html')].filter((key): key is string => !!key)
}
// Never sweep prefixes: another request may have written an object but not committed.
async function cleanupKnown(env: Env, slug: string, keys: string[]): Promise<string[]> {
  const remaining: string[] = []
  for (const key of new Set(keys)) {
    try {
      const current = await readProjectState(env, slug)
      if (!current || !key.startsWith(`project-share/${slug}/`) || key === projectStateKey(slug)) { remaining.push(key); continue }
      const references = current.state.revoked ? [] : objectKeys(slug, current.state)
      if (references.includes(key) || (!current.state.revoked && current.state.pending
        && key.startsWith(`project-share/${slug}/${current.state.publicationId}/`))) { remaining.push(key); continue }
      await env.MEDIA.delete(key)
    } catch { remaining.push(key) }
  }
  return remaining
}
async function prepareCleanup(env: Env, slug: string, loaded: Loaded | null): Promise<void> {
  if (loaded?.state.cleanup?.length) loaded.state.cleanup = await cleanupKnown(env, slug, loaded.state.cleanup)
}
function queueCleanup(slug: string, state: ProjectState, before: ProjectState | undefined): void {
  const referenced = state.revoked ? [] : objectKeys(slug, state)
  state.cleanup = [...new Set([...(before?.cleanup ?? []), ...(before ? objectKeys(slug, before) : [])])].filter(key => !referenced.includes(key))
}
async function commit(env: Env, slug: string, state: ProjectState, loaded: Loaded | null, created: string[]): Promise<void> {
  queueCleanup(slug, state, loaded?.state)
  try { await writeState(env, slug, state, loaded?.etag) }
  catch (error) { await cleanupKnown(env, slug, created); throw error }
  await cleanupKnown(env, slug, state.cleanup ?? [])
}
function receipt(slug: string, state: ProjectState, baseUrl: string) {
  return { slug, url: `${baseUrl}/${slug}`, publicationId: state.publicationId,
    stage: state.active.archiveKey || state.active.ready ? 'ready' : 'entry', snapshotId: state.pending?.snapshotId ?? state.active.snapshotId,
    expires_at: state.pending ? state.pending.expires_at : state.active.expires_at,
    active: { publicationId: state.active.publicationId, snapshotId: state.active.snapshotId, expires_at: state.active.expires_at } }
}
async function entry(req: Request, env: Env, slug: string, baseUrl: string): Promise<Response> {
  let args: any
  // Let the runtime consume bounded JSON instead of retaining a second byte copy.
  let length = 0
  // A single source byte may be serialized as a six-character JSON escape.
  const limit = MAX_FILE_BYTES * 6 + 1024 * 1024
  if (Number(req.headers.get('Content-Length')) > limit) throw new HttpError(413, 'Entry body exceeds limit')
  const bounded = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
    length += chunk.byteLength
    if (length > limit) throw new HttpError(413, 'Entry body exceeds limit')
    controller.enqueue(chunk)
  } })
  try { args = await new Response(req.body?.pipeThrough(bounded)).json() }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid entry body') }
  if (!args || !validId(args.publicationId) || !validId(args.snapshotId) || !validId(args.project_id)
    || typeof args.edit_token !== 'string' || !TOKEN.test(args.edit_token) || !/^[a-f0-9]{64}$/.test(args.feedback_token_hash)
    || typeof args.html !== 'string' || !projectPath(args.entry) || typeof args.title !== 'string' || args.title.length > 1024
    || !(args.previousPublicationId === null || (typeof args.previousPublicationId === 'string' && ID.test(args.previousPublicationId)))
    || !(args.expires_in_seconds === null || (Number.isSafeInteger(args.expires_in_seconds) && args.expires_in_seconds >= 60))) throw new HttpError(400, 'Invalid entry metadata')
  const html = new TextEncoder().encode(args.html)
  args.html = undefined
  if (html.length > MAX_FILE_BYTES) throw new HttpError(413, 'HTML exceeds 25 MiB')
  const htmlHash = await digest(html), loaded = await readProjectState(env, slug)
  if (loaded) {
    await checkOwner(loaded.state, args.edit_token)
    await prepareCleanup(env, slug, loaded)
    if (loaded.state.project_id !== args.project_id || (loaded.state.feedback_token_hash && loaded.state.feedback_token_hash !== args.feedback_token_hash)) throw new HttpError(409, 'Project identity changed')
    if (loaded.state.publicationId === args.publicationId) {
      if (loaded.state.revoked || !alive(loaded.state.pending ? loaded.state.pending.expires_at : loaded.state.active.expires_at)) {
        await cleanupKnown(env, slug, [versionKey(slug, args.publicationId, args.snapshotId, 'entry.html')])
        throw new HttpError(410, 'Publication revoked or expired')
      }
      const original = loaded.state.entry ?? loaded.state.pending
      if (!original || original.snapshotId !== args.snapshotId || original.entryHash !== htmlHash || original.entry !== args.entry || original.title !== args.title) throw new HttpError(409, 'Entry differs from original')
      return Response.json(receipt(slug, loaded.state, baseUrl))
    }
    if (loaded.state.publicationId !== args.previousPublicationId) {
      await cleanupKnown(env, slug, [versionKey(slug, args.publicationId, args.snapshotId, 'entry.html')])
      throw new HttpError(409, 'Previous publication mismatch')
    }
  } else if (args.previousPublicationId !== null) throw new HttpError(409, 'Previous publication missing')
  const expiryTime = Date.now() + args.expires_in_seconds * 1000
  if (args.expires_in_seconds !== null && !Number.isFinite(new Date(expiryTime).getTime())) throw new HttpError(400, 'Invalid expiry')
  const expires_at = args.expires_in_seconds === null ? null : new Date(expiryTime).toISOString()
  const key = versionKey(slug, args.publicationId, args.snapshotId, 'entry.html')
  let active: Version = { publicationId: args.publicationId, snapshotId: args.snapshotId, htmlKey: key, entry: args.entry, title: args.title, expires_at }
  const created: string[] = []
  if (loaded && !loaded.state.revoked && (loaded.state.active.archiveKey || loaded.state.active.ready) && alive(loaded.state.active.expires_at)) active = loaded.state.active
  if (!loaded) {
    const legacy = await env.SHARES.getWithMetadata<{ edit_token?: string; project_id?: string; feedback_token_hash?: string; expires_at?: string | null }>(slug)
    if (legacy.value && legacy.metadata) {
      if (legacy.metadata.edit_token !== args.edit_token) throw new HttpError(403, 'Owner token mismatch')
      if (legacy.metadata.project_id && legacy.metadata.project_id !== args.project_id) throw new HttpError(409, 'Project identity changed')
      if (legacy.metadata.feedback_token_hash && legacy.metadata.feedback_token_hash !== args.feedback_token_hash) throw new HttpError(409, 'Feedback identity changed')
      if (legacy.metadata.project_id && alive(legacy.metadata.expires_at ?? null)) {
        const snapshotId = parseLegacySnapshotId(legacy.value, args.project_id)
        const legacyKey = versionKey(slug, args.publicationId, snapshotId, 'legacy.html'), legacyBytes = new TextEncoder().encode(legacy.value)
        if (await immutable(env, legacyKey, legacyBytes, await digest(legacyBytes), 'text/html; charset=utf-8')) created.push(legacyKey)
        active = { publicationId: 'legacy', snapshotId, htmlKey: legacyKey, ready: true, entry: args.entry, title: args.title, expires_at: legacy.metadata.expires_at ?? null }
      }
    }
  }
  if (await immutable(env, key, html, htmlHash, 'text/html; charset=utf-8')) created.push(key)
  const pending: Pending = { publicationId: args.publicationId, snapshotId: args.snapshotId, entryHash: htmlHash, entry: args.entry, title: args.title, expires_at }
  const state: ProjectState = { schemaVersion: 1, publicationId: args.publicationId, project_id: args.project_id,
    edit_token_hash: await digest(new TextEncoder().encode(args.edit_token)), feedback_token_hash: args.feedback_token_hash,
    revoked: false, active, pending, entry: pending, created_at: loaded?.state.created_at ?? new Date().toISOString() }
  await commit(env, slug, state, loaded, created)
  return Response.json(receipt(slug, state, baseUrl))
}
async function archive(req: Request, env: Env, slug: string, baseUrl: string): Promise<Response> {
  const publicationId = req.headers.get('X-Publication-Id') ?? '', snapshotId = req.headers.get('X-Snapshot-Id') ?? ''
  if (!ID.test(publicationId) || !ID.test(snapshotId)) throw new HttpError(400, 'Invalid publication identity')
  let loaded = await readProjectState(env, slug)
  if (!loaded) throw new HttpError(410, 'Publication missing')
  await checkOwner(loaded.state, req.headers.get('X-Edit-Token'))
  await prepareCleanup(env, slug, loaded)
  if (loaded.state.revoked || loaded.state.publicationId !== publicationId) {
    await cleanupKnown(env, slug, [versionKey(slug, publicationId, snapshotId, 'archive.zip'), versionKey(slug, publicationId, snapshotId, 'full.html')])
    throw new HttpError(loaded.state.revoked ? 410 : 409, loaded.state.revoked ? 'Publication revoked' : 'Publication superseded')
  }
  const pending = loaded.state.pending
  if (!alive(pending ? pending.expires_at : loaded.state.active.expires_at)) throw new HttpError(410, 'Publication expired')
  const archiveKey = versionKey(slug, publicationId, snapshotId, 'archive.zip'), htmlKey = versionKey(slug, publicationId, snapshotId, 'full.html')
  let bytes: Uint8Array
  try { bytes = await boundedBody(req, MAX_ZIP_BYTES) } catch { throw new HttpError(413, 'ZIP exceeds 32 MiB') }
  const hash = await digest(bytes)
  if (!pending) {
    if (loaded.state.active.snapshotId !== snapshotId || loaded.state.active.archiveHash !== hash) throw new HttpError(409, 'Archive differs from published package')
    return Response.json(receipt(slug, loaded.state, baseUrl))
  }
  if (pending.snapshotId === snapshotId) throw new HttpError(400, 'Full snapshot must differ from entry snapshot')
  let html: Uint8Array
  try { html = await validateProjectZip(bytes, loaded.state.project_id, snapshotId, pending.entry) }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid ZIP') }
  if (loaded.state.attempt && loaded.state.attempt.snapshotId !== snapshotId) throw new HttpError(409, 'Full snapshot differs from registered attempt')
  if (!loaded.state.attempt) {
    // Register only validated packages, before any put with a potentially unknown result.
    await writeState(env, slug, { ...loaded.state, attempt: { snapshotId, archiveKey, htmlKey } }, loaded.etag)
    loaded = await readProjectState(env, slug)
    if (!loaded || loaded.state.revoked || loaded.state.publicationId !== publicationId || !loaded.state.pending) throw new HttpError(409, 'Publication changed while registering archive')
  }
  const created: string[] = []
  try {
    if (await immutable(env, archiveKey, bytes, hash, 'application/zip')) created.push(archiveKey)
    if (await immutable(env, htmlKey, html, await digest(html), 'text/html; charset=utf-8')) created.push(htmlKey)
  } catch (error) { await cleanupKnown(env, slug, created); throw error }
  const state: ProjectState = { ...loaded.state, active: { publicationId, snapshotId, htmlKey, archiveKey, archiveHash: hash,
    entry: pending.entry, title: pending.title, expires_at: pending.expires_at } }
  delete state.pending
  delete state.attempt
  await commit(env, slug, state, loaded, created)
  return Response.json(receipt(slug, state, baseUrl))
}
export async function publicProject(env: Env, slug: string, download = false, head = false, retried = false): Promise<Response | null> {
  const loaded = await readProjectState(env, slug)
  if (!loaded) return null
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }
  if (!activeProjectMetadata(loaded.state)) return new Response('Share expired', { status: 410, headers })
  const version = loaded.state.active
  if (download && !version.archiveKey) return new Response('Complete package not ready', { status: 409, headers })
  const object = head ? await env.MEDIA.head(download ? version.archiveKey! : version.htmlKey) : await env.MEDIA.get(download ? version.archiveKey! : version.htmlKey)
  if (!object) {
    if (!retried) return publicProject(env, slug, download, head, true)
    return new Response('Publication object unavailable', { status: 503, headers })
  }
  return new Response(head ? null : (object as R2ObjectBody).body, { headers: { ...headers,
    'Content-Type': download ? 'application/zip' : 'text/html; charset=utf-8', 'Content-Length': String(object.size),
    ...(download ? { 'Content-Disposition': `attachment; filename="project.zip"; filename*=UTF-8''${encodeURIComponent(version.title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') + '.zip')}`, 'X-Content-Type-Options': 'nosniff' } : {}) } })
}
interface RevokeInput { publicationId?: unknown; previousPublicationId?: unknown; project_id?: unknown; entrySnapshotId?: unknown; legacySnapshotId?: unknown }
export async function revokeProject(env: Env, slug: string, token: string, input: RevokeInput = {}): Promise<{ status: number; publicationId?: string } | null> {
  if (!SLUG.test(slug)) return { status: 400 }
  const requested = input.publicationId
  if (requested !== undefined && (!validId(requested) || !validId(input.project_id)
    || !(input.previousPublicationId === null || validId(input.previousPublicationId))
    || (input.entrySnapshotId !== undefined && !validId(input.entrySnapshotId))
    || (input.legacySnapshotId !== undefined && !validId(input.legacySnapshotId)))) return { status: 400 }
  const requestedKeys = validId(requested) ? [
    validId(input.entrySnapshotId) && versionKey(slug, requested, input.entrySnapshotId, 'entry.html'),
    validId(input.legacySnapshotId) && versionKey(slug, requested, input.legacySnapshotId, 'legacy.html'),
    validId(input.entrySnapshotId) && versionKey(slug, requested, 'legacy', 'legacy.html'),
  ].filter((key): key is string => !!key) : []
  for (let attempt = 0; attempt < 8; attempt++) {
    const loaded = await readProjectState(env, slug)
    if (!loaded) {
      if (!validId(requested)) return null
      if (typeof token !== 'string' || !TOKEN.test(token)) return { status: 403 }
      const legacy = await env.SHARES.getWithMetadata<{ edit_token?: string; project_id?: string }>(slug)
      if (legacy.value && legacy.metadata && (legacy.metadata.edit_token !== token || (legacy.metadata.project_id && legacy.metadata.project_id !== input.project_id))) return { status: 403 }
      if (legacy.value) requestedKeys.push(versionKey(slug, requested, parseLegacySnapshotId(legacy.value, input.project_id as string), 'legacy.html'))
      const state: ProjectState = { schemaVersion: 1, publicationId: requested, project_id: input.project_id as string,
        edit_token_hash: await digest(new TextEncoder().encode(token)), feedback_token_hash: '', revoked: true,
        active: { publicationId: requested, snapshotId: 'revoked', htmlKey: '', entry: '', title: '', expires_at: null }, cleanup: requestedKeys }
      try { await writeState(env, slug, state); await cleanupKnown(env, slug, requestedKeys); return { status: 204, publicationId: requested } }
      catch (error) { if (!(error instanceof HttpError) || error.status !== 409) throw error; continue }
    }
    try { await checkOwner(loaded.state, token) } catch { return { status: 403 } }
    await prepareCleanup(env, slug, loaded)
    loaded.state.cleanup = [...new Set([...(loaded.state.cleanup ?? []), ...requestedKeys])]
    if (validId(requested) && input.project_id !== loaded.state.project_id) return { status: 403 }
    const publicationId = validId(requested) && loaded.state.publicationId === input.previousPublicationId ? requested : loaded.state.publicationId
    const state = { ...loaded.state, publicationId, revoked: true }
    delete state.pending
    try { await commit(env, slug, state, loaded, []); return { status: 204, publicationId } }
    catch (error) { if (!(error instanceof HttpError) || error.status !== 409) throw error }
  }
  return { status: 409 }
}
export async function handleProject(req: Request, env: Env, url: URL): Promise<Response> {
  const match = /^\/project\/([^/]+)\/(entry|archive|download)$/.exec(url.pathname)
  if (!match || !SLUG.test(match[1])) return new Response('Not Found', { status: 404 })
  const [, slug, op] = match
  if (op === 'download' && ['GET', 'HEAD'].includes(req.method)) return await publicProject(env, slug, true, req.method === 'HEAD') ?? new Response('Share expired', { status: 410, headers: { 'Cache-Control': 'no-store' } })
  if (!env.SHARE_API_KEY || req.headers.get('Authorization') !== `Bearer ${env.SHARE_API_KEY}`) return new Response('Unauthorized', { status: 401 })
  if (req.method !== 'POST' || op === 'download') return new Response('Method Not Allowed', { status: 405 })
  try { return await (op === 'entry' ? entry(req, env, slug, url.origin) : archive(req, env, slug, url.origin)) }
  catch (error) {
    if (error instanceof HttpError) return new Response(error.message, { status: error.status, headers: { 'Cache-Control': 'no-store' } })
    throw error
  }
}
