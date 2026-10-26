import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { executeTaskRequest, nodeVault } from '../../scripts/task-api'

let root: string
const create = { action: 'create', mode: 'background', evidence: '明确由本人负责', authority: { owner_id: 'owner-test', evidence: 'notemd memory owner returned active and unconflicted owner-test' }, input: { title: '提交合同', description: '确认条款后提交', dedupe_key: 'test/1:contract', producer: 'test/1', tags: ['task'], sources: [{ id: 'source-1', resource: 'source/test.md' }], due: '2026-11-06', body: '\n保留正文\n' } }
const auth = { mode: 'explicit_user', evidence: '用户明确请求', producer: 'task-management/1' }
const read = async (id: string) => executeTaskRequest(root, { action: 'read', task_id: id }) as Promise<any>
const add = async () => executeTaskRequest(root, create) as Promise<any>
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'next-task-api-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('shared Task CLI operations', () => {
  it('lists empty vault without creating ledger or stat directory', async () => {
    expect(await executeTaskRequest(root, { action: 'list' })).toMatchObject({ ok: true, tasks: [] })
    expect(await fs.readdir(root)).toEqual([])
  })
  it('creates with stable identity and retries by dedupe without overwriting', async () => {
    const first = await add()
    expect(first.source.generated.by).toBe('test/1')
    expect(first.source.frontmatter.tags).toEqual(['task'])
    expect(first.state).toBe('capture')
    expect((await add()).task_id).toBe(first.task_id)
    expect((await fs.readdir(path.join(root, 'inbox/tasks')))).toHaveLength(1)
    await expect(executeTaskRequest(root, { ...create, input: { ...create.input, title: '另一件事' } })).rejects.toThrow('Dedupe conflict')
    expect((await read(first.task_id)).title).toBe('提交合同')
  })
  it('adds a quoted deadline to a Task that did not have one', async () => {
    const { due: _due, ...input } = create.input
    const task: any = await executeTaskRequest(root, { ...create, input })
    const result: any = await executeTaskRequest(root, { ...auth, action: 'update', task_id: task.task_id, expected_revision: task.revision, patch: { due: '2026-10-30' } })
    expect(result.task.due).toBe('2026-10-30')
    expect(await fs.readFile(path.join(root, task.path), 'utf8')).toContain('due: "2026-10-30"')
  })
  it('rejects background updates and creation lacking ownership evidence', async () => {
    const task = await add()
    await expect(executeTaskRequest(root, { ...auth, action: 'update', mode: 'background', task_id: task.task_id, expected_revision: task.revision, patch: { title: '不能改' } })).rejects.toThrow('background is create-only')
    await expect(executeTaskRequest(root, { ...create, authority: undefined })).rejects.toThrow('authority')
  })
  it('updates a whitelist while preserving identity, unknown fields, source and Markdown body', async () => {
    const task = await add()
    const file = path.join(root, task.path)
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('type: Task', 'type: Task\ncustom: retained'))
    const current = await read(task.task_id)
    const updated: any = await executeTaskRequest(root, { ...auth, action: 'update', task_id: task.task_id, expected_revision: current.revision, patch: { title: '提交确认后的合同', due: '2026-11-08' } })
    expect(updated.task_id).toBe(task.task_id)
    expect(updated.source.created).toBe(task.source.created)
    expect(updated.source.body).toBe(create.input.body)
    expect(updated.source.frontmatter.custom).toBe('retained')
    expect(updated.source.sources).toEqual(task.source.sources)
    expect(updated.source.generated.by).toBe('task-management/1')
    expect(updated.task.due).toBe('2026-11-08')
    await expect(executeTaskRequest(root, { ...auth, action: 'update', task_id: task.task_id, expected_revision: task.revision, patch: { due: null } })).rejects.toThrow('expected_revision')
    await expect(executeTaskRequest(root, { ...auth, action: 'update', task_id: task.task_id, expected_revision: updated.revision, patch: { status: 'done' } })).rejects.toThrow('Unknown')
    await expect(executeTaskRequest(root, { ...auth, action: 'update', task_id: task.task_id, expected_revision: updated.revision, patch: { due: '2026-02-30' } })).rejects.toThrow('YYYY-MM-DD')
  })
  it('completes through NEXT, rejects implicit reopening, and preserves mute on explicit reopen', async () => {
    const task = await add()
    const muted: any = await executeTaskRequest(root, { ...auth, action: 'reminder', reminder: 'mute', task_id: task.task_id, expected_revision: task.revision })
    const doneRequest = { ...auth, action: 'transition', transition: 'done', task_id: task.task_id, expected_revision: muted.revision, operation_id: 'complete-1' }
    const done: any = await executeTaskRequest(root, doneRequest)
    expect(done).toMatchObject({ state: 'closed', outcome: 'done' })
    const replay: any = await executeTaskRequest(root, doneRequest)
    expect(replay).toMatchObject({ changed: false, replayed: true, state: 'closed' })
    const modified: any = await executeTaskRequest(root, { ...auth, action: 'update', task_id: task.task_id, expected_revision: done.revision, patch: { title: '已提交的合同' } })
    expect(modified.state).toBe('closed')
    await expect(executeTaskRequest(root, { ...auth, action: 'transition', transition: 'commit', task_id: task.task_id, expected_revision: modified.revision, operation_id: 'commit-1' })).rejects.toThrow('explicit reopen')
    const reopened: any = await executeTaskRequest(root, { ...auth, action: 'transition', transition: 'reopen', task_id: task.task_id, expected_revision: modified.revision, operation_id: 'reopen-1' })
    expect(reopened).toMatchObject({ state: 'capture', reminder: { status: 'muted' } })
    expect(await executeTaskRequest(root, doneRequest)).toMatchObject({ state: 'capture', changed: false, replayed: true })
    expect((await fs.readFile(path.join(root, task.path), 'utf8'))).not.toMatch(/status:|lane:|done:/)
  })
  it('supports pause and resume but never claims a scheduled reminder', async () => {
    const task = await add()
    const future = new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const paused: any = await executeTaskRequest(root, { ...auth, action: 'reminder', reminder: 'pause', paused_until: future, task_id: task.task_id, expected_revision: task.revision })
    expect(paused.reminder.status).toBe('paused')
    const resumed: any = await executeTaskRequest(root, { ...auth, action: 'reminder', reminder: 'resume', task_id: task.task_id, expected_revision: paused.revision })
    expect(resumed.reminder.status).toBe('automatic')
    await expect(executeTaskRequest(root, { ...auth, action: 'reminder', reminder: 'schedule', task_id: task.task_id, expected_revision: resumed.revision })).rejects.toThrow('scheduler')
  })
  it('blocks legacy suppression rather than clearing it on resume', async () => {
    const task = await add()
    const legacy = JSON.stringify({ closed_items: [{ task_ids: [task.task_id] }] })
    await fs.writeFile(path.join(root, 'stat/closed-reminders.json'), legacy)
    const current = await read(task.task_id)
    expect(current.reminder.status).toBe('legacy')
    await expect(executeTaskRequest(root, { ...auth, action: 'reminder', reminder: 'resume', task_id: task.task_id, expected_revision: current.revision })).rejects.toThrow('repair')
    expect(await fs.readFile(path.join(root, 'stat/closed-reminders.json'), 'utf8')).toBe(legacy)
  })
  it('guards observed bytes and rejects traversal and symlink writes', async () => {
    const io = await nodeVault(root)
    await fs.writeFile(path.join(root, 'observed.md'), 'before')
    await io.guard('observed.md')
    await fs.writeFile(path.join(root, 'observed.md'), 'after')
    await expect(io.port.write('observed.md', 'overwrite')).rejects.toThrow('Conflict')
    await expect(io.port.read('../outside')).rejects.toThrow('Unsafe')
    await fs.symlink(os.tmpdir(), path.join(root, 'linked'))
    const clean = await nodeVault(root)
    await expect(clean.port.write('linked/unsafe', 'x')).rejects.toThrow('Symlinks')
  })
  it('quarantines duplicate identities and rejects human producer claims', async () => {
    await expect(executeTaskRequest(root, { ...create, input: { ...create.input, producer: 'human:bruce/1' } })).rejects.toThrow('non-human')
    const task = await add()
    await fs.copyFile(path.join(root, task.path), path.join(root, 'inbox/tasks/duplicate-task.md'))
    await expect(read(task.task_id)).rejects.toThrow('exactly one valid source')
    await expect(add()).rejects.toThrow('scan has errors')
  })
  it('adds real source attribution when explicitly updating a manual Task', async () => {
    const task = await add()
    const file = path.join(root, task.path)
    const content = await fs.readFile(file, 'utf8')
    const manual = content.replace(/description:.*\n/, '').replace(/tags:\n  - task\n/, '').replace(/  dedupe_key:.*\n/, '').replace(/generated:\n  by:.*\n  at:.*\n/, '').replace(/sources:\n  - resource:.*\n    id:.*\n/, '')
    await fs.writeFile(file, manual)
    const current = await read(task.task_id)
    const request = { ...auth, action: 'update', task_id: task.task_id, expected_revision: current.revision, patch: { title: '用户修改标题' } }
    await expect(executeTaskRequest(root, request)).rejects.toThrow('requires source')
    const result: any = await executeTaskRequest(root, { ...request, source: { id: 'session-user-message', resource: 'agent/session.md' } })
    expect(result.task.dedupe_key).toBe(`task:${task.task_id}`)
    expect(result.source.description).toBeUndefined()
    expect(result.source.frontmatter.tags).toBeUndefined()
    expect(result.source.sources).toEqual([{ id: 'session-user-message', resource: 'agent/session.md' }])
  })
  it('refuses an occupied CLI lock and leaves its owner intact', async () => {
    await fs.mkdir(path.join(root, 'stat'))
    await fs.writeFile(path.join(root, 'stat/.next-task-cli.lock'), 'other process')
    await expect(add()).rejects.toThrow('EEXIST')
    expect(await fs.readFile(path.join(root, 'stat/.next-task-cli.lock'), 'utf8')).toBe('other process')
  })
})
