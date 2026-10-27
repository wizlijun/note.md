import { describe, expect, it, vi } from 'vitest'
import { createKickoffClient } from './client'
import { kickoffCardView } from './button-state'
import { sha256 } from './hash'
import { REGISTRY_PATH, serializeRegistry } from './registry'
import payload from './__fixtures__/payload.json'
import type { WorkspaceItem } from '../repository'
import type { AgentProviders } from '../agent-picker/types'

const taskId = '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8'
const path = 'inbox/tasks/example-task.md'
const raw = `---\r\ntype: Task\r\ntitle: 测试任务\r\ncreated: 2026-10-27T03:20:00Z\r\ntask:\r\n  version: 1\r\n  id: ${taskId}\r\n---\r\n原始正文\r\n`
const providerId = 'notemd.claude-agent'
const item = { kind: 'task', key: taskId, state: 'capture', title: '测试任务', path, orphan: false, task: { version: 1, id: taskId } } as WorkspaceItem

function fixture(verified = true) {
  const files = new Map<string, string>([[path, raw]])
  let current: WorkspaceItem | null = item
  const writes: string[] = []
  const io = {
    exists: vi.fn(async (p: string) => ({ exists: files.has(p) || p === 'inbox/tasks' })),
    read: vi.fn(async (p: string) => { if (!files.has(p)) throw Error(`missing ${p}`); return { content: files.get(p)! } }),
    write: vi.fn(async (p: string, content: string) => { writes.push(p); files.set(p, content); return { ok: true } }),
    list: vi.fn(async () => ({ entries: [...files.keys()].filter(p => p.startsWith('inbox/tasks/')).map(p => ({ name: p.split('/').pop()!, is_dir: false })) })),
    vaultInfo: vi.fn(async () => ({ root: '/vault' })),
    agentProviders: vi.fn(async (): Promise<AgentProviders> => ({ providers: [{ id: providerId, name: 'Claude', max_concurrency: 2, harness: { harness: 'Claude Code', ok: true } }], default: providerId })),
    agentLimits: vi.fn(async () => ({ providers: [{ id: providerId, max_concurrency: 2 }] })),
    agentRun: vi.fn(async () => ({ run_id: 'run-1' })),
    agentStatus: vi.fn(async (): Promise<unknown> => ({ state: 'running', started_at: '2026-10-27T01:00:00Z' })),
    currentItem: vi.fn(async () => current),
  }
  const client = createKickoffClient(io, { verifiedProviders: verified ? [providerId] : [], now: () => '2026-10-27T01:00:00Z', notificationTitles: { ok: '开头已就绪', fail: '开头失败' } })
  const start = () => client.startKickoff({ item, providerId, today: '2026-10-27', consent: true })
  const success = async () => io.agentStatus.mockResolvedValue({ state: 'done', record: { status: 'success', harness: providerId, model: 'model', started_at: '2026-10-27T01:00:00Z', ended_at: '2026-10-27T01:00:12Z' }, terminal_result: { content: JSON.stringify({ ...payload, task_id: taskId, based_on: await sha256(raw) }) } })
  return { files, io, writes, client, start, success, setCurrent: (value: WorkspaceItem | null) => { current = value } }
}

