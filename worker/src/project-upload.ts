import type { Env } from './index'
import { digest, projectPath, MAX_FILE_BYTES, MAX_ZIP_BYTES } from './project-zip'
import { alive, checkOwner, HttpError, readProjectState, writeState, type Loaded, type ProjectState, type Version } from './project'

const LIMIT = 16384, PART_BYTES = 5 * 1024 * 1024, MAX_RETIRED = 8
const ID = /^[a-zA-Z0-9_-]{1,128}$/, TOKEN = /^[a-zA-Z0-9]{16,128}$/, HASH = /^[a-f0-9]{64}$/, MD5 = /^[a-f0-9]{32}$/
export type ArtifactName = 'entry' | 'reader' | 'archive'
export interface ArtifactPlan { name: ArtifactName; bytes: number; sha256: string; etag: string; parts: { number: number; bytes: number; md5: string }[] }
interface UploadArtifact extends ArtifactPlan { key: string; uploadId?: string }
export interface UploadSession {
  sessionId: string; publicationId: string; phase: 'entry' | 'full' | 'legacy'; snapshotId: string
  entry: string; title: string; expires_in_seconds: number | null; artifacts: UploadArtifact[]
}
export interface RetiredUpload { sessionId: string; artifacts: { key: string; uploadId?: string }[]; retain_until?: string }
interface Begin extends Omit<UploadSession, 'artifacts'> {
  edit_token: string; project_id: string; feedback_token_hash: string; previousPublicationId: string | null
  artifacts: ArtifactPlan[]; replaceSessionId?: string
  legacy?: { migrationId: string; snapshotId: string; publicationId?: string; expires_at: string | null }
}
interface LegacyMetadata { edit_token?: string; project_id?: string; feedback_token_hash?: string; expires_at?: string | null; size_bytes?: number }
const id = (value: unknown): value is string => typeof value === 'string' && ID.test(value)
const etag = (value: string) => value.replaceAll('"', '').toLowerCase()
const error = (status: number, message: string): never => { throw new HttpError(status, message) }
export async function readUploadControl(req: Request): Promise<any> {
  // Only control messages pass through JS. A missing length is bounded while reading.
  if (Number(req.headers.get('Content-Length')) > LIMIT) error(413, 'Control body exceeds 16 KiB')
  let length = 0
  const bounded = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
    length += chunk.byteLength
    if (length > LIMIT) error(413, 'Control body exceeds 16 KiB')
    controller.enqueue(chunk)
  } })
  try { return await new Response(req.body?.pipeThrough(bounded)).json() }
  catch (e) { if (e instanceof HttpError) throw e; error(400, 'Invalid control JSON') }
}
function validateBegin(value: any): asserts value is Begin {
  if (!value || !id(value.project_id) || !id(value.publicationId) || !id(value.sessionId) || !id(value.snapshotId)
    || !TOKEN.test(value.edit_token ?? '') || !HASH.test(value.feedback_token_hash ?? '')
    || !(value.previousPublicationId === null || id(value.previousPublicationId))
    || !['entry', 'full', 'legacy'].includes(value.phase) || !projectPath(value.entry)
    || typeof value.title !== 'string' || value.title.length > 1024
    || !(value.expires_in_seconds === null || Number.isSafeInteger(value.expires_in_seconds) && value.expires_in_seconds >= 60
      && Number.isFinite(new Date(Date.now() + value.expires_in_seconds * 1000).getTime()))
    || value.replaceSessionId !== undefined && !id(value.replaceSessionId)
    || !Array.isArray(value.artifacts)) error(400, 'Invalid upload metadata')
  const names = value.artifacts.map((p: ArtifactPlan) => p?.name).sort().join(',')
  if (value.phase === 'full' ? names !== 'archive,reader' : names !== 'entry') error(400, 'Invalid phase artifacts')
  for (const plan of value.artifacts as ArtifactPlan[]) {
    if (!Number.isSafeInteger(plan.bytes) || plan.bytes <= 0 || plan.bytes > (plan.name === 'archive' ? MAX_ZIP_BYTES : MAX_FILE_BYTES)
      || !HASH.test(plan.sha256) || !Array.isArray(plan.parts) || plan.parts.length !== Math.ceil(plan.bytes / PART_BYTES)
      || !new RegExp(`^[a-f0-9]{32}-${plan.parts.length}$`).test(plan.etag)) error(400, 'Invalid artifact plan')
    for (let i = 0; i < plan.parts.length; i++) {
      const part = plan.parts[i]
      if (part?.number !== i + 1 || part.bytes !== Math.min(PART_BYTES, plan.bytes - i * PART_BYTES) || !MD5.test(part.md5)) error(400, 'Invalid part plan')
    }
  }
  if (value.legacy && (!id(value.legacy.migrationId) || !id(value.legacy.snapshotId)
    || value.legacy.publicationId !== undefined && !id(value.legacy.publicationId)
    || !(value.legacy.expires_at === null || typeof value.legacy.expires_at === 'string' && Number.isFinite(Date.parse(value.legacy.expires_at))))) error(400, 'Invalid legacy migration identity')
}
function usable(state: ProjectState, publicationId?: string): void {
  if (state.revoked) error(410, 'Publication revoked')
  if (publicationId !== undefined && state.publicationId !== publicationId) error(409, 'Publication superseded')
  const expiry = state.publication_expires_at !== undefined ? state.publication_expires_at
    : state.pending ? state.pending.expires_at : state.active?.publicationId === state.publicationId ? state.active.expires_at : undefined
  if (expiry !== undefined ? !alive(expiry) : !state.entry_deadline || !alive(state.entry_deadline)) error(410, 'Publication expired')
}
function frozenPlan(plan: ArtifactPlan): ArtifactPlan {
  return { name: plan.name, bytes: plan.bytes, sha256: plan.sha256, etag: plan.etag, parts: plan.parts.map(p => ({ number: p.number, bytes: p.bytes, md5: p.md5 })) }
}
function samePlan(session: UploadSession, args: Begin): boolean {
  return session.publicationId === args.publicationId && session.phase === args.phase && session.snapshotId === args.snapshotId
    && session.entry === args.entry && session.title === args.title && session.expires_in_seconds === args.expires_in_seconds
    && JSON.stringify(session.artifacts.map(frozenPlan)) === JSON.stringify(args.artifacts.map(frozenPlan))
}
function references(state: ProjectState): Set<string> {
  return new Set(state.revoked ? [] : [state.active?.htmlKey, state.active?.archiveKey, ...state.upload?.artifacts.map(a => a.key) ?? []].filter((k): k is string => !!k))
}
function retire(state: ProjectState, session: RetiredUpload): void {
  if (!session.artifacts.length || state.retired?.some(s => s.sessionId === session.sessionId)) return
  if ((state.retired?.length ?? 0) >= MAX_RETIRED) error(409, 'cleanup_capacity: retry status before creating a session')
  state.retired = [...state.retired ?? [], { sessionId: session.sessionId, artifacts: session.artifacts.map(a => ({ key: a.key, ...(a.uploadId ? { uploadId: a.uploadId } : {}) })), retain_until: new Date(Date.now() + 7 * 86400000).toISOString() }]
}
function retireOld(slug: string, state: ProjectState, before: ProjectState): void {
  if (before.upload && before.upload.sessionId !== state.upload?.sessionId) retire(state, before.upload)
  const old = [before.active?.htmlKey, before.active?.archiveKey, before.attempt?.htmlKey, before.attempt?.archiveKey,
    ...(before.schemaVersion === 1 ? [before.pending, before.entry].filter(p => !!p).map(p => `project-share/${slug}/${p!.publicationId}/${p!.snapshotId}/entry.html`) : []), ...before.cleanup ?? []]
    .filter((k): k is string => !!k && !references(state).has(k) && !state.retired?.some(s => s.artifacts.some(a => a.key === k)))
  if (old.length) retire(state, { sessionId: 'old_' + crypto.randomUUID(), artifacts: [...new Set(old)].map(key => ({ key })) })
}
// Clean one exact artifact per request; CAS failure leaves its record for retry.
async function cleanupOne(env: Env, slug: string, loaded: Loaded): Promise<boolean> {
  const retired = loaded.state.schemaVersion === 2 && loaded.state.retired?.find(session => session.artifacts.every(a => !references(loaded.state).has(a.key)))
  const artifact = retired && retired.artifacts[0]
  if (!retired || !artifact) return false
  try {
    if (!artifact.key.startsWith(`project-share/${slug}/`) || artifact.key.endsWith('/state.json')) return true
    const object = artifact.uploadId ? await env.MEDIA.head(artifact.key) : undefined
    const current = await readProjectState(env, slug)
    if (!current || references(current.state).has(artifact.key)
      || !current.state.retired?.some(s => s.sessionId === retired.sessionId && s.artifacts.some(a => a.key === artifact.key))) return true
    // HEAD proves completion consumed the uploadId. An absent object may still
    // have a complete in flight, so keep its exact key through the MPU lifetime.
    const retain = !!artifact.uploadId && !object && !!retired.retain_until && alive(retired.retain_until)
    if (artifact.uploadId && !object) {
      try { await env.MEDIA.resumeMultipartUpload(artifact.key, artifact.uploadId).abort() }
      catch (e) { if (!missingUpload(e)) throw e }
    }
    if (!artifact.uploadId || object) await env.MEDIA.delete(artifact.key)
    const recorded = current.state.retired.find(s => s.sessionId === retired.sessionId)!
    const artifacts = recorded.artifacts.filter(a => a.key !== artifact.key)
    if (retain) artifacts.push(artifact)
    const remaining = current.state.retired.filter(s => s.sessionId !== retired.sessionId)
    if (artifacts.length) remaining.push({ ...recorded, artifacts })
    await writeState(env, slug, { ...current.state, retired: remaining, ...(current.state.revoked ? { cleanup_next_revoked: true } : {}) }, current.etag)
  } catch { /* Cleanup is recoverable and never changes publication success. */ }
  return true
}
function missingUpload(e: unknown): boolean { return /NoSuchUpload|10024|does not exist|not found|already completed|already aborted/i.test(String(e)) }
async function headArtifact(env: Env, session: UploadSession, artifact: UploadArtifact): Promise<R2Object | null> {
  const object = await env.MEDIA.head(artifact.key)
  if (!object) return null
  if (object.size !== artifact.bytes || etag(object.etag) !== artifact.etag
    || object.customMetadata?.sessionId !== session.sessionId || object.customMetadata?.publicationId !== session.publicationId
    || object.customMetadata?.sha256 !== artifact.sha256) error(409, 'Sealed artifact differs from frozen plan')
  return object
}
async function receipt(env: Env, slug: string, loaded: Loaded, origin: string, sealedOverride?: ArtifactName[]): Promise<Response> {
  const state = loaded.state, upload = state.upload
  const sealed: ArtifactName[] = sealedOverride ?? []
  if (sealedOverride === undefined && upload && !state.revoked) for (const artifact of upload.artifacts) {
    try { if (await headArtifact(env, upload, artifact)) sealed.push(artifact.name) }
    catch (e) { if (!(e instanceof HttpError && e.status === 409)) throw e }
  }
  return Response.json({ publicationId: state.publicationId, url: `${origin}/${slug}`,
    expires_at: state.publication_expires_at !== undefined ? state.publication_expires_at : state.pending ? state.pending.expires_at : state.active?.publicationId === state.publicationId ? state.active.expires_at : null,
    ...(state.entry_deadline ? { entry_deadline: state.entry_deadline } : {}),
    active: state.active ? { publicationId: state.active.publicationId, snapshotId: state.active.snapshotId, expires_at: state.active.expires_at } : null,
    ...(upload ? { upload: { sessionId: upload.sessionId, phase: upload.phase, snapshotId: upload.snapshotId, sealed } } : {}),
    ...(state.pending ? { pending: { publicationId: state.pending.publicationId, entrySnapshotId: state.pending.snapshotId, expires_at: state.pending.expires_at } } : {}),
    ...((state.entry ?? state.pending) ? { entry: { publicationId: (state.entry ?? state.pending)!.publicationId, snapshotId: (state.entry ?? state.pending)!.snapshotId, expires_at: (state.entry ?? state.pending)!.expires_at } } : {}), revoked: state.revoked,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
async function legacy(env: Env, slug: string, token: unknown, body: boolean): Promise<Response> {
  const item = await env.SHARES.getWithMetadata<LegacyMetadata>(slug, 'stream')
  if (!item.value || !item.metadata) error(404, 'Publication missing')
  if (item.metadata!.edit_token !== token || typeof token !== 'string' || !TOKEN.test(token)) error(403, 'Owner token mismatch')
  const m = item.metadata!
  if (body) return new Response(item.value, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...(Number.isSafeInteger(m.size_bytes) ? { 'Content-Length': String(m.size_bytes) } : {}) } })
  return Response.json({ publicationId: null, active: null, expires_at: m.expires_at ?? null,
    legacy: { bytes: m.size_bytes, expires_at: m.expires_at ?? null, project_id: m.project_id, feedback_token_hash: m.feedback_token_hash } }, { headers: { 'Cache-Control': 'no-store' } })
}
async function migrateLegacy(env: Env, slug: string, args: Begin): Promise<Version | null> {
  const item = await env.SHARES.getWithMetadata<LegacyMetadata>(slug, 'stream')
  if (!item.value) return null
  const m = item.metadata
  if (!m || m.edit_token !== args.edit_token) error(403, 'Owner token mismatch')
  if (m!.project_id !== args.project_id || m!.feedback_token_hash !== args.feedback_token_hash) error(409, 'Legacy project identity missing or changed')
  if (!alive(m!.expires_at ?? null)) error(410, 'Legacy publication expired')
  if (!args.legacy || args.legacy.expires_at !== (m!.expires_at ?? null) || !Number.isSafeInteger(m!.size_bytes) || m!.size_bytes! < 1 || m!.size_bytes! > MAX_FILE_BYTES) error(409, 'Legacy migration requires frozen identity and known length')
  const old = args.legacy!, key = `project-share/${slug}/legacy/${old.migrationId}/legacy.html`
  let object = await env.MEDIA.head(key)
  if (!object) {
    // Native fixed-length stream supplies R2's required known body length. No JS transform.
    const fixed = new FixedLengthStream(m!.size_bytes!)
    const piping = item.value!.pipeTo(fixed.writable)
    const writing = env.MEDIA.put(key, fixed.readable, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'text/html; charset=utf-8' }, customMetadata: { migrationId: old.migrationId, snapshotId: old.snapshotId } })
    await Promise.all([piping, writing])
    object = await env.MEDIA.head(key)
  }
  if (!object || object.size !== m!.size_bytes || object.customMetadata?.migrationId !== old.migrationId || object.customMetadata?.snapshotId !== old.snapshotId) error(409, 'Legacy migration object mismatch')
  return { publicationId: old.publicationId ?? 'legacy', snapshotId: old.snapshotId, htmlKey: key, ready: true, entry: args.entry, title: args.title, expires_at: m!.expires_at ?? null }
}
async function begin(env: Env, slug: string, args: Begin, origin: string): Promise<Response> {
  validateBegin(args)
  let loaded = await readProjectState(env, slug), state: ProjectState
  if (loaded) {
    await checkOwner(loaded.state, args.edit_token)
    if (loaded.state.publicationId === args.publicationId) usable(loaded.state, args.publicationId)
    if ((loaded.state.retired?.length ?? 0) >= MAX_RETIRED - 1 && await cleanupOne(env, slug, loaded)) error(409, 'cleanup_progress')
  }
  if (loaded) {
    if (loaded.state.project_id !== args.project_id || loaded.state.feedback_token_hash && loaded.state.feedback_token_hash !== args.feedback_token_hash) error(409, 'Project identity changed')
    if (loaded.state.publicationId === args.publicationId) {
      const entry = loaded.state.entry, proof = entry?.upload
      if (proof?.sessionId === args.sessionId) {
        if (args.phase !== 'entry' || entry!.publicationId !== args.publicationId || entry!.snapshotId !== args.snapshotId
          || entry!.entry !== args.entry || entry!.title !== args.title || proof.expires_in_seconds !== args.expires_in_seconds
          || args.artifacts.length !== 1 || JSON.stringify(frozenPlan(proof.artifact)) !== JSON.stringify(frozenPlan(args.artifacts[0]))) error(409, 'Committed entry plan changed')
        return receipt(env, slug, loaded, origin)
      }
      if (loaded.state.upload && samePlan(loaded.state.upload, args) && loaded.state.upload.sessionId === args.sessionId) return ensureUploads(env, slug, loaded, origin)
      if (loaded.state.upload?.sessionId === args.sessionId) error(409, 'Session plan changed')
      if (loaded.state.active?.publicationId === args.publicationId && loaded.state.active.snapshotId === args.snapshotId) {
        if (!loaded.state.upload || !samePlan(loaded.state.upload, args)) error(409, 'Published plan differs from frozen upload')
        return receipt(env, slug, loaded, origin)
      }
      const previous = loaded.state.upload
      if (args.replaceSessionId) {
        if (!previous || args.replaceSessionId !== previous.sessionId || !samePlan(previous, args)) error(409, 'Replacement must preserve frozen plan')
      } else if (previous && !(previous.phase === 'entry' && args.phase === 'full' && loaded.state.entry?.publicationId === args.publicationId && loaded.state.entry.snapshotId === previous.snapshotId)) error(409, 'Another upload session is current')
      if (args.phase === 'entry' && loaded.state.entry && loaded.state.entry.snapshotId !== args.snapshotId) error(409, 'Entry identity changed')
      if (args.phase === 'full' && (loaded.state.entry ?? loaded.state.pending)?.snapshotId === args.snapshotId) error(409, 'Full snapshot must differ from entry snapshot')
      if (args.phase === 'full' && !loaded.state.entry && !loaded.state.pending && !loaded.state.active) error(409, 'Entry must be committed first')
      state = { ...loaded.state, schemaVersion: 2 }
      if (state.publication_expires_at === undefined) {
        if (state.pending) state.publication_expires_at = state.pending.expires_at
        else if (state.active?.publicationId === state.publicationId) state.publication_expires_at = state.active.expires_at
      }
    } else {
      if (loaded.state.publicationId !== args.previousPublicationId) error(409, 'Previous publication mismatch')
      if (args.phase === 'full') error(409, 'New publication requires entry')
      state = { ...loaded.state, schemaVersion: 2, publicationId: args.publicationId, revoked: false, active: loaded.state.revoked ? null : loaded.state.active, entry_deadline: new Date(Date.now() + 7 * 86400000).toISOString() }
      delete state.publication_expires_at; delete state.entry; delete state.pending
    }
  } else {
    if (args.previousPublicationId !== null) error(409, 'Previous publication missing')
    if (args.phase === 'full') error(409, 'Entry must be committed first')
    const active = await migrateLegacy(env, slug, args)
    state = { schemaVersion: 2, publicationId: args.publicationId, project_id: args.project_id,
      edit_token_hash: await digest(new TextEncoder().encode(args.edit_token)), feedback_token_hash: args.feedback_token_hash,
      revoked: false, active, entry_deadline: new Date(Date.now() + 7 * 86400000).toISOString(), created_at: new Date().toISOString() }
    if (args.phase === 'legacy') {
      if (!args.legacy || !active) error(409, 'Legacy publication cannot be confirmed')
      state.publication_expires_at = args.legacy!.expires_at
    }
  }
  state.feedback_token_hash = args.feedback_token_hash
  state.expires_in_seconds = args.expires_in_seconds
  state.upload = { sessionId: args.sessionId, publicationId: args.publicationId, snapshotId: args.snapshotId, phase: args.phase,
    entry: args.entry, title: args.title, expires_in_seconds: args.expires_in_seconds,
    artifacts: args.artifacts.map(plan => ({ ...frozenPlan(plan), key: `project-share/${slug}/uploads/${crypto.randomUUID()}/${plan.name}` })) }
  if (loaded) retireOld(slug, state, loaded.state)
  delete state.attempt; delete state.cleanup
  let registeredEtag: string
  try { registeredEtag = await writeState(env, slug, state, loaded?.etag) }
  catch (e) {
    if (args.legacy) await cleanupLate(env, slug, { ...args.artifacts[0], key: `project-share/${slug}/legacy/${args.legacy.migrationId}/legacy.html` })
    throw e
  }
  loaded = { state, etag: registeredEtag }
  return ensureUploads(env, slug, loaded, origin, true)
}
async function ensureUploads(env: Env, slug: string, loaded: Loaded, origin: string, freshSession = false): Promise<Response> {
  const sessionId = loaded.state.upload?.sessionId, publicationId = loaded.state.publicationId
  if (!sessionId) return receipt(env, slug, loaded, origin)
  usable(loaded.state, publicationId)
  const created: R2MultipartUpload[] = []
  let attemptedCAS = false
  try {
    // Keys were registered before creation. At most two native MPUs are created,
    // then their uploadIds are registered together behind one fresh read and CAS.
    for (const artifact of loaded.state.upload!.artifacts) {
      if (artifact.uploadId) continue
      created.push(await env.MEDIA.createMultipartUpload(artifact.key, { httpMetadata: { contentType: artifact.name === 'archive' ? 'application/zip' : 'text/html; charset=utf-8' },
        customMetadata: { sessionId, publicationId, sha256: artifact.sha256 } }))
    }
    if (created.length) {
      const fresh = await readProjectState(env, slug)
      if (!fresh) error(409, 'Publication missing')
      usable(fresh!.state, publicationId)
      if (fresh!.state.upload?.sessionId !== sessionId) error(409, 'Upload session changed')
      let changed = false
      for (const upload of created) {
        const registered = fresh!.state.upload!.artifacts.find(a => a.key === upload.key)
        if (!registered) error(409, 'Upload artifact changed')
        if (registered!.uploadId) {
          if (registered!.uploadId !== upload.uploadId) { try { await upload.abort() } catch {} }
        } else { registered!.uploadId = upload.uploadId; changed = true }
      }
      loaded = fresh!
      if (changed) {
        attemptedCAS = true
        const savedEtag = await writeState(env, slug, fresh!.state, fresh!.etag)
        loaded = { state: fresh!.state, etag: savedEtag }
      }
    }
  } catch (e) {
    let current: Loaded | null = null
    if (attemptedCAS) {
      // A failed response can hide a successful CAS. If its reread also fails,
      // leave the MPUs to native expiry rather than abort a registered winner.
      try { current = await readProjectState(env, slug) } catch { throw e }
    }
    for (const upload of created) {
      const registered = current?.state.upload?.artifacts.some(a => a.key === upload.key && a.uploadId === upload.uploadId)
        || current?.state.retired?.some(s => s.artifacts.some(a => a.key === upload.key && a.uploadId === upload.uploadId))
      if (!registered) { try { await upload.abort() } catch {} }
    }
    throw e
  }
  // A fresh session starts empty. Recovery requests still inspect native HEAD.
  return receipt(env, slug, loaded, origin, freshSession ? [] : undefined)
}
async function authorized(env: Env, slug: string, token: unknown, publicationId: unknown, sessionId: unknown, allowCommittedEntry = false): Promise<Loaded> {
  const loaded = await readProjectState(env, slug)
  if (!loaded) error(404, 'Publication missing')
  await checkOwner(loaded!.state, token)
  usable(loaded!.state, typeof publicationId === 'string' ? publicationId : '')
  const committedEntry = allowCommittedEntry && loaded!.state.entry?.publicationId === publicationId && loaded!.state.entry?.upload?.sessionId === sessionId
  if (!id(publicationId) || !id(sessionId) || loaded!.state.upload?.sessionId !== sessionId && !committedEntry) error(409, 'Upload session changed')
  return loaded!
}
async function cleanupLate(env: Env, slug: string, artifact: UploadArtifact): Promise<void> {
  try {
    const current = await readProjectState(env, slug)
    if (!current || references(current.state).has(artifact.key)) return
    if (artifact.uploadId) try { await env.MEDIA.resumeMultipartUpload(artifact.key, artifact.uploadId).abort() } catch (e) { if (!missingUpload(e)) throw e }
    await env.MEDIA.delete(artifact.key)
  } catch { /* Recorded retirement/tombstone is retried by owner controls. */ }
}
async function part(req: Request, env: Env, slug: string): Promise<Response> {
  const token = req.headers.get('X-Edit-Token'), publicationId = req.headers.get('X-Publication-Id'), sessionId = req.headers.get('X-Upload-Session')
  const loaded = await authorized(env, slug, token, publicationId, sessionId), session = loaded.state.upload!
  const artifact = session.artifacts.find(a => a.name === req.headers.get('X-Artifact'))
  const number = Number(req.headers.get('X-Part-Number')), planned = artifact?.parts.find(p => p.number === number)
  if (!artifact || !planned || !req.body) error(400, 'Invalid artifact or part')
  const length = req.headers.get('Content-Length')
  if (!length || !/^\d+$/.test(length) || Number(length) !== planned!.bytes) error(411, 'Known Content-Length must match frozen part')
  if (!artifact!.uploadId) error(409, 'Upload session not ready; retry begin')
  if (await headArtifact(env, session, artifact!)) error(409, 'Artifact is already sealed')
  let uploaded: R2UploadedPart
  try { uploaded = await env.MEDIA.resumeMultipartUpload(artifact!.key, artifact!.uploadId!).uploadPart(number, req.body!) }
  catch (e) { if (missingUpload(e)) error(410, 'upload_expired'); throw e }
  // Revalidate after the potentially long body transfer. It may never cross a newer fence.
  try { await authorized(env, slug, token, publicationId, sessionId) }
  catch (e) { await cleanupLate(env, slug, artifact!); throw e }
  // Workers bindings may return opaque completion receipts. Only 32-hex
  // receipts provide an early MD5 check; final native multipart ETag is mandatory.
  if (MD5.test(etag(uploaded.etag)) && etag(uploaded.etag) !== planned!.md5) error(400, 'Part checksum mismatch')
  return Response.json({ number, etag: uploaded.etag })
}
async function seal(env: Env, slug: string, args: any, origin: string): Promise<Response> {
  const loaded = await authorized(env, slug, args.edit_token, args.publicationId, args.sessionId), session = loaded.state.upload!
  const artifact = session.artifacts.find(a => a.name === args.artifact)
  if (!artifact) error(400, 'Invalid artifact')
  if (!await headArtifact(env, session, artifact!)) {
    if (!Array.isArray(args.parts) || args.parts.length !== artifact!.parts.length
      || args.parts.some((p: any, i: number) => p?.number !== artifact!.parts[i].number || typeof p.etag !== 'string'
        || p.etag.length < 1 || p.etag.length > 512 || /[\x00-\x1f\x7f]/.test(p.etag))) error(400, 'Invalid frozen part receipts')
    if (!artifact!.uploadId) error(409, 'Upload session not ready; retry begin')
    try { await env.MEDIA.resumeMultipartUpload(artifact!.key, artifact!.uploadId!).complete(args.parts.map((p: { number: number; etag: string }) => ({ partNumber: p.number, etag: p.etag }))) }
    catch (e) {
      if (!await headArtifact(env, session, artifact!)) {
        if (missingUpload(e)) error(410, 'upload_expired')
        error(409, 'Artifact incomplete or checksum mismatch')
      }
    }
    if (!await headArtifact(env, session, artifact!)) error(409, 'Sealed artifact missing')
  }
  let fresh: Loaded
  try { fresh = await authorized(env, slug, args.edit_token, args.publicationId, args.sessionId) }
  catch (e) { await cleanupLate(env, slug, artifact!); throw e }
  return receipt(env, slug, fresh, origin)
}
async function commit(env: Env, slug: string, args: any, origin: string): Promise<Response> {
  let loaded = await authorized(env, slug, args.edit_token, args.publicationId, args.sessionId, true)
  if (loaded.state.entry && loaded.state.entry.publicationId === args.publicationId && loaded.state.entry.upload?.sessionId === args.sessionId) return receipt(env, slug, loaded, origin)
  const session = loaded.state.upload!
  if (loaded.state.active?.publicationId === session.publicationId && loaded.state.active.snapshotId === session.snapshotId) return receipt(env, slug, loaded, origin)
  for (const artifact of session.artifacts) if (!await headArtifact(env, session, artifact)) error(409, 'Artifact is not sealed')
  loaded = await authorized(env, slug, args.edit_token, args.publicationId, args.sessionId)
  const state = { ...loaded.state }
  const expires_at = state.publication_expires_at !== undefined ? state.publication_expires_at
    : session.expires_in_seconds === null ? null : new Date(Date.now() + session.expires_in_seconds * 1000).toISOString()
  const reader = session.artifacts.find(a => a.name !== 'archive')!, archive = session.artifacts.find(a => a.name === 'archive')
  const version: Version = { publicationId: session.publicationId, snapshotId: session.snapshotId, htmlKey: reader.key,
    ...(archive ? { archiveKey: archive.key, archiveHash: archive.sha256 } : session.phase === 'legacy' ? { ready: true } : {}), entry: session.entry, title: session.title, expires_at }
  // During updates the old complete active remains visible until both full objects seal.
  if (session.phase === 'full' || session.phase === 'legacy' || !state.active || !alive(state.active.expires_at) || !(state.active.archiveKey || state.active.ready)) state.active = version
  state.publication_expires_at = expires_at
  if (session.phase === 'entry') {
    state.entry = { publicationId: session.publicationId, snapshotId: session.snapshotId, entryHash: reader.sha256, entry: session.entry, title: session.title, expires_at, upload: { sessionId: session.sessionId, expires_in_seconds: session.expires_in_seconds, artifact: frozenPlan(reader) } }
    state.pending = { ...state.entry }; delete state.pending.upload
  } else delete state.pending
  retireOld(slug, state, loaded.state)
  await writeState(env, slug, state, loaded.etag)
  return receipt(env, slug, { state, etag: '' }, origin)
}
export async function revokeUpload(env: Env, slug: string, loaded: Loaded, requested: unknown, previous: unknown, projectId: unknown, requestedKeys: string[] = []): Promise<{ status: number; publicationId?: string }> {
  if (id(requested) && projectId !== loaded.state.project_id) return { status: 403 }
  const state = { ...loaded.state, revoked: true, publicationId: id(requested) && loaded.state.publicationId === previous ? requested : loaded.state.publicationId }
  // Tombstones must remain possible even when all eight cleanup slots are occupied.
  // Keep the last session registered in the tombstone instead of adding a ninth record.
  delete state.pending
  delete state.entry
  if (state.upload) state.upload = { ...state.upload, entry: '', title: '', artifacts: state.upload.artifacts.map(a => ({ ...a, parts: [] })) }
  if (state.active) state.active = { ...state.active, entry: '', title: '' }
  const known = new Set([state.active?.htmlKey, state.active?.archiveKey, ...state.upload?.artifacts.map(a => a.key) ?? [], ...state.cleanup ?? []])
  const extra = requestedKeys.filter(key => !known.has(key))
  if (extra.length) state.cleanup = [...new Set([...state.cleanup ?? [], ...extra])]
  try {
    await writeState(env, slug, state, loaded.etag)
    await cleanupRevoked(env, slug, { state, etag: '' })
    return { status: 204, publicationId: state.publicationId }
  } catch (e) { if (e instanceof HttpError) return { status: e.status }; throw e }
}
async function cleanupRevoked(env: Env, slug: string, loaded: Loaded): Promise<boolean> {
  if (!loaded.state.revoked) return false
  // Keep exact keys in the tombstone, including after successful deletion, for late completes.
  const seen = new Set<string>()
  const artifacts = [...loaded.state.upload?.artifacts ?? [],
    ...[loaded.state.active?.htmlKey, loaded.state.active?.archiveKey, ...loaded.state.cleanup ?? []].filter((key): key is string => !!key).map(key => ({ key, uploadId: undefined }))]
    .filter(artifact => { if (seen.has(artifact.key)) return false; seen.add(artifact.key); return true })
  if (!artifacts.length) return false
  const cursor = (loaded.state.cleanup_cursor ?? 0) % artifacts.length, artifact = artifacts[cursor]
  try {
    if (!artifact.key.startsWith(`project-share/${slug}/`) || artifact.key.endsWith('/state.json')) return true
    const object = artifact.uploadId ? await env.MEDIA.head(artifact.key) : undefined
    const current = await readProjectState(env, slug)
    if (!current || references(current.state).has(artifact.key)) return true
    const recorded = current.state.revoked && (current.state.upload?.artifacts.some(a => a.key === artifact.key)
      || current.state.active?.htmlKey === artifact.key || current.state.active?.archiveKey === artifact.key || current.state.cleanup?.includes(artifact.key))
      || current.state.retired?.some(s => s.artifacts.some(a => a.key === artifact.key))
    if (!recorded) return true
    if (artifact.uploadId && !object) try { await env.MEDIA.resumeMultipartUpload(artifact.key, artifact.uploadId).abort() } catch (e) { if (!missingUpload(e)) throw e }
    if (!artifact.uploadId || object) await env.MEDIA.delete(artifact.key)
    // A successor may have retired the key. Never overwrite its new cleanup progress.
    if (current.state.revoked && current.state.publicationId === loaded.state.publicationId) {
      await writeState(env, slug, { ...current.state, cleanup_cursor: (cursor + 1) % artifacts.length, cleanup_next_revoked: false }, current.etag)
    }
  } catch { /* Exact keys remain in tombstone for status/stop retry. */ }
  return true
}
export async function handleProjectUpload(req: Request, env: Env, url: URL): Promise<Response> {
  const match = /^\/project\/(\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?)\/upload\/(begin|part|seal|commit|status|legacy)$/.exec(url.pathname)
  if (!match) return new Response('Not Found', { status: 404 })
  if (!env.SHARE_API_KEY || req.headers.get('Authorization') !== `Bearer ${env.SHARE_API_KEY}`) return new Response('Unauthorized', { status: 401 })
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  const [, slug, op] = match
  try {
    if (op === 'part') return await part(req, env, slug)
    const args = await readUploadControl(req)
    if (!args || typeof args !== 'object' || Array.isArray(args)) error(400, 'Invalid control JSON')
    if (op === 'begin') return await begin(env, slug, args, url.origin)
    if (op === 'legacy') {
      if (await readProjectState(env, slug)) error(409, 'Legacy share has migrated')
      return await legacy(env, slug, args?.edit_token, true)
    }
    if (op === 'status') {
      let loaded = await readProjectState(env, slug)
      if (!loaded) return await legacy(env, slug, args?.edit_token, false)
      await checkOwner(loaded.state, args?.edit_token)
      const processed = loaded.state.revoked && loaded.state.cleanup_next_revoked
        ? await cleanupRevoked(env, slug, loaded) || await cleanupOne(env, slug, loaded)
        : await cleanupOne(env, slug, loaded) || loaded.state.revoked && await cleanupRevoked(env, slug, loaded)
      if (!processed) return await receipt(env, slug, loaded, url.origin)
      loaded = (await readProjectState(env, slug))!
      return await receipt(env, slug, loaded, url.origin)
    }
    return op === 'seal' ? await seal(env, slug, args, url.origin) : await commit(env, slug, args, url.origin)
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ error: e.message === 'upload_expired' ? 'upload_expired' : e.message, message: e.message }, { status: e.status, headers: { 'Cache-Control': 'no-store' } })
    throw e
  }
}
