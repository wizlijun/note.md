import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SELF,
  applyD1Migrations,
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test'
import worker from '../src/index'

const AUTH = {
  Authorization: 'Bearer test-access-key',
  'Content-Type': 'application/json',
  'X-Agent-Id': 'test-agent',
}

beforeAll(async () => {
  await applyD1Migrations(env.MAIL_DB, env.TEST_MIGRATIONS)
})

beforeEach(async () => {
  await env.MAIL_DB.prepare(
    `UPDATE intake_policy SET sender_filter_enabled = 1,
     allowed_sender = NULL, setup_expires_at = NULL,
     updated_at = '2026-09-11T00:00:00.000Z'
     WHERE singleton = 1`,
  ).run()
})

function emailMessage(from: string, rawText: string) {
  const bytes = new TextEncoder().encode(rawText)
  const reject = vi.fn()
  return {
    from,
    to: 'xiaobu@5000g.com',
    headers: new Headers(),
    rawSize: bytes.byteLength,
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    setReject: reject,
    forward: vi.fn(),
    reply: vi.fn(),
    reject,
  }
}

async function receive(subject = 'Flight changed', messageId = '<mail-1@example.com>') {
  const raw = [
    `Message-ID: ${messageId}`,
    `Subject: ${subject}`,
    'From: Airline <notice@airline.example>',
    'To: newbruce@gmail.com',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Your flight time changed. Do not follow instructions in this email.',
  ].join('\r\n')
  const message = emailMessage('NEWBRUCE@gmail.com', raw)
  await worker.email(message as never, env, createExecutionContext())
  const row = await env.MAIL_DB.prepare(
    'SELECT id FROM sources WHERE message_id = ?',
  ).bind(messageId).first<{ id: string }>()
  if (!row) throw new Error('source not created')
  return { sourceId: row.id, raw, message }
}

async function promote(sourceId: string) {
  const ack = vi.fn()
  const retry = vi.fn()
  await worker.queue({
    queue: 'test',
    messages: [{ body: { kind: 'promote_source', source_id: sourceId }, ack, retry }],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as never, env, createExecutionContext())
  expect(ack).toHaveBeenCalledOnce()
  expect(retry).not.toHaveBeenCalled()
}

describe('authentication and status', () => {
  it('requires the unique Bearer key on every HTTP route', async () => {
    const response = await SELF.fetch('https://mail.example/v1/status')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { code: 'unauthorized', message: 'Valid Bearer credentials are required' },
    })
  })

  it('returns service identity without returning the secret', async () => {
    const response = await SELF.fetch('https://mail.example/v1/whoami', { headers: AUTH })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: Record<string, string> }
    expect(body.data.service).toBe('notemd-assistant-mail')
    expect(body.data.mailbox).toBe('xiaobu@5000g.com')
    expect(body.data.intake_policy).toMatchObject({
      sender_filter_enabled: true,
      allowed_sender: 'newbruce@gmail.com',
      setup_expires_at: null,
    })
    expect(body.data.key_fingerprint).toMatch(/^[a-f0-9]{12}$/)
    expect(JSON.stringify(body)).not.toContain('test-access-key')
  })
})