describe('kickoff client', () => {
  it('admits deployed context-only providers without a production whitelist', async () => {
    const f = fixture(false)
    const installed = await f.io.agentProviders()
    installed.providers[0].harness!.capabilities = {
      readonly_context: true, terminal_result: true,
    } as NonNullable<NonNullable<typeof installed.providers[0]['harness']>['capabilities']>
    f.io.agentProviders.mockResolvedValue(installed)
    expect((await f.client.load()).providers[0].harness?.ok).toBe(true)
    await f.start()
    expect(f.io.agentRun).toHaveBeenCalledOnce()
    installed.providers[0].harness!.ok = false
    installed.providers[0].harness!.hint = 'Sign in to this provider'
    const current = await f.client.load()
    expect(current.providers[0].harness?.ok).toBe(false)
    expect(current.providers[0].harness?.hint).toBe('Sign in to this provider')
  })

  it('starts with exact prompt, original UTF-8 hash and notification without paths', async () => {
    const f = fixture()
    const snapshot = await f.start()
    expect(f.io.agentRun).toHaveBeenCalledWith({ task: 'next-task-kickoff', harness: providerId, note_path: `/vault/${path}`, prompt: expect.stringContaining(['schema: next-kickoff/v1', `task_path: ${path}`, `task_id: ${taskId}`, `based_on: ${await sha256(raw)}`, 'lane: inbox', 'today: 2026-10-27', 'skill: skills/task-kickoff/SKILL.md'].join('\n')), notify: { title_ok: '开头已就绪 · 测试任务', title_fail: '开头失败 · 测试任务' } })
    const prompt = (f.io.agentRun.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt
    const packet = JSON.parse(prompt.split('BEGIN NEXT CONTEXT JSON\n')[1].split('\nEND NEXT CONTEXT JSON')[0])
    expect(packet.files[0]).toMatchObject({ path, content: raw })
    expect(prompt).toContain('No tools are available or permitted')
    expect(prompt).toContain('questions 必须 1–3 题')
    expect(snapshot.registry.runs[taskId].run_id).toBe('run-1')
  })
  it('starts a task already in progress with its current lane', async () => {
    const f = fixture()
    f.setCurrent({ ...item, state: 'wip' })
    await f.start()
    expect(f.io.agentRun).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('lane: wip'),
    }))
    expect(f.writes).not.toContain(path)
    expect(f.writes).not.toContain('thinking/next.note.md')
  })
  it.each(['missing', 'identity', 'lane', 'running', 'capacity'])('refuses preflight %s', async reason => {
    const f = fixture()
    if (reason === 'missing') f.files.delete(path)
    if (reason === 'identity') f.files.set(path, raw.replace(taskId, '57691a0e-32ed-48bf-829f-b1377d53db93'))
    if (reason === 'lane') f.setCurrent({ ...item, state: 'closed' })
    if (reason === 'running' || reason === 'capacity') f.files.set(REGISTRY_PATH, serializeRegistry({ version: 1, unread: [], runs: { [reason === 'running' ? taskId : 'other']: { run_id: 'other', harness: providerId, requested_at: 'now', task_path: path, based_on: 'hash', state: 'running', failure: null } } }))
    await expect(f.start()).rejects.toMatchObject({ kind: reason === 'lane' ? 'ineligible' : reason === 'running' ? 'already-running' : reason === 'capacity' ? 'capacity' : 'task-changed' })
    expect(f.io.agentRun).not.toHaveBeenCalled()
  })
  it('disables production providers with reasons', async () => {
    const f = fixture(false)
    expect((await f.client.load([item])).providers[0].harness?.hint).toContain('kickoff-provider-update-required')
    await expect(f.start()).rejects.toMatchObject({ kind: 'provider-unavailable' })
  })
  it('identifies unsupported hosts', async () => {
    const f = fixture()
    f.io.agentProviders.mockRejectedValue(Error('unknown host method: host.agent.providers'))
    expect((await f.client.load()).unsupported).toBe(true)
    await expect(f.start()).rejects.toMatchObject({ kind: 'unsupported' })
  })
  it.each([['', 'start-error'], ['agent_unavailable: gone', 'agent-missing']])('rejects invalid start %s', async (message, kind) => {
    const f = fixture()
    if (message) f.io.agentRun.mockRejectedValue(Error(message))
    else f.io.agentRun.mockResolvedValue({ run_id: '' })
    await expect(f.start()).rejects.toMatchObject({ kind })
    expect(JSON.parse(f.files.get(REGISTRY_PATH)!).runs[taskId]).toMatchObject({ run_id: null, state: 'failed', failure: { kind } })
  })
  it('writes once and discovers renamed results by UUID', async () => {
    const f = fixture()
    await f.start(); await f.success()
    const first = await f.client.reconcile()
    const result = first.results[taskId]
    expect(result.doc.kickoff.duration_seconds).toBe(12)
    expect(first.registry.runs[taskId]).toBeUndefined()
    expect(first.registry.unread).toEqual([taskId])
    const count = f.writes.filter(p => p.endsWith('.kickoff.md')).length
    await f.client.reconcile()
    expect(f.writes.filter(p => p.endsWith('.kickoff.md'))).toHaveLength(count)
    f.files.set('inbox/tasks/renamed.kickoff.md', f.files.get(result.path)!)
    f.files.delete(result.path)
    expect((await f.client.load([item])).results[taskId].path).toBe('inbox/tasks/renamed.kickoff.md')
  })
  it.each(['invalid-output', 'missing-result', 'lost', 'task-changed', 'error', 'timeout', 'cancelled', 'skipped'])('records %s without writing a result', async kind => {
    const f = fixture()
    await f.start()
    if (kind === 'task-changed') { f.files.delete(path); await f.success() }
    else if (kind === 'invalid-output') f.io.agentStatus.mockResolvedValue({ state: 'done', record: { status: 'success' }, terminal_result: { content: '{}' } })
    else if (kind === 'missing-result') f.io.agentStatus.mockResolvedValue({ state: 'done', record: { status: 'success' }, terminal_result: null })
    else if (kind === 'lost') f.io.agentStatus.mockRejectedValue(Error('connection lost'))
    else f.io.agentStatus.mockResolvedValue({ state: 'done', record: { status: kind, stderr_tail: 'details' } })
    expect((await f.client.reconcile()).registry.runs[taskId].failure?.kind).toBe(kind)
    expect(f.writes.some(p => p.endsWith('.kickoff.md'))).toBe(false)
  })
  it('serializes starts and reads to prevent duplicate launches', async () => {
    const f = fixture()
    const results = await Promise.allSettled([f.start(), f.client.load([item]), f.start()])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected'])
    expect(f.io.agentRun).toHaveBeenCalledTimes(1)
  })
  it('does not swallow registry IO errors', async () => {
    const f = fixture()
    f.io.write.mockImplementation(async (p, content) => { if (p === REGISTRY_PATH) throw Error('disk full'); f.files.set(p, content); return { ok: true } })
    await expect(f.start()).rejects.toMatchObject({ kind: 'io-error' })
  })
})

