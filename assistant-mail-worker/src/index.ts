export interface Env {
  MAIL_DB: D1Database
  MAIL_RAW: R2Bucket
  MAIL_QUEUE: Queue<MailQueueMessage>
  ASSISTANT_MAIL_ACCESS_KEY: string
  ALLOWED_FORWARDER: string
  ASSISTANT_MAIL_ADDRESS: string
  MAX_RAW_BYTES?: string
  DELETION_PLAN_TTL_SECONDS?: string
}

interface MailQueueMessage {
  kind: 'promote_source'
  source_id: string
}

interface SourceRow {
  id: string
  message_id: string | null
  envelope_from: string
  envelope_to: string
  header_from: string | null
  subject: string | null
  raw_key: string
  raw_size: number
  raw_sha256: string
  status: 'received_pending' | 'ready' | 'deleting' | 'deleted'
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface DeletionPlanRow {
  id: string
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'expired'
  target_ids_json: string
  targets_json: string
  impact_json: string
  plan_hash: string
  created_by: string
  created_at: string
  expires_at: string
  executed_at: string | null
  completed_at: string | null
}

interface DeletionJobRow {
  id: string
  plan_id: string
  status: 'running' | 'completed' | 'failed'
  target_ids_json: string
  attempt_count: number
  last_error: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: JSON_HEADERS })
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return new Response(JSON.stringify({ error: { code: error.code, message: error.message } }), {
      status: error.status,
      headers: JSON_HEADERS,
    })
  }
  console.error('assistant-mail request failed', error instanceof Error ? error.message : 'unknown error')
  return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Internal error' } }), {
    status: 500,
    headers: JSON_HEADERS,
  })
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase()
}

function actorFrom(request: Request): string {
  void request
  return 'plugin-instance'
}

function reportedAgentFrom(request: Request): string {
  const value = request.headers.get('X-Agent-Id')?.trim() || 'notemd-plugin'
  const sanitized = /^[a-zA-Z0-9._:@/-]{1,128}$/.test(value) ? value : 'notemd-plugin'
  return `unverified:${sanitized}`
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256(value: ArrayBuffer | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes))
}

function safeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  const length = Math.max(a.length, b.length)
  let difference = a.length ^ b.length
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return difference === 0
}

function requireAuth(request: Request, env: Env): void {
  if (!env.ASSISTANT_MAIL_ACCESS_KEY) {
    throw new HttpError(503, 'not_configured', 'Worker access key is not configured')
  }
  const authorization = request.headers.get('Authorization') || ''
  const expected = `Bearer ${env.ASSISTANT_MAIL_ACCESS_KEY}`
  if (!safeEqual(authorization, expected)) {
    throw new HttpError(401, 'unauthorized', 'Valid Bearer credentials are required')
  }
}

function positiveInteger(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new HttpError(400, 'invalid_parameter', `Value must be between 1 and ${max}`)
  }
  return parsed
}

function encodeCursor(sequence: number): string {
  const value = new TextEncoder().encode(`v1:${sequence}`)
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0
  try {
    const padded = cursor.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - cursor.length % 4) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const decoded = new TextDecoder().decode(bytes)
    if (!/^v1:\d+$/.test(decoded)) throw new Error('invalid cursor')
    return Number.parseInt(decoded.slice(3), 10)
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'Cursor is invalid')
  }
}

function sanitizeHeader(value: string | undefined): string | null {
  if (!value) return null
  return value.replace(/[\r\n\0]/g, ' ').trim().slice(0, 998) || null
}

function extractHeaders(raw: ArrayBuffer): { messageId: string | null; subject: string | null; from: string | null } {
  const prefix = new Uint8Array(raw, 0, Math.min(raw.byteLength, 64 * 1024))
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(prefix)
  const headerEnd = text.search(/\r?\n\r?\n/)
  const block = (headerEnd >= 0 ? text.slice(0, headerEnd) : text).replace(/\r?\n[ \t]+/g, ' ')
  const values = new Map<string, string>()
  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim().toLowerCase()
    if (!values.has(name)) values.set(name, line.slice(separator + 1).trim())
  }
  return {
    messageId: sanitizeHeader(values.get('message-id')),
    subject: sanitizeHeader(values.get('subject')),
    from: sanitizeHeader(values.get('from')),
  }
}