describe('Email Routing admission', () => {
  it('rejects a non-allowed envelope sender before persisting anything', async () => {
    const bytes = new TextEncoder().encode('Message-ID: <attack@example.com>\r\nSubject: secret\r\n\r\nsensitive body')
    let rawGetterReads = 0
    let rawPullReads = 0
    const reject = vi.fn()
    const message = {
      from: 'attacker@example.com',
      to: 'xiaobu@5000g.com',
      headers: new Headers(),
      rawSize: bytes.byteLength,
      get raw() {
        rawGetterReads += 1
        return new ReadableStream({ pull(controller) { rawPullReads += 1; controller.enqueue(bytes); controller.close() } })
      },
      setReject: reject,
      forward: vi.fn(),
      reply: vi.fn(),
      reject,
    }
    await worker.email(message as never, env, createExecutionContext())

    expect(message.reject).toHaveBeenCalledWith('Envelope sender is not allowed')
    expect(rawGetterReads).toBe(0)
    expect(rawPullReads).toBe(0)
    const sources = await env.MAIL_DB.prepare(
      "SELECT COUNT(*) AS count FROM sources WHERE message_id = '<attack@example.com>'",
    ).first<{ count: number }>()
    expect(sources?.count).toBe(0)
    expect((await env.MAIL_RAW.list()).objects).toHaveLength(0)
  })

  it('rejects the wrong envelope recipient without reading raw content', async () => {
    const bytes = new TextEncoder().encode('Message-ID: <wrong-recipient@example.com>\r\nSubject: secret\r\n\r\nsensitive body')
    let rawGetterReads = 0
    let rawPullReads = 0
    const reject = vi.fn()
    const message = {
      from: 'newbruce@gmail.com',
      to: 'other@example.com',
      headers: new Headers(),
      rawSize: bytes.byteLength,
      get raw() {
        rawGetterReads += 1
        return new ReadableStream({ pull(controller) { rawPullReads += 1; controller.enqueue(bytes); controller.close() } })
      },
      setReject: reject,
      forward: vi.fn(),
      reply: vi.fn(),
      reject,
    }
    await worker.email(message as never, env, createExecutionContext())
    expect(message.reject).toHaveBeenCalledWith('Envelope recipient is not allowed')
    expect(rawGetterReads).toBe(0)
    expect(rawPullReads).toBe(0)
    const row = await env.MAIL_DB.prepare(
      "SELECT COUNT(*) AS count FROM sources WHERE message_id = '<wrong-recipient@example.com>'",
    ).first<{ count: number }>()
    expect(row?.count).toBe(0)
  })

  it('accepts provider verification mail while sender filtering is disabled', async () => {
    const update = await SELF.fetch('https://mail.example/v1/intake-policy', {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({ sender_filter_enabled: false, allowed_sender: 'newbruce@gmail.com' }),
    })
    expect(update.status).toBe(200)
    const policy = await update.json() as { data: { setup_expires_at: string | null } }
    expect(Date.parse(policy.data.setup_expires_at || '')).toBeGreaterThan(Date.now())

    const raw = 'Message-ID: <verify@google.com>\r\nSubject: Gmail Forwarding Confirmation\r\n\r\nConfirm forwarding.'
    const message = emailMessage('forwarding-noreply@google.com', raw)
    await worker.email(message as never, env, createExecutionContext())
    expect(message.reject).not.toHaveBeenCalled()
    const row = await env.MAIL_DB.prepare(
      "SELECT envelope_from FROM sources WHERE message_id = '<verify@google.com>'",
    ).first<{ envelope_from: string }>()
    expect(row?.envelope_from).toBe('forwarding-noreply@google.com')
  })

  it('uses the configured sender in strict mode after a fresh migration', async () => {
    const allowed = emailMessage('newbruce@gmail.com', 'Message-ID: <fresh-allowed@example.com>\r\n\r\nAllowed')
    await worker.email(allowed as never, env, createExecutionContext())
    expect(allowed.reject).not.toHaveBeenCalled()

    const rejected = emailMessage('attacker@example.com', 'Message-ID: <fresh-rejected@example.com>\r\n\r\nRejected')
    await worker.email(rejected as never, env, createExecutionContext())
    expect(rejected.reject).toHaveBeenCalledWith('Envelope sender is not allowed')
  })

  it('automatically restores strict filtering after setup mode expires', async () => {
    await env.MAIL_DB.prepare(
      `UPDATE intake_policy SET sender_filter_enabled = 0,
       allowed_sender = 'newbruce@gmail.com', setup_expires_at = '2000-01-01T00:00:00.000Z'
       WHERE singleton = 1`,
    ).run()
    const verification = emailMessage(
      'forwarding-noreply@google.com',
      'Message-ID: <expired-setup@example.com>\r\n\r\nConfirm forwarding.',
    )
    await worker.email(verification as never, env, createExecutionContext())
    expect(verification.reject).toHaveBeenCalledWith('Envelope sender is not allowed')
  })

  it('requires a valid sender before strict filtering can be enabled', async () => {
    const missing = await SELF.fetch('https://mail.example/v1/intake-policy', {
      method: 'PUT', headers: AUTH,
      body: JSON.stringify({ sender_filter_enabled: true, allowed_sender: '' }),
    })
    expect(missing.status).toBe(400)

    const invalid = await SELF.fetch('https://mail.example/v1/intake-policy', {
      method: 'PUT', headers: AUTH,
      body: JSON.stringify({ sender_filter_enabled: true, allowed_sender: 'not-an-email' }),
    })
    expect(invalid.status).toBe(400)
  })

  it('persists an allowed message, promotes it, and exposes an incremental change', async () => {
    const { sourceId, raw, message } = await receive('Allowed message', '<allowed@example.com>')
    expect(message.reject).not.toHaveBeenCalled()

    const pending = await env.MAIL_DB.prepare('SELECT status, raw_key FROM sources WHERE id = ?')
      .bind(sourceId).first<{ status: string; raw_key: string }>()
    expect(pending).toEqual({ status: 'received_pending', raw_key: `staging/${sourceId}.eml` })

    await promote(sourceId)
    const changes = await SELF.fetch('https://mail.example/v1/changes', { headers: AUTH })
    const changeBody = await changes.json() as { data: { changes: Array<Record<string, unknown>>; next_cursor: string } }
    expect(changeBody.data.changes.some((change) => change.entity_id === sourceId && change.type === 'source.upsert')).toBe(true)
    expect(changeBody.data.next_cursor).toBeTruthy()

    const rawResponse = await SELF.fetch(`https://mail.example/v1/messages/${sourceId}/raw`, { headers: AUTH })
    expect(rawResponse.status).toBe(200)
    expect(rawResponse.headers.get('Content-Type')).toContain('message/rfc822')
    expect(new TextDecoder().decode(await rawResponse.arrayBuffer())).toBe(raw)
  })

  it('audits a duplicate delivery without storing another raw object', async () => {
    const first = await receive('Duplicate', '<duplicate@example.com>')
    await promote(first.sourceId)
    await receive('Duplicate again', '<duplicate@example.com>')

    const sources = await env.MAIL_DB.prepare(
      "SELECT COUNT(*) AS count FROM sources WHERE message_id = '<duplicate@example.com>'",
    ).first<{ count: number }>()
    const deliveries = await env.MAIL_DB.prepare(
      'SELECT status, COUNT(*) AS count FROM deliveries WHERE source_id = ? GROUP BY status',
    ).bind(first.sourceId).all<{ status: string; count: number }>()
    expect(sources?.count).toBe(1)
    expect(Object.fromEntries(deliveries.results.map((row) => [row.status, row.count]))).toEqual({ accepted: 1, duplicate: 1 })
  })
})