describe('kickoff persistence and human answers', () => {
  it('carries answers forward and rejects an earlier run panel', async () => {
    const f = fixture()
    await f.start()
    await f.success()
    const first = await f.client.reconcile()
    const q = first.results[taskId].doc.kickoff.payload.questions[0]
    const answers = [{ question_id: q.id, question: q.text, decides: q.decides, option_id: q.options[0].id, answer: q.options[0].label, by: 'human:owner', at: '' }]
    const saved = await f.client.saveAnswers({ taskId, runId: 'run-1', answers })
    expect(saved.result.doc.kickoff.answers[0].at).toBe('2026-10-27T01:00:00Z')
    f.io.agentRun.mockResolvedValue({ run_id: 'run-2' })
    await f.start()
    const second = await f.client.reconcile()
    expect(second.results[taskId].doc.kickoff.prior_answers).toEqual([expect.objectContaining({ run_id: 'run-1', answer: answers[0].answer })])
    await expect(f.client.saveAnswers({ taskId, runId: 'run-1', answers })).rejects.toMatchObject({ kind: 'conflict' })
  })
  it('preserves manual edits by reading the current file before saving', async () => {
    const f = fixture()
    await f.start()
    await f.success()
    const result = (await f.client.reconcile()).results[taskId]
    const q = result.doc.kickoff.payload.questions[0]
    f.files.set(result.path, f.files.get(result.path)! + '\n人工修改\n')
    const saved = await f.client.saveAnswers({ taskId, runId: 'run-1', answers: [{ question_id: q.id, question: q.text, decides: q.decides, option_id: null, answer: '人工答案', by: 'human:owner', at: '' }] })
    expect(saved.rerendered).toBe(false)
    expect(saved.result.doc.body).toContain('人工修改')
    expect(saved.result.doc.kickoff.answers[0].answer).toBe('人工答案')
  })
  it('recovers a document write after registry failure without rewriting it', async () => {
    const f = fixture()
    await f.start()
    await f.success()
    const normalWrite = f.io.write.getMockImplementation()!
    f.io.write.mockImplementation(async (p, content) => {
      if (p === REGISTRY_PATH) throw Error('registry disk full')
      return normalWrite(p, content)
    })
    await expect(f.client.reconcile()).rejects.toMatchObject({ kind: 'io-error' })
    f.io.write.mockImplementation(normalWrite)
    const result = await f.client.reconcile()
    expect(result.registry.runs[taskId]).toBeUndefined()
    expect(f.writes.filter(p => p.endsWith('.kickoff.md'))).toHaveLength(1)
  })
  it('merges registry mutations against disk preserving unrelated records', async () => {
    const f = fixture()
    await f.start()
    const registry = JSON.parse(f.files.get(REGISTRY_PATH)!)
    registry.unread.push('another-task')
    f.files.set(REGISTRY_PATH, JSON.stringify(registry))
    await f.client.markRead(taskId)
    expect(f.client.snapshot().registry.unread).toEqual(['another-task'])
    expect(f.client.snapshot().registry.runs[taskId].run_id).toBe('run-1')
  })
  it('refuses to clobber an occupied output path', async () => {
    const f = fixture()
    await f.start()
    await f.success()
    const resultPath = path.replace(/\.md$/, '.kickoff.md')
    f.files.set(resultPath, 'unrelated human file')
    const failed = await f.client.reconcile()
    expect(failed.registry.runs[taskId]).toMatchObject({ state: 'failed', failure: { kind: 'conflict' } })
    expect(JSON.parse(f.files.get(REGISTRY_PATH)!).runs[taskId].state).toBe('failed')
    expect(f.files.get(resultPath)).toBe('unrelated human file')
    const otherId = '57691a0e-32ed-48bf-829f-b1377d53db93'
    const other = { ...item, key: otherId, path: 'inbox/tasks/other-task.md', task: { ...item.task!, id: otherId } }
    f.files.set(other.path!, raw.replaceAll(taskId, otherId))
    f.setCurrent(other)
    await expect(f.client.startKickoff({ item: other, providerId, consent: true })).resolves.toBeDefined()
  })
  it('requires consent before seeding and never overwrites custom templates', async () => {
    const f = fixture()
    await expect(f.client.startKickoff({ item, providerId })).rejects.toMatchObject({ kind: 'consent-required' })
    expect(f.writes).toEqual([])
    f.files.set('.notemd/agent-tasks/next-task-kickoff/CLAUDE.md', 'custom instruction')
    await f.start()
    expect(f.files.get('.notemd/agent-tasks/next-task-kickoff/CLAUDE.md')).toBe('custom instruction')
  })
  it('does not downgrade source existence IO failures to invalid output', async () => {
    const f = fixture()
    await f.start()
    await f.success()
    f.io.exists.mockImplementation(async p => {
      if (p === payload.sources[0].resource) throw Error('source IO unavailable')
      return { exists: f.files.has(p) }
    })
    await expect(f.client.reconcile()).rejects.toMatchObject({ kind: 'io-error' })
    expect(f.client.snapshot().registry.runs[taskId].state).toBe('running')
  })
  it('reports registry read errors and write verification mismatch', async () => {
    const f = fixture()
    await f.start()
    f.io.read.mockRejectedValue(Error('permission denied'))
    await expect(f.client.reconcile()).rejects.toMatchObject({ kind: 'io-error' })
    const other = fixture()
    const normalRead = other.io.read.getMockImplementation()!
    other.io.read.mockImplementation(async p => p === REGISTRY_PATH ? { content: '{}' } : normalRead(p))
    await expect(other.start()).rejects.toMatchObject({ kind: 'io-error' })
  })
})

