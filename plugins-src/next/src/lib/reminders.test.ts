import { describe, expect, it, vi } from 'vitest'
import fixtures from '../../../../protocol/fixtures/task-reminder-preferences-v1.json'
import { buildTaskDocument } from './task-source'
import { loadTaskReminders, parseReminderPreference, saveTaskReminder, taskReminderPath } from './reminders'
import type { VaultPort, WorkspaceItem } from './repository'

const ID = fixtures.task_id
const OTHER = '22222222-2222-4222-8222-222222222222'
const now = new Date(fixtures.now)
const path = taskReminderPath(ID)
const sourcePath = 'inbox/tasks/fixture-task.md'
const task: WorkspaceItem = {
  key: ID, kind: 'task', item_kind: 'task', item_id: ID, state: 'capture',
  title: fixtures.task.title, description: fixtures.task.description, body: fixtures.task.body,
  path: sourcePath, created: fixtures.now, task: { version: 1, id: ID, dedupe_key: fixtures.task.dedupe_key },
  proofed: false, orphan: false, relinkCandidates: [], relinkMatch: null,
}
function document(id = ID, description = fixtures.task.description) {
  return buildTaskDocument({ title: fixtures.task.title, description, body: fixtures.task.body, created: fixtures.now,
    task: { version: 1, id, dedupe_key: fixtures.task.dedupe_key } })
}
function vault() {
  const files = new Map([[sourcePath, document()]])
  const port: VaultPort = {
    exists: vi.fn(async (path: string) => ({ exists: files.has(path) })),
    read: vi.fn(async (path: string) => {
      if (!files.has(path)) throw new Error('missing file')
      return { content: files.get(path)! }
    }),
    write: vi.fn(async (path: string, content: string) => { files.set(path, content); return { ok: true as const } }),
    list: vi.fn(async () => ({ entries: [] })), rename: vi.fn(async () => ({ ok: true as const })),
    remove: vi.fn(async () => ({ ok: true as const })), open: vi.fn(async () => undefined),
  }
  return { files, port }
}
function legacy(closed_items: unknown[]) { return JSON.stringify({ schema_version: '1.0', closed_items }) }

describe('shared reminder format', () => {
  it.each(fixtures.invalid_task_ids)('rejects an unsafe Task identity %j', (id) => {
    expect(() => taskReminderPath(id)).toThrow()
  })
  it.each(fixtures.valid)('reads $name', async (fixture) => {
    const { files, port } = vault(); files.set(path, fixture.raw)
    expect(parseReminderPreference(fixture.raw, ID)).toHaveProperty('task_id', ID)
    expect((await loadTaskReminders([task], port, now))[ID]).toMatchObject({ status: fixture.status, raw: fixture.raw })
  })
  it.each(fixtures.invalid)('rejects $name without losing raw bytes', async (fixture) => {
    const { files, port } = vault(); files.set(path, fixture.raw)
    expect(() => parseReminderPreference(fixture.raw, ID)).toThrow()
    expect((await loadTaskReminders([task], port, now))[ID]).toMatchObject({ status: 'error', raw: fixture.raw })
    expect(port.write).not.toHaveBeenCalled()
  })
  it.each(fixtures.legacy)('respects independent legacy $name suppression', async (fixture) => {
    const { files, port } = vault(); files.set('stat/closed-reminders.json', legacy(fixture.closed_items))
    files.set(path, fixtures.valid[0].raw)
    expect((await loadTaskReminders([task], port, now))[ID].status).toBe(fixture.matches ? 'legacy' : 'automatic')
    if (fixture.matches) {
      await expect(saveTaskReminder(task, { policy: 'enabled' }, fixtures.valid[0].raw, port, now)).rejects.toThrow('Legacy')
      expect(port.write).not.toHaveBeenCalled()
    }
  })
})