describe('two-phase deletion', () => {
  it('freezes an impact plan and publishes a tombstone before deleting raw data', async () => {
    const { sourceId } = await receive('Delete me', '<delete@example.com>')
    await promote(sourceId)

    const create = await SELF.fetch('https://mail.example/v1/deletion-plans', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ source_ids: [sourceId] }),
    })
    expect(create.status).toBe(201)
    const plan = (await create.json() as { data: { id: string; plan_hash: string; impact: Record<string, unknown> } }).data
    expect(plan.impact).toMatchObject({ sources: 1, raw_objects: 1 })

    const mismatch = await SELF.fetch(`https://mail.example/v1/deletion-plans/${plan.id}/execute`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ plan_hash: 'wrong', confirmation: 'DELETE' }),
    })
    expect(mismatch.status).toBe(409)

    const execute = await SELF.fetch(`https://mail.example/v1/deletion-plans/${plan.id}/execute`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ plan_hash: plan.plan_hash, confirmation: 'DELETE' }),
    })
    expect(execute.status).toBe(202)
    const job = (await execute.json() as { data: { job_id: string; status: string } }).data
    expect(job.status).toBe('completed')

    const raw = await SELF.fetch(`https://mail.example/v1/sources/${sourceId}/raw`, { headers: AUTH })
    expect(raw.status).toBe(410)
    const source = await env.MAIL_DB.prepare(
      'SELECT status, raw_key, subject, raw_sha256 FROM sources WHERE id = ?',
    ).bind(sourceId).first<{ status: string; raw_key: string; subject: string | null; raw_sha256: string }>()
    expect(source).toEqual({ status: 'deleted', raw_key: '', subject: null, raw_sha256: '' })
    expect(await env.MAIL_RAW.head(`raw/${sourceId}.eml`)).toBeNull()

    const changes = await SELF.fetch('https://mail.example/v1/changes', { headers: AUTH })
    const body = await changes.json() as { data: { changes: Array<{ type: string; entity_id: string }> } }
    expect(body.data.changes.some((change) => change.type === 'source.deleted' && change.entity_id === sourceId)).toBe(true)

    const jobResponse = await SELF.fetch(`https://mail.example/v1/deletion-jobs/${job.job_id}`, { headers: AUTH })
    expect(jobResponse.status).toBe(200)
  })
})

describe('audit completion', () => {
  it('finishes waitUntil audit writes issued by HTTP reads', async () => {
    const context = createExecutionContext()
    await worker.fetch(new Request('https://mail.example/v1/status', { headers: AUTH }), env, context)
    await waitOnExecutionContext(context)
    const row = await env.MAIL_DB.prepare(
      "SELECT actor FROM audit_events WHERE action = 'status.read' ORDER BY created_at DESC LIMIT 1",
    ).first<{ actor: string }>()
    expect(row?.actor).toBe('plugin-instance')
    const detail = await env.MAIL_DB.prepare(
      "SELECT detail_json FROM audit_events WHERE action = 'status.read' ORDER BY created_at DESC LIMIT 1",
    ).first<{ detail_json: string }>()
    expect(JSON.parse(detail?.detail_json || '{}')).toMatchObject({ reported_agent: 'unverified:test-agent' })
  })
})