it('retains a known run after registry failure and blocks duplicate start until recovery', async () => {
  const f = fixture()
  const write = f.io.write.getMockImplementation()!
  f.io.write.mockImplementation(async (p, content) => {
    if (p === REGISTRY_PATH) throw Error('disk temporarily full')
    return write(p, content)
  })
  await expect(f.start()).rejects.toMatchObject({ kind: 'io-error' })
  expect(f.client.snapshot().registry.runs[taskId].run_id).toBe('run-1')
  await expect(f.start()).rejects.toMatchObject({ kind: 'already-running' })
  expect(f.io.agentRun).toHaveBeenCalledTimes(1)
  f.io.write.mockImplementation(write)
  await f.client.reconcile()
  expect(JSON.parse(f.files.get(REGISTRY_PATH)!).runs[taskId].run_id).toBe('run-1')
})

it('uses answers changed while the status request was in flight during regeneration', async () => {
  const f = fixture()
  await f.start()
  await f.success()
  const first = (await f.client.reconcile()).results[taskId]
  f.io.agentRun.mockResolvedValue({ run_id: 'run-2' })
  await f.start()
  const originalStatus = f.io.agentStatus.getMockImplementation()!
  f.io.agentStatus.mockImplementation(async (...args) => {
    const current = f.files.get(first.path)!
    const changed = current.replace('answers: []', 'answers:\n    - question_id: q1\n      question: changed\n      decides: next_action\n      option_id: null\n      answer: latest human answer\n      by: human:owner\n      at: "2026-10-27T01:00:01Z"')
    f.files.set(first.path, changed)
    return originalStatus(...args)
  })
  const next = await f.client.reconcile()
  expect(next.results[taskId].doc.kickoff.prior_answers[0].answer).toBe('latest human answer')
})