describe('loading and identity', () => {
  it('defaults missing preferences without writing and excludes unavailable cards', async () => {
    const { port } = vault()
    expect((await loadTaskReminders([task], port, now))[ID]).toEqual({ policy: 'enabled', raw: null, status: 'automatic' })
    expect(await loadTaskReminders([{ ...task, kind: 'idea' }, { ...task, orphan: true }, { ...task, repairReason: 'repair' }, { ...task, task: { version: 1, id: '../escape' } }], port, now)).toEqual({})
    expect(port.write).not.toHaveBeenCalled()
  })
  it('loads legacy once and preserves old missing-version/id formats', async () => {
    const { files, port } = vault(); files.set('stat/closed-reminders.json', JSON.stringify({ closed_items: [{ task_ids: [ID] }] }))
    files.set('inbox/tasks/other-task.md', document(OTHER))
    const other = { ...task, item_id: OTHER, task: { ...task.task!, id: OTHER }, path: 'inbox/tasks/other-task.md' }
    const loaded = await loadTaskReminders([task, other], port, now)
    expect(loaded[ID].status).toBe('legacy'); expect(loaded[OTHER].status).toBe('automatic')
    expect(vi.mocked(port.read).mock.calls.filter(([path]) => path === 'stat/closed-reminders.json')).toHaveLength(1)
  })
  it.each(['{invalid', JSON.stringify({ schema_version: '2.0', closed_items: [] }), legacy([{ id: 2 }]), legacy([{ task_ids: 'bad' }]), legacy([{ match_keywords: [null] }]), '{"closed_items":[],"closed_items":[]}'])('rejects malformed legacy input %s', async (raw) => {
    const { files, port } = vault(); files.set('stat/closed-reminders.json', raw); files.set(path, fixtures.valid[1].raw)
    expect((await loadTaskReminders([task], port, now))[ID]).toMatchObject({ status: 'error', raw: fixtures.valid[1].raw })
    await expect(saveTaskReminder(task, { policy: 'enabled' }, fixtures.valid[1].raw, port, now)).rejects.toThrow()
    expect(port.write).not.toHaveBeenCalled()
  })
  it('uses current source for legacy matches and rejects replaced or duplicate identities', async () => {
    const { files, port } = vault(); files.set('stat/closed-reminders.json', legacy([{ match_keywords: ['new keyword'] }]))
    files.set(sourcePath, document(ID, 'new keyword'))
    expect((await loadTaskReminders([task], port, now))[ID].status).toBe('legacy')
    files.set(sourcePath, document(OTHER))
    expect((await loadTaskReminders([task], port, now))[ID].status).toBe('error')
    files.set(sourcePath, document()); files.delete('stat/closed-reminders.json')
    expect((await loadTaskReminders([task, task], port, now))[ID].status).toBe('error')
    files.delete(sourcePath)
    expect((await loadTaskReminders([task], port, now))[ID].status).toBe('error')
  })
  it('normalizes UUID case for keys, paths and canonical legacy display IDs', async () => {
    const uppercase = 'ABCDEF12-1234-4123-8123-ABCDEF123456'
    const { files, port } = vault(); files.set(sourcePath, document(uppercase))
    const upperTask = { ...task, item_id: uppercase, task: { ...task.task!, id: uppercase } }
    expect(taskReminderPath(uppercase)).toBe(`stat/task-reminders/${uppercase.toLowerCase()}.json`)
    files.set('stat/closed-reminders.json', legacy([{ display_ids: [`xiaobu-task-${uppercase}`] }]))
    expect((await loadTaskReminders([upperTask], port, now))[uppercase.toLowerCase()].status).toBe('legacy')
    expect(() => taskReminderPath('../escape')).toThrow()
  })
})

describe('isolated reminder writes', () => {
  it('writes mute/pause/restore without altering Task, lifecycle or legacy records', async () => {
    const { files, port } = vault(); const original = files.get(sourcePath)
    const legacyRaw = legacy([{ id: 'other', task_ids: [OTHER] }]); files.set('stat/closed-reminders.json', legacyRaw)
    const muted = await saveTaskReminder(task, { policy: 'muted' }, null, port, now)
    expect(muted.status).toBe('muted')
    expect(JSON.parse(muted.raw!)).toEqual({ version: 1, task_id: ID, policy: 'muted', updated_at: fixtures.now })
    const paused = await saveTaskReminder(task, { policy: 'enabled', paused_until: '2026-10-27T02:00:00Z' }, muted.raw, port, now)
    expect(paused.status).toBe('paused')
    const restored = await saveTaskReminder(task, { policy: 'enabled' }, paused.raw, port, now)
    expect(restored.status).toBe('automatic'); expect(restored).not.toHaveProperty('pausedUntil')
    expect(files.get(sourcePath)).toBe(original); expect(files.get('stat/closed-reminders.json')).toBe(legacyRaw)
    expect(vi.mocked(port.write).mock.calls.every(([target]) => target === path)).toBe(true)
  })
  it.each(['2026-10-26T01:59:59Z', fixtures.now, '2026-10-27', '2026-10-27T02:00:00.000Z'])('rejects non-future or invalid pause %s', async (paused_until) => {
    const { port } = vault()
    await expect(saveTaskReminder(task, { policy: 'enabled', paused_until }, null, port, now)).rejects.toThrow()
    expect(port.write).not.toHaveBeenCalled()
  })
  it('rejects stale raw, malformed records and replaced source before writing', async () => {
    const { files, port } = vault(); files.set(path, fixtures.valid[1].raw)
    await expect(saveTaskReminder(task, { policy: 'enabled' }, null, port, now)).rejects.toThrow('changed')
    files.set(path, fixtures.invalid[0].raw)
    await expect(saveTaskReminder(task, { policy: 'enabled' }, fixtures.invalid[0].raw, port, now)).rejects.toThrow()
    files.set(sourcePath, document(OTHER))
    await expect(saveTaskReminder(task, { policy: 'enabled' }, fixtures.invalid[0].raw, port, now)).rejects.toThrow('identity')
    expect(port.write).not.toHaveBeenCalled()
  })
  it('reports a failed write and a mismatched post-write read', async () => {
    const { files, port } = vault()
    vi.mocked(port.write).mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(saveTaskReminder(task, { policy: 'muted' }, null, port, now)).rejects.toThrow('disk unavailable')
    vi.mocked(port.write).mockImplementationOnce(async () => { files.set(path, '{}'); return { ok: true } })
    await expect(saveTaskReminder(task, { policy: 'muted' }, null, port, now)).rejects.toThrow('did not match')
  })
})