function publicSource(row: SourceRow): Record<string, unknown> {
  return {
    id: row.id,
    message_id: row.message_id,
    envelope_from: row.envelope_from,
    envelope_to: row.envelope_to,
    header_from: row.header_from,
    subject: row.subject,
    raw_size: row.raw_size,
    raw_sha256: row.raw_sha256,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function audit(
  env: Env,
  actor: string,
  action: string,
  resourceType: string,
  resourceId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await env.MAIL_DB.prepare(
    `INSERT INTO audit_events
       (id, actor, action, resource_type, resource_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), actor, action, resourceType, resourceId, JSON.stringify(detail), new Date().toISOString()).run()
}

async function appendChange(
  env: Env,
  changeType: string,
  entityType: string,
  entityId: string,
  payload: Record<string, unknown>,
  now = new Date().toISOString(),
): Promise<void> {
  await env.MAIL_DB.prepare(
    `INSERT INTO changes (change_type, entity_type, entity_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(changeType, entityType, entityId, JSON.stringify(payload), now).run()
}

function stagingKey(sourceId: string): string {
  return `staging/${sourceId}.eml`
}

function finalRawKey(sourceId: string): string {
  return `raw/${sourceId}.eml`
}

async function promoteSource(env: Env, sourceId: string): Promise<void> {
  const source = await env.MAIL_DB.prepare('SELECT * FROM sources WHERE id = ?').bind(sourceId).first<SourceRow>()
  if (!source || source.status !== 'received_pending') return

  const stageKey = stagingKey(sourceId)
  const destinationKey = finalRawKey(sourceId)
  const staged = await env.MAIL_RAW.get(stageKey)
  if (staged) {
    await env.MAIL_RAW.put(destinationKey, staged.body, {
      httpMetadata: { contentType: 'message/rfc822' },
      customMetadata: { sha256: source.raw_sha256, source_id: sourceId },
    })
    await env.MAIL_RAW.delete(stageKey)
  } else if (!await env.MAIL_RAW.head(destinationKey)) {
    throw new Error('raw object is missing from staging and final storage')
  }

  const now = new Date().toISOString()
  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare(
      `UPDATE sources SET raw_key = ?, status = 'ready', updated_at = ?
       WHERE id = ? AND status = 'received_pending'`,
    ).bind(destinationKey, now, sourceId),
    env.MAIL_DB.prepare(
      `UPDATE deliveries SET status = 'accepted', failure_code = NULL
       WHERE source_id = ? AND status = 'received_pending'`,
    ).bind(sourceId),
    env.MAIL_DB.prepare(
      `INSERT INTO changes (change_type, entity_type, entity_id, payload_json, created_at)
       VALUES ('source.upsert', 'source', ?, ?, ?)`,
    ).bind(sourceId, JSON.stringify({ source_id: sourceId, status: 'ready' }), now),
  ])
}

async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const allowedForwarder = normalizeAddress(env.ALLOWED_FORWARDER || '')
  const assistantAddress = normalizeAddress(env.ASSISTANT_MAIL_ADDRESS || '')
  if (
    !allowedForwarder ||
    !assistantAddress ||
    normalizeAddress(message.from) !== allowedForwarder ||
    normalizeAddress(message.to) !== assistantAddress
  ) {
    message.setReject('Envelope sender or recipient is not allowed')
    return
  }

  const maximum = Number.parseInt(env.MAX_RAW_BYTES || '26214400', 10)
  if (message.rawSize > maximum) {
    message.setReject('Message exceeds the configured size limit')
    return
  }

  const raw = await new Response(message.raw).arrayBuffer()
  if (raw.byteLength > maximum) {
    message.setReject('Message exceeds the configured size limit')
    return
  }

  const now = new Date().toISOString()
  const deliveryId = crypto.randomUUID()
  const digest = await sha256(raw)
  const headers = extractHeaders(raw)
  const duplicate = await env.MAIL_DB.prepare(
    `SELECT id FROM sources
     WHERE (message_id IS NOT NULL AND message_id = ?) OR raw_sha256 = ?
     ORDER BY created_at LIMIT 1`,
  ).bind(headers.messageId, digest).first<{ id: string }>()

  if (duplicate) {
    await env.MAIL_DB.batch([
      env.MAIL_DB.prepare(
        `INSERT INTO deliveries
           (id, source_id, received_at, raw_size, raw_sha256, status, failure_code)
         VALUES (?, ?, ?, ?, ?, 'duplicate', NULL)`,
      ).bind(deliveryId, duplicate.id, now, raw.byteLength, digest),
      env.MAIL_DB.prepare(
        `INSERT INTO audit_events
           (id, actor, action, resource_type, resource_id, detail_json, created_at)
         VALUES (?, 'email-worker', 'delivery.duplicate', 'source', ?, '{}', ?)`,
      ).bind(crypto.randomUUID(), duplicate.id, now),
    ])
    return
  }

  const sourceId = crypto.randomUUID()
  const key = stagingKey(sourceId)
  await env.MAIL_RAW.put(key, raw, {
    httpMetadata: { contentType: 'message/rfc822' },
    customMetadata: { sha256: digest, source_id: sourceId },
  })

  try {
    await env.MAIL_DB.batch([
      env.MAIL_DB.prepare(
        `INSERT INTO sources
           (id, message_id, envelope_from, envelope_to, header_from, subject, raw_key,
            raw_size, raw_sha256, status, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received_pending', ?, ?, NULL)`,
      ).bind(
        sourceId, headers.messageId, normalizeAddress(message.from), normalizeAddress(message.to),
        headers.from, headers.subject, key, raw.byteLength, digest, now, now,
      ),
      env.MAIL_DB.prepare(
        `INSERT INTO deliveries
           (id, source_id, received_at, raw_size, raw_sha256, status, failure_code)
         VALUES (?, ?, ?, ?, ?, 'received_pending', NULL)`,
      ).bind(deliveryId, sourceId, now, raw.byteLength, digest),
      env.MAIL_DB.prepare(
        `INSERT INTO audit_events
           (id, actor, action, resource_type, resource_id, detail_json, created_at)
         VALUES (?, 'email-worker', 'delivery.accepted', 'source', ?, '{}', ?)`,
      ).bind(crypto.randomUUID(), sourceId, now),
    ])
  } catch (error) {
    await env.MAIL_RAW.delete(key)
    throw error
  }

  try {
    await env.MAIL_QUEUE.send({ kind: 'promote_source', source_id: sourceId })
  } catch (error) {
    console.error('queue dispatch failed; scheduled reconciliation will retry', error instanceof Error ? error.message : 'unknown')
  }
}

async function handleWhoAmI(request: Request, env: Env): Promise<Response> {
  const fingerprint = (await sha256(env.ASSISTANT_MAIL_ACCESS_KEY)).slice(0, 12)
  return json({
    service: 'notemd-assistant-mail',
    api_version: 'v1',
    mailbox: env.ASSISTANT_MAIL_ADDRESS,
    allowed_forwarder: env.ALLOWED_FORWARDER,
    key_fingerprint: fingerprint,
    actor: actorFrom(request),
    reported_agent: reportedAgentFrom(request),
  })
}

async function handleStatus(env: Env): Promise<Response> {
  const sourceCounts = await env.MAIL_DB.prepare(
    'SELECT status, COUNT(*) AS count FROM sources GROUP BY status',
  ).all<{ status: string; count: number }>()
  const deliveryCounts = await env.MAIL_DB.prepare(
    'SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status',
  ).all<{ status: string; count: number }>()
  const coverage = await env.MAIL_DB.prepare(
    `SELECT MAX(received_at) AS latest_received_at,
            MAX(CASE WHEN status IN ('accepted', 'duplicate') THEN received_at END) AS latest_ready_at
     FROM deliveries`,
  ).first<{ latest_received_at: string | null; latest_ready_at: string | null }>()
  const watermark = await env.MAIL_DB.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM changes').first<{ seq: number }>()
  const toMap = (rows: Array<{ status: string; count: number }>) => Object.fromEntries(rows.map((row) => [row.status, row.count]))
  return json({
    coverage: coverage || { latest_received_at: null, latest_ready_at: null },
    counts: { sources: toMap(sourceCounts.results), deliveries: toMap(deliveryCounts.results) },
    high_watermark: encodeCursor(watermark?.seq || 0),
  })
}

async function handleChanges(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const after = decodeCursor(url.searchParams.get('after'))
  const limit = positiveInteger(url.searchParams.get('limit'), 100, 200)
  const result = await env.MAIL_DB.prepare(
    `SELECT seq, change_type, entity_type, entity_id, payload_json, created_at
     FROM changes WHERE seq > ? ORDER BY seq LIMIT ?`,
  ).bind(after, limit + 1).all<{
    seq: number
    change_type: string
    entity_type: string
    entity_id: string
    payload_json: string
    created_at: string
  }>()
  const hasMore = result.results.length > limit
  const rows = result.results.slice(0, limit)
  const next = rows.at(-1)?.seq ?? after
  return json({
    changes: rows.map((row) => ({
      seq: row.seq,
      cursor: encodeCursor(row.seq),
      type: row.change_type,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      payload: JSON.parse(row.payload_json),
      created_at: row.created_at,
    })),
    next_cursor: encodeCursor(next),
    has_more: hasMore,
  })
}

async function handleSources(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const limit = positiveInteger(url.searchParams.get('limit'), 100, 200)
  const rows = await env.MAIL_DB.prepare(
    `SELECT * FROM sources WHERE status IN ('received_pending', 'ready')
     ORDER BY created_at, id LIMIT ?`,
  ).bind(limit).all<SourceRow>()
  return json({ sources: rows.results.map(publicSource), has_more: rows.results.length === limit })
}

async function getReadableSource(env: Env, sourceId: string): Promise<SourceRow> {
  const source = await env.MAIL_DB.prepare('SELECT * FROM sources WHERE id = ?').bind(sourceId).first<SourceRow>()
  if (!source) throw new HttpError(404, 'source_not_found', 'Source does not exist')
  if (source.status === 'deleting' || source.status === 'deleted') {
    throw new HttpError(410, 'source_deleted', 'Source is no longer available')
  }
  return source
}

async function handleSource(sourceId: string, env: Env): Promise<Response> {
  return json(publicSource(await getReadableSource(env, sourceId)))
}

async function handleRaw(request: Request, sourceId: string, env: Env): Promise<Response> {
  const source = await getReadableSource(env, sourceId)
  if (source.status !== 'ready') throw new HttpError(409, 'source_not_ready', 'Source is not ready')
  const object = await env.MAIL_RAW.get(source.raw_key)
  if (!object) throw new HttpError(503, 'raw_temporarily_unavailable', 'Raw source is temporarily unavailable')
  await audit(env, actorFrom(request), 'source.raw.read', 'source', source.id, {
    raw_size: source.raw_size,
    reported_agent: reportedAgentFrom(request),
  })
  const headers = new Headers({
    'Content-Type': 'message/rfc822',
    'Content-Disposition': `attachment; filename="${source.id}.eml"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Source-Id': source.id,
    ETag: `"${source.raw_sha256}"`,
  })
  return new Response(object.body, { headers })
}

function parseJsonArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) throw new Error('invalid stored array')
  return parsed
}

function publicPlan(row: DeletionPlanRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    target_ids: JSON.parse(row.target_ids_json),
    targets: JSON.parse(row.targets_json),
    impact: JSON.parse(row.impact_json),
    plan_hash: row.plan_hash,
    created_by: row.created_by,
    created_at: row.created_at,
    expires_at: row.expires_at,
    executed_at: row.executed_at,
    completed_at: row.completed_at,
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number.parseInt(request.headers.get('Content-Length') || '0', 10)
  if (contentLength > 64 * 1024) throw new HttpError(413, 'body_too_large', 'Request body is too large')
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required')
    return body as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'invalid_json', 'A JSON object is required')
  }
}

async function fetchSourcesByIds(env: Env, ids: string[]): Promise<SourceRow[]> {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = await env.MAIL_DB.prepare(`SELECT * FROM sources WHERE id IN (${placeholders}) ORDER BY id`).bind(...ids).all<SourceRow>()
  return rows.results
}

async function buildPlanDocument(sources: SourceRow[]): Promise<{
  targets: Array<Record<string, unknown>>
  impact: Record<string, unknown>
  hash: string
}> {
  const targets = sources.map((source) => ({
    source_id: source.id,
    raw_key: source.raw_key,
    raw_sha256: source.raw_sha256,
    raw_size: source.raw_size,
    status: source.status,
  }))
  const impact = {
    sources: sources.length,
    raw_objects: sources.filter((source) => source.raw_key).length,
    raw_bytes: sources.reduce((total, source) => total + source.raw_size, 0),
    local_projections: 'The plugin must consume tombstones and remove managed archive/diary projections.',
    audit: 'Minimal audit records and tombstones are retained; message content is not copied into them.',
  }
  return { targets, impact, hash: await sha256(JSON.stringify({ version: 1, targets, impact })) }
}

async function handleCreateDeletionPlan(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request)
  if (!Array.isArray(body.source_ids) || body.source_ids.length < 1 || body.source_ids.length > 100) {
    throw new HttpError(400, 'invalid_targets', 'source_ids must contain between 1 and 100 IDs')
  }
  const ids = [...new Set(body.source_ids)]
  if (!ids.every((value) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value))) {
    throw new HttpError(400, 'invalid_targets', 'Every source ID must be a UUID')
  }
  const sources = await fetchSourcesByIds(env, ids as string[])
  if (sources.length !== ids.length) throw new HttpError(404, 'source_not_found', 'At least one source does not exist')
  if (sources.some((source) => source.status === 'deleting' || source.status === 'deleted')) {
    throw new HttpError(409, 'source_unavailable', 'A source is already deleting or deleted')
  }

  const document = await buildPlanDocument(sources)
  const now = new Date()
  const ttl = Number.parseInt(env.DELETION_PLAN_TTL_SECONDS || '900', 10)
  const plan: DeletionPlanRow = {
    id: crypto.randomUUID(),
    status: 'pending',
    target_ids_json: JSON.stringify(sources.map((source) => source.id)),
    targets_json: JSON.stringify(document.targets),
    impact_json: JSON.stringify(document.impact),
    plan_hash: document.hash,
    created_by: actorFrom(request),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
    executed_at: null,
    completed_at: null,
  }
  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare(
      `INSERT INTO deletion_plans
         (id, status, target_ids_json, targets_json, impact_json, plan_hash, created_by,
          created_at, expires_at, executed_at, completed_at)
       VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).bind(
      plan.id, plan.target_ids_json, plan.targets_json, plan.impact_json, plan.plan_hash,
      plan.created_by, plan.created_at, plan.expires_at,
    ),
    env.MAIL_DB.prepare(
      `INSERT INTO audit_events
         (id, actor, action, resource_type, resource_id, detail_json, created_at)
       VALUES (?, ?, 'deletion.plan.created', 'deletion_plan', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), plan.created_by, plan.id,
      JSON.stringify({
        target_count: sources.length,
        plan_hash: plan.plan_hash,
        reported_agent: reportedAgentFrom(request),
      }), plan.created_at,
    ),
  ])
  return json(publicPlan(plan), 201)
}

async function getPlan(env: Env, planId: string): Promise<DeletionPlanRow> {
  const plan = await env.MAIL_DB.prepare('SELECT * FROM deletion_plans WHERE id = ?').bind(planId).first<DeletionPlanRow>()
  if (!plan) throw new HttpError(404, 'plan_not_found', 'Deletion plan does not exist')
  if (plan.status === 'pending' && plan.expires_at <= new Date().toISOString()) {
    await env.MAIL_DB.prepare("UPDATE deletion_plans SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(planId).run()
    plan.status = 'expired'
  }
  return plan
}

async function handleGetPlan(planId: string, env: Env): Promise<Response> {
  return json(publicPlan(await getPlan(env, planId)))
}

async function runDeletionJob(env: Env, jobId: string): Promise<void> {
  const job = await env.MAIL_DB.prepare('SELECT * FROM deletion_jobs WHERE id = ?').bind(jobId).first<DeletionJobRow>()
  if (!job || job.status === 'completed') return
  const targetIds = parseJsonArray(job.target_ids_json)
  const sources = await fetchSourcesByIds(env, targetIds)
  try {
    const keys = [...new Set(sources.flatMap((source) => [source.raw_key, stagingKey(source.id), finalRawKey(source.id)]).filter(Boolean))]
    if (keys.length > 0) await env.MAIL_RAW.delete(keys)
    for (const key of keys) {
      if (await env.MAIL_RAW.head(key)) throw new Error('raw object still exists after deletion')
    }
    const now = new Date().toISOString()
    const statements = sources.map((source) => env.MAIL_DB.prepare(
      `UPDATE sources
       SET status = 'deleted', message_id = NULL, envelope_from = '', envelope_to = '',
           header_from = NULL, subject = NULL, raw_key = '', raw_size = 0,
           raw_sha256 = '', deleted_at = ?, updated_at = ?
       WHERE id = ? AND status = 'deleting'`,
    ).bind(now, now, source.id))
    statements.push(
      env.MAIL_DB.prepare(
        `UPDATE deliveries SET raw_sha256 = ''
         WHERE source_id IN (${targetIds.map(() => '?').join(', ')})`,
      ).bind(...targetIds),
      env.MAIL_DB.prepare(
        `UPDATE deletion_jobs SET status = 'completed', attempt_count = attempt_count + 1,
         last_error = NULL, updated_at = ?, completed_at = ? WHERE id = ?`,
      ).bind(now, now, job.id),
      env.MAIL_DB.prepare(
        `UPDATE deletion_plans
         SET status = 'completed', targets_json = ?, completed_at = ? WHERE id = ?`,
      ).bind(JSON.stringify(targetIds.map((sourceId) => ({ source_id: sourceId, deleted: true }))), now, job.plan_id),
      env.MAIL_DB.prepare(
        `INSERT INTO audit_events
           (id, actor, action, resource_type, resource_id, detail_json, created_at)
         VALUES (?, 'deletion-worker', 'deletion.completed', 'deletion_job', ?, ?, ?)`,
      ).bind(crypto.randomUUID(), job.id, JSON.stringify({ target_count: targetIds.length }), now),
    )
    await env.MAIL_DB.batch(statements)
  } catch (error) {
    const now = new Date().toISOString()
    const message = (error instanceof Error ? error.message : 'unknown deletion failure').slice(0, 500)
    await env.MAIL_DB.batch([
      env.MAIL_DB.prepare(
        `UPDATE deletion_jobs SET status = 'failed', attempt_count = attempt_count + 1,
         last_error = ?, updated_at = ? WHERE id = ?`,
      ).bind(message, now, job.id),
      env.MAIL_DB.prepare("UPDATE deletion_plans SET status = 'failed' WHERE id = ?").bind(job.plan_id),
    ])
    throw error
  }
}

async function handleExecutePlan(request: Request, planId: string, env: Env): Promise<Response> {
  const body = await readJsonBody(request)
  const plan = await getPlan(env, planId)
  if (plan.status !== 'pending') throw new HttpError(409, 'plan_not_pending', `Deletion plan is ${plan.status}`)
  if (body.confirmation !== 'DELETE' || typeof body.plan_hash !== 'string' || !safeEqual(body.plan_hash, plan.plan_hash)) {
    throw new HttpError(409, 'confirmation_mismatch', 'Exact plan_hash and confirmation DELETE are required')
  }

  const targetIds = parseJsonArray(plan.target_ids_json)
  const sources = await fetchSourcesByIds(env, targetIds)
  if (sources.length !== targetIds.length || sources.some((source) => source.status === 'deleting' || source.status === 'deleted')) {
    throw new HttpError(409, 'stale_plan', 'Deletion targets changed; create a new plan')
  }
  const current = await buildPlanDocument(sources)
  if (!safeEqual(current.hash, plan.plan_hash)) throw new HttpError(409, 'stale_plan', 'Deletion targets changed; create a new plan')

  const now = new Date().toISOString()
  const jobId = crypto.randomUUID()
  const actor = actorFrom(request)
  const statements: D1PreparedStatement[] = [
    env.MAIL_DB.prepare(
      `UPDATE deletion_plans SET status = 'executing', executed_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).bind(now, plan.id),
    env.MAIL_DB.prepare(
      `INSERT INTO deletion_jobs
         (id, plan_id, status, target_ids_json, attempt_count, last_error, created_at, updated_at, completed_at)
       VALUES (?, ?, 'running', ?, 0, NULL, ?, ?, NULL)`,
    ).bind(jobId, plan.id, plan.target_ids_json, now, now),
  ]
  for (const source of sources) {
    statements.push(
      env.MAIL_DB.prepare(
        `UPDATE sources SET status = 'deleting', updated_at = ?
         WHERE id = ? AND status IN ('received_pending', 'ready')`,
      ).bind(now, source.id),
      env.MAIL_DB.prepare(
        `INSERT INTO changes (change_type, entity_type, entity_id, payload_json, created_at)
         VALUES ('source.deleted', 'source', ?, ?, ?)`,
      ).bind(source.id, JSON.stringify({ source_id: source.id, tombstone: true, deletion_job_id: jobId }), now),
    )
  }
  statements.push(env.MAIL_DB.prepare(
    `INSERT INTO audit_events
       (id, actor, action, resource_type, resource_id, detail_json, created_at)
     VALUES (?, ?, 'deletion.executed', 'deletion_plan', ?, ?, ?)`,
  ).bind(crypto.randomUUID(), actor, plan.id, JSON.stringify({
    job_id: jobId,
    plan_hash: plan.plan_hash,
    reported_agent: reportedAgentFrom(request),
  }), now))
  await env.MAIL_DB.batch(statements)

  try {
    await runDeletionJob(env, jobId)
  } catch (error) {
    console.error('deletion job will be retried by scheduled reconciliation', error instanceof Error ? error.message : 'unknown')
  }
  const job = await env.MAIL_DB.prepare('SELECT * FROM deletion_jobs WHERE id = ?').bind(jobId).first<DeletionJobRow>()
  return json({
    job_id: jobId,
    plan_id: plan.id,
    status: job?.status || 'running',
    tombstones_published: targetIds.length,
  }, 202)
}

async function handleGetJob(jobId: string, env: Env): Promise<Response> {
  const job = await env.MAIL_DB.prepare('SELECT * FROM deletion_jobs WHERE id = ?').bind(jobId).first<DeletionJobRow>()
  if (!job) throw new HttpError(404, 'job_not_found', 'Deletion job does not exist')
  return json({
    id: job.id,
    plan_id: job.plan_id,
    status: job.status,
    target_ids: JSON.parse(job.target_ids_json),
    attempt_count: job.attempt_count,
    last_error: job.last_error,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
  })
}

async function handleFetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  try {
    requireAuth(request, env)
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const actor = actorFrom(request)

    if (request.method === 'GET' && path === '/v1/whoami') return await handleWhoAmI(request, env)
    if (request.method === 'GET' && path === '/v1/status') {
      context.waitUntil(audit(env, actor, 'status.read', 'mailbox', null, { reported_agent: reportedAgentFrom(request) }))
      return await handleStatus(env)
    }
    if (request.method === 'GET' && path === '/v1/changes') {
      context.waitUntil(audit(env, actor, 'changes.read', 'change_feed', null, {
        after: url.searchParams.get('after'),
        reported_agent: reportedAgentFrom(request),
      }))
      return await handleChanges(request, env)
    }
    if (request.method === 'GET' && path === '/v1/sources') {
      context.waitUntil(audit(env, actor, 'sources.list', 'source', null, { reported_agent: reportedAgentFrom(request) }))
      return await handleSources(request, env)
    }

    let match = path.match(/^\/v1\/sources\/([a-f0-9-]{36})$/)
    if (request.method === 'GET' && match) {
      context.waitUntil(audit(env, actor, 'source.read', 'source', match[1], { reported_agent: reportedAgentFrom(request) }))
      return await handleSource(match[1], env)
    }
    match = path.match(/^\/v1\/(?:sources|messages)\/([a-f0-9-]{36})\/raw$/)
    if (request.method === 'GET' && match) return await handleRaw(request, match[1], env)

    if (request.method === 'POST' && path === '/v1/deletion-plans') return await handleCreateDeletionPlan(request, env)
    match = path.match(/^\/v1\/deletion-plans\/([a-f0-9-]{36})$/)
    if (request.method === 'GET' && match) return await handleGetPlan(match[1], env)
    match = path.match(/^\/v1\/deletion-plans\/([a-f0-9-]{36})\/execute$/)
    if (request.method === 'POST' && match) return await handleExecutePlan(request, match[1], env)
    match = path.match(/^\/v1\/deletion-jobs\/([a-f0-9-]{36})$/)
    if (request.method === 'GET' && match) return await handleGetJob(match[1], env)

    throw new HttpError(404, 'not_found', 'Route does not exist')
  } catch (error) {
    return errorResponse(error)
  }
}