it('preserves and reports malformed existing results including renamed files', async () => {
  const f = fixture()
  await f.client.load([item])
  const badPath = 'inbox/tasks/renamed.kickoff.md'
  f.files.set(badPath, `---\ntype: Task Kickoff\nkickoff: {task_id: ${taskId}, answers: human-data}\n---\nkeep me`)
  const loaded = await f.client.load([item])
  expect(loaded.statuses[taskId]).toMatchObject({ state: 'failed', failure: { kind: 'conflict', message: expect.stringContaining(badPath) } })
  expect(kickoffCardView({ status: loaded.statuses[taskId] }, 0)).toMatchObject({ state: 'failed', failure: { kind: 'conflict' } })
  await expect(f.start()).rejects.toMatchObject({ kind: 'conflict' })
  expect(f.io.agentRun).not.toHaveBeenCalled()
  expect(f.files.get(badPath)).toContain('human-data')
  expect(f.writes).toEqual([])
})

it('checks the selected provider limit even without a running registered task', async () => {
  const f = fixture()
  f.io.agentLimits.mockResolvedValue({ providers: [{ id: providerId, max_concurrency: 0 }] })
  await expect(f.start()).rejects.toMatchObject({ kind: 'capacity' })
  expect(f.io.agentRun).not.toHaveBeenCalled()
})

it('leaves the last successful document byte-identical when a later run fails', async () => {
  const f = fixture()
  await f.start()
  await f.success()
  const previous = (await f.client.reconcile()).results[taskId]
  const content = f.files.get(previous.path)
  f.io.agentRun.mockResolvedValue({ run_id: 'run-2' })
  await f.start()
  f.io.agentStatus.mockResolvedValue({ state: 'done', record: { status: 'error', stderr_tail: 'new run failed', warning: 'credentials expired' } })
  const next = await f.client.reconcile()
  expect(f.files.get(previous.path)).toBe(content)
  expect(next.registry.runs[taskId].failure).toMatchObject({ kind: 'error', warning: 'credentials expired' })
  expect(next.results[taskId].doc.kickoff.run_id).toBe('run-1')
})

it('routes status back to the exact provider that started the run', async () => {
  const f = fixture()
  await f.start()
  await f.client.reconcile()
  expect(f.io.agentStatus).toHaveBeenCalledWith('next-task-kickoff', 'run-1', providerId)
})

it.each([undefined, false, 'true'])('refuses an existing task template with strict_readonly=%s', async strict => {
  const f = fixture()
  const templatePath = '.notemd/agent-tasks/next-task-kickoff/task.json'
  const content = JSON.stringify({ name: 'custom', strict_readonly: strict })
  f.files.set(templatePath, content)
  await expect(f.start()).rejects.toMatchObject({ kind: 'start-error' })
  expect(f.io.agentRun).not.toHaveBeenCalled()
  expect(f.files.get(templatePath)).toBe(content)
})

it('follows a renamed running Task by UUID while preserving the existing result path', async () => {
  const f = fixture()
  await f.start()
  await f.success()
  const previous = (await f.client.reconcile()).results[taskId]
  f.io.agentRun.mockResolvedValue({ run_id: 'run-2' })
  await f.start()
  const renamedPath = 'inbox/tasks/renamed-task.md'
  f.files.set(renamedPath, f.files.get(path)!)
  f.files.delete(path)
  f.setCurrent({ ...item, path: renamedPath })
  const next = await f.client.reconcile()
  expect(next.results[taskId].doc.kickoff.run_id).toBe('run-2')
  expect(next.results[taskId].path).toBe(previous.path)
  expect(next.results[taskId].doc.metadata.sources).toContainEqual({ resource: renamedPath })
})

it('never lets a caller assign the answer actor as human:local', async () => {
  const f = fixture()
  await f.start()
  await f.success()
  const result = (await f.client.reconcile()).results[taskId]
  const q = result.doc.kickoff.payload.questions[0]
  const saved = await f.client.saveAnswers({ taskId, runId: 'run-1', answers: [{ question_id: q.id, question: q.text, decides: q.decides, option_id: null, answer: 'answer', by: 'human:local', at: '' }] })
  expect(saved.result.doc.kickoff.answers[0].by).toBe('human:owner')
})

it('detects an external edit while asynchronous answer hashing is in flight', async () => {
  const f = fixture()
  await f.start()
  await f.success()
  const result = (await f.client.reconcile()).results[taskId]
  const before = f.files.get(result.path)!
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    const value = await digest(...args)
    f.files.set(result.path, before + '\nnew human edit\n')
    return value
  })
  try {
    await expect(f.client.saveAnswers({ taskId, runId: 'run-1', answers: [] })).rejects.toMatchObject({ kind: 'conflict' })
    expect(f.files.get(result.path)).toBe(before + '\nnew human edit\n')
  } finally { spy.mockRestore() }
})

it.each([
  ['notemd.claude-agent'], ['notemd.codex-agent'], ['notemd.deepseek-agent'],
  ['notemd.claude-agent', 'notemd.codex-agent'], ['notemd.codex-agent', 'notemd.deepseek-agent'],
  ['notemd.claude-agent', 'notemd.codex-agent', 'notemd.deepseek-agent'], [],
])('uses the host installed provider list %j with every production safety gate retained', async (...ids) => {
  const f = fixture(false)
  f.io.agentProviders.mockResolvedValue({ providers: ids.map(id => ({ id, name: id, max_concurrency: 2, harness: { harness: id, ok: true } })), default: ids[0] ?? '' })
  const snapshot = await f.client.load([item])
  expect(snapshot.providers.map(p => p.id)).toEqual(ids)
  expect(snapshot.providers.every(p => p.harness?.ok === false && p.harness.hint?.includes('kickoff-provider-update-required'))).toBe(true)
  expect(snapshot.providerDefault).toBe(ids[0] ?? '')
})

it('refreshes install and uninstall changes without inventing a fallback provider', async () => {
  const f = fixture(false)
  expect((await f.client.load()).providers.map(p => p.id)).toEqual([providerId])
  f.io.agentProviders.mockResolvedValue({ providers: [{ id: 'notemd.codex-agent', name: 'Codex', max_concurrency: 1, harness: { harness: 'Codex', ok: true } }], default: 'notemd.codex-agent' })
  expect((await f.client.load()).providers.map(p => p.id)).toEqual(['notemd.codex-agent'])
  f.io.agentProviders.mockResolvedValue({ providers: [], default: '' })
  expect((await f.client.load()).providers).toEqual([])
})

it.each([
  { max_turns: undefined }, { timeout_seconds: undefined }, { max_turns: 41 }, { timeout_seconds: 601 },
  { max_turns: 0 }, { timeout_seconds: -1 }, { max_turns: 1.5 }, { timeout_seconds: '600' },
])('rejects unsafe or missing execution budget %j without overwriting task.json', async patch => {
  const f = fixture()
  const templatePath = '.notemd/agent-tasks/next-task-kickoff/task.json'
  const content = JSON.stringify({ strict_readonly: true, max_turns: 40, timeout_seconds: 600, ...patch })
  f.files.set(templatePath, content)
  await expect(f.start()).rejects.toMatchObject({ kind: 'start-error' })
  expect(f.io.agentRun).not.toHaveBeenCalled()
  expect(f.files.get(templatePath)).toBe(content)
})

it('accepts an existing strict template with lower budgets and preserves its bytes', async () => {
  const f = fixture()
  const templatePath = '.notemd/agent-tasks/next-task-kickoff/task.json'
  const content = '{ "strict_readonly": true, "max_turns": 10, "timeout_seconds": 60, "prompt": "custom" }'
  f.files.set(templatePath, content)
  await f.start()
  expect(f.files.get(templatePath)).toBe(content)
  expect(f.io.agentRun).toHaveBeenCalledOnce()
})

it('persists a failed start across client reload while preserving other registry records', async () => {
  const f = fixture()
  f.files.set(REGISTRY_PATH, serializeRegistry({ version: 1, unread: ['other'], runs: { other: { run_id: 'previous', harness: 'other-provider', requested_at: 'before', task_path: 'inbox/tasks/other-task.md', based_on: 'hash', state: 'failed', failure: { kind: 'error', message: 'previous', at: 'before' } } } }))
  f.io.agentRun.mockRejectedValue(Error('agent_unavailable: missing'))
  await expect(f.start()).rejects.toMatchObject({ kind: 'agent-missing' })
  const reopened = createKickoffClient(f.io)
  const loaded = await reopened.load([item])
  expect(loaded.registry.runs[taskId]).toMatchObject({ run_id: null, state: 'failed', failure: { kind: 'agent-missing' } })
  expect(loaded.registry.runs.other.run_id).toBe('previous')
  expect(loaded.registry.unread).toEqual(['other'])
  await reopened.reconcile()
  expect(f.io.agentStatus).not.toHaveBeenCalled()
})

it('applies localized notification prefixes supplied by the UI', async () => {
  const f = fixture()
  const client = createKickoffClient(f.io, { verifiedProviders: [providerId], notificationTitles: { ok: '準備完了', fail: '準備失敗' } })
  await client.startKickoff({ item, providerId, consent: true })
  expect(f.io.agentRun).toHaveBeenCalledWith(expect.objectContaining({ notify: { title_ok: '準備完了 · 测试任务', title_fail: '準備失敗 · 测试任务' } }))
})