async function handleQueue(batch: MessageBatch<MailQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (message.body.kind !== 'promote_source') throw new Error('unsupported queue message')
      await promoteSource(env, message.body.source_id)
      message.ack()
    } catch (error) {
      console.error('queue processing failed', error instanceof Error ? error.message : 'unknown')
      message.retry()
    }
  }
}

async function handleScheduled(env: Env): Promise<void> {
  const pending = await env.MAIL_DB.prepare(
    `SELECT id FROM sources WHERE status = 'received_pending' ORDER BY created_at LIMIT 50`,
  ).all<{ id: string }>()
  for (const source of pending.results) {
    try {
      await promoteSource(env, source.id)
    } catch (error) {
      console.error('scheduled source promotion failed', source.id, error instanceof Error ? error.message : 'unknown')
    }
  }

  const jobs = await env.MAIL_DB.prepare(
    `SELECT id FROM deletion_jobs WHERE status IN ('running', 'failed') ORDER BY updated_at LIMIT 20`,
  ).all<{ id: string }>()
  for (const job of jobs.results) {
    try {
      await runDeletionJob(env, job.id)
    } catch (error) {
      console.error('scheduled deletion retry failed', job.id, error instanceof Error ? error.message : 'unknown')
    }
  }

  await env.MAIL_DB.prepare(
    `UPDATE deletion_plans SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= ?`,
  ).bind(new Date().toISOString()).run()
}

const worker = {
  fetch: handleFetch,
  email(message: ForwardableEmailMessage, env: Env, _context: ExecutionContext): Promise<void> {
    return handleEmail(message, env)
  },
  queue(batch: MessageBatch<MailQueueMessage>, env: Env, _context: ExecutionContext): Promise<void> {
    return handleQueue(batch, env)
  },
  scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): void {
    context.waitUntil(handleScheduled(env))
  },
}

export default worker