it('passes the recorded provider through the actual bridge status request', async () => {
  const { agentStatus } = await import('../bridge')
  const request = vi.fn(async () => ({ state: 'running' }))
  vi.stubGlobal('window', { notemd: { request } })
  try {
    await agentStatus('next-task-kickoff', 'codex-run', 'notemd.codex-agent')
    expect(request).toHaveBeenCalledWith('host.agent.status', { task: 'next-task-kickoff', run_id: 'codex-run', harness: 'notemd.codex-agent' })
  } finally { vi.unstubAllGlobals() }
})

it('retains installed agents whose harness probe is unavailable', async () => {
  const f = fixture(false)
  f.io.agentProviders.mockResolvedValue({ providers: [{ id: 'notemd.deepseek-agent', name: 'DeepSeek', harness: null }], default: 'notemd.deepseek-agent' })
  const loaded = await f.client.load()
  expect(loaded.providers.map(p => p.id)).toEqual(['notemd.deepseek-agent'])
  expect(loaded.providers[0].harness).toMatchObject({ ok: false, hint: 'kickoff-provider-update-required' })
})

it('queries the recorded provider after default changes and a fresh client reopens', async () => {
  const f = fixture()
  await f.start()
  f.io.agentProviders.mockResolvedValue({ providers: [{ id: 'notemd.codex-agent', name: 'Codex', harness: { harness: 'Codex', ok: true } }], default: 'notemd.codex-agent' })
  await f.client.load([item])
  await f.client.reconcile()
  const reopened = createKickoffClient(f.io)
  await reopened.load([item])
  await reopened.reconcile()
  expect(f.io.agentStatus.mock.calls).toEqual([
    ['next-task-kickoff', 'run-1', providerId],
    ['next-task-kickoff', 'run-1', providerId],
  ])
})

it('writes a first result beside the current UUID-matched Task after rename', async () => {
  const f = fixture()
  await f.start()
  await f.success()
  const renamedPath = 'inbox/tasks/new-title-task.md'
  f.files.set(renamedPath, raw + 'updated after start\n')
  f.files.delete(path)
  f.setCurrent({ ...item, path: renamedPath })
  const next = await f.client.reconcile()
  expect(next.results[taskId].path).toBe('inbox/tasks/new-title-task.kickoff.md')
  expect(next.results[taskId].doc.kickoff.based_on).toBe(await sha256(raw))
})

it('preserves a previous result while a real no-id start failure survives reopening', async () => {
  const f = fixture()
  await f.start()
  await f.success()
  const previous = (await f.client.reconcile()).results[taskId]
  const content = f.files.get(previous.path)
  f.io.agentRun.mockRejectedValue(Error('launch refused'))
  await expect(f.start()).rejects.toMatchObject({ kind: 'start-error' })
  expect(f.files.get(previous.path)).toBe(content)
  const reopened = createKickoffClient(f.io)
  const loaded = await reopened.load([item])
  expect(loaded.registry.runs[taskId]).toMatchObject({ state: 'failed', run_id: null, failure: { kind: 'start-error' } })
  expect(loaded.results[taskId].doc.kickoff.run_id).toBe('run-1')
})

it.each(['', 'invalid'])('falls back to requested_at for invalid terminal started_at %s', async started => {
  const f = fixture()
  await f.start()
  await f.success()
  const status = await f.io.agentStatus() as { record: Record<string, unknown> }
  status.record.started_at = started
  f.io.agentStatus.mockResolvedValue(status)
  const result = (await f.client.reconcile()).results[taskId]
  expect(result.doc.kickoff.duration_seconds).toBe(12)
})


it('isolates unidentifiable malformed and duplicate results from healthy Tasks', async () => {
  const f = fixture()
  await f.start(); await f.success()
  const original = (await f.client.reconcile()).results[taskId]
  const otherId = '57691a0e-32ed-48bf-829f-b1377d53db93'
  const otherPath = 'inbox/tasks/other-task.kickoff.md'
  f.files.set(otherPath, original.doc.raw.replaceAll(taskId, otherId))
  f.files.set('inbox/tasks/copy.kickoff.md', original.doc.raw)
  f.files.set('inbox/tasks/unidentifiable.kickoff.md', 'broken human text')
  const bytes = new Map(f.files)
  const loaded = await f.client.load([item])
  expect(loaded.results[otherId].path).toBe(otherPath)
  expect(loaded.results[taskId]).toBeUndefined()
  expect(loaded.statuses[taskId]).toMatchObject({ state: 'failed', failure: { kind: 'conflict' } })
  await expect(f.client.saveAnswers({ taskId, runId: 'run-1', answers: [] })).rejects.toMatchObject({ kind: 'conflict' })
  const reconciled = await f.client.reconcile()
  expect(reconciled.results[otherId].path).toBe(otherPath)
  expect(f.files).toEqual(bytes)
})

it('persists terminal conflicts from a result changed during reconciliation', async () => {
  const f = fixture()
  await f.start(); await f.success()
  const first = (await f.client.reconcile()).results[taskId]
  f.io.agentRun.mockResolvedValue({ run_id: 'run-2' })
  await f.start()
  f.io.agentStatus.mockImplementation(async () => {
    f.files.set(first.path, 'changed human bytes')
    return { state: 'done', record: { status: 'success' }, terminal_result: { content: JSON.stringify({ ...payload, task_id: taskId, based_on: await sha256(raw) }) } }
  })
  const next = await f.client.reconcile()
  expect(next.registry.runs[taskId]).toMatchObject({ state: 'failed', failure: { kind: 'conflict' } })
  expect(f.files.get(first.path)).toBe('changed human bytes')
})


it('finishes a healthy run despite an unrelated malformed result file', async () => {
  const f = fixture()
  await f.start(); await f.success()
  const badPath = 'inbox/tasks/unrelated.kickoff.md'
  f.files.set(badPath, 'unidentified human content')
  const next = await f.client.reconcile()
  expect(next.results[taskId].doc.kickoff.run_id).toBe('run-1')
  expect(next.registry.runs[taskId]).toBeUndefined()
  expect(f.files.get(badPath)).toBe('unidentified human content')
})

it('clears a discovery conflict when its damaged file is removed', async () => {
  const f = fixture()
  const badPath = path.replace(/\.md$/, '.kickoff.md')
  f.files.set(badPath, 'human bytes')
  expect((await f.client.load([item])).statuses[taskId].state).toBe('failed')
  f.files.delete(badPath)
  const next = await f.client.load([item])
  expect(next.statuses[taskId]).toBeUndefined()
  await expect(f.start()).resolves.toBeDefined()
})

it('isolates unreadable or vanished result files while reconciling a healthy Task', async () => {
  const f = fixture()
  await f.start(); await f.success()
  const badPath = 'inbox/tasks/unreadable.kickoff.md'
  f.files.set(badPath, 'unreadable bytes')
  const read = f.io.read.getMockImplementation()!
  f.io.read.mockImplementation(async p => {
    if (p === badPath) throw Error('file is unavailable')
    return read(p)
  })
  const next = await f.client.reconcile()
  expect(next.results[taskId].doc.kickoff.run_id).toBe('run-1')
  expect(f.files.get(badPath)).toBe('unreadable bytes')
})

it('isolates Task hash read failures and recovers when the file is readable', async () => {
  const f = fixture()
  await f.client.load([item])
  const otherId = '57691a0e-32ed-48bf-829f-b1377d53db93'
  const other = { ...item, key: otherId, path: 'inbox/tasks/other-task.md', task: { ...item.task!, id: otherId } }
  f.files.set(other.path!, raw.replaceAll(taskId, otherId))
  const read = f.io.read.getMockImplementation()!
  f.io.read.mockImplementation(async p => {
    if (p === path) throw Error('task is temporarily unreadable')
    return read(p)
  })
  const next = await f.client.load([item, other])
  expect(next.hashes[taskId]).toBeUndefined()
  expect(next.hashes[otherId]).toBeDefined()
  expect(next.statuses[taskId]).toMatchObject({ state: 'failed', failure: { kind: 'io-error', message: expect.stringContaining(path) } })
  f.io.read.mockImplementation(read)
  const recovered = await f.client.load([item, other])
  expect(recovered.hashes[taskId]).toBeDefined()
  expect(recovered.statuses[taskId]).toBeUndefined()
})


it('attributes an unreadable known result to its Task without returning stale data', async () => {
  const f = fixture()
  await f.start(); await f.success()
  const first = (await f.client.reconcile()).results[taskId]
  const read = f.io.read.getMockImplementation()!
  f.io.read.mockImplementation(async p => {
    if (p === first.path) throw Error('read denied')
    return read(p)
  })
  const next = await f.client.load([item])
  expect(next.results[taskId]).toBeUndefined()
  expect(next.statuses[taskId]).toMatchObject({ state: 'failed', failure: { kind: 'io-error', message: expect.stringContaining(first.path) } })
  expect(f.files.get(first.path)).toBe(first.doc.raw)
})
