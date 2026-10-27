import { describe, expect, it, vi } from 'vitest'
import { canCompleteWithNote, CompletionNoteError, createCompletionNote, persistCompletionNote } from './completion-note'
import { appendEvent, loadWorkspace, type VaultPort } from './repository'
import { NEXT_PATH, parseLedger } from './ledger'
import { placeEvent, quickPlaceInput } from './events'
import { parseTaskSource } from './task-source'

const id = '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8'
const path = 'inbox/tasks/a-task.md'
const raw = `---\ntype: Task\ntitle: 提交构建\ncreated: 2026-10-27T03:20:00Z\ntask:\n  version: 1\n  id: ${id}\n  priority: P1\ncustom: untouched # keep comment\n---\n原有正文。\n`
const note = '构建已提交。\n\n- 检查签名\n- 保留安装地址 https://example.test/build'
const factory = { now: () => '2026-10-27T05:00:00.000Z', id: () => 'completion-1' }

class MemoryVault implements VaultPort {
  files = new Map([[path, raw]])
  writes: string[] = []
  async exists(name: string) { return { exists: this.files.has(name) || [...this.files.keys()].some((key) => key.startsWith(`${name}/`)) } }
  async list(name: string) { return { entries: [...this.files.keys()].filter((key) => key.startsWith(`${name}/`) && !key.slice(name.length + 1).includes('/')).map((key) => ({ name: key.slice(name.length + 1), is_dir: false })) } }
  async read(name: string) {
    if (!this.files.has(name)) throw new Error(`Missing ${name}`)
    return { content: this.files.get(name)! }
  }
  async write(name: string, value: string) { this.files.set(name, value); this.writes.push(name); return { ok: true as const } }
  async rename(from: string, to: string) { this.files.set(to, (await this.read(from)).content); this.files.delete(from); return { ok: true as const } }
  async remove(name: string) { this.files.delete(name); return { ok: true as const } }
  async open() { return { ok: true } }
}

async function setup() {
  const vault = new MemoryVault()
  const workspace = await loadWorkspace(vault, { wipLimit: 3 })
  vault.writes = []
  const item = workspace.capture[0]
  return { vault, workspace, item, operation: createCompletionNote(item, note, factory) }
}

describe('completion note source-first persistence', () => {
  it.each(['\n', '\r\n'])('preserves original source and multiline note, then completes once (%j)', async (eol) => {
    const { vault, operation } = await setup()
    const original = raw.replace(/\n/g, eol)
    vault.files.set(path, original)
    const saved = await persistCompletionNote(operation, 3, vault)
    const source = vault.files.get(path)!
    expect(source.startsWith(original)).toBe(true)
    expect(source).toContain(note.replace(/\n/g, eol))
    expect(parseTaskSource(path, source).task.id).toBe(id)
    expect(saved.closed[0].projection).toMatchObject({ exit: { kind: 'done' }, last_event_id: 'completion-1' })
    expect(saved.projection.wipLimit).toBe(3)
    expect(parseLedger(vault.files.get(NEXT_PATH)!).events).toEqual([operation.event])
    expect(operation.event).not.toHaveProperty('result')
    expect(vault.writes).toEqual([path, NEXT_PATH])
    await persistCompletionNote(operation, 3, vault)
    expect(vault.writes).toEqual([path, NEXT_PATH])
  })

  it('does not complete when source write fails, and retries with retained text', async () => {
    const { vault, operation } = await setup()
    vi.spyOn(vault, 'write').mockRejectedValueOnce(new Error('disk full'))
    await expect(persistCompletionNote(operation, 3, vault)).rejects.toMatchObject({ noteSaved: false })
    expect(vault.files.get(path)).toBe(raw)
    expect(parseLedger(vault.files.get(NEXT_PATH)!).events).toHaveLength(0)
    await persistCompletionNote(operation, 3, vault)
    expect(vault.files.get(path)!.split('<!-- next-completion:').length).toBe(2)
  })

  it.each(['source-write-ack', 'source-readback', 'ledger-write', 'ledger-write-ack'])('retries %s without duplicate source records or completion events', async (failure) => {
    const { vault, operation } = await setup()
    const write = vault.write.bind(vault), read = vault.read.bind(vault)
    let failed = false
    vi.spyOn(vault, 'write').mockImplementation(async (name, content) => {
      if (!failed && name === path && failure === 'source-write-ack') {
        await write(name, content); failed = true; throw new Error('ack lost')
      }
      if (!failed && name === NEXT_PATH && failure.startsWith('ledger-write')) {
        if (failure.endsWith('-ack')) await write(name, content)
        failed = true; throw new Error('ledger failed')
      }
      return write(name, content)
    })
    vi.spyOn(vault, 'read').mockImplementation(async (name) => {
      if (!failed && failure === 'source-readback' && name === path && vault.writes.includes(path)) {
        failed = true; throw new Error('read failed')
      }
      return read(name)
    })
    await expect(persistCompletionNote(operation, 3, vault)).rejects.toBeInstanceOf(CompletionNoteError)
    await persistCompletionNote(operation, 3, vault)
    expect(vault.files.get(path)!.split('<!-- next-completion:').length).toBe(2)
    expect(parseLedger(vault.files.get(NEXT_PATH)!).events).toEqual([operation.event])
    expect(vault.writes.filter((name) => name === path)).toHaveLength(1)
  })

  it('reports that the note is saved if the ledger write fails', async () => {
    const { vault, operation } = await setup()
    const write = vault.write.bind(vault)
    vi.spyOn(vault, 'write').mockImplementation((name, content) => name === NEXT_PATH ? Promise.reject(new Error('ledger full')) : write(name, content))
    await expect(persistCompletionNote(operation, 3, vault)).rejects.toMatchObject({ noteSaved: true })
    expect(vault.files.get(path)).toContain(note)
    expect(parseLedger(vault.files.get(NEXT_PATH)!).events).toHaveLength(0)
  })

  it.each(['done', 'park'] as const)('refuses a newly %s Task before appending any note', async (action) => {
    const { vault, workspace, item, operation } = await setup()
    await appendEvent(workspace, placeEvent(item, quickPlaceInput(action)), {}, vault)
    vault.writes = []
    await expect(persistCompletionNote(operation, 3, vault)).rejects.toBeInstanceOf(CompletionNoteError)
    expect(vault.files.get(path)).toBe(raw)
    expect(vault.writes).toEqual([])
  })

  it.each(['replaced', 'duplicate', 'malformed-ledger'] as const)('refuses %s identities or contracts before source writes', async (change) => {
    const { vault, operation } = await setup()
    if (change === 'replaced') vault.files.set(path, raw.replace(id, '93d3d6e2-dcc0-4ec0-9869-37cf130a0964'))
    if (change === 'duplicate') vault.files.set('inbox/tasks/duplicate-task.md', raw)
    if (change === 'malformed-ledger') vault.files.set(NEXT_PATH, '---\ntype: Next\nversion: 900\n---\n')
    await expect(persistCompletionNote(operation, 3, vault)).rejects.toBeInstanceOf(CompletionNoteError)
    expect(vault.writes).toEqual([])
  })

  it('finds a renamed Task by UUID and writes to its current path', async () => {
    const { vault, operation } = await setup()
    const renamed = 'inbox/tasks/renamed-task.md'
    await vault.rename(path, renamed)
    const saved = await persistCompletionNote(operation, 3, vault)
    expect(vault.files.has(path)).toBe(false)
    expect(vault.files.get(renamed)).toContain(note)
    expect(saved.closed[0].path).toBe(renamed)
  })

  it('rejects a concurrent source change before write instead of replacing it', async () => {
    const { vault, operation } = await setup()
    const read = vault.read.bind(vault)
    let count = 0
    vi.spyOn(vault, 'read').mockImplementation((name) => {
      if (name === path && ++count === 3) vault.files.set(path, raw + '\n外部补充。\n')
      return read(name)
    })
    await expect(persistCompletionNote(operation, 3, vault)).rejects.toThrow('changed before saving')
    expect(vault.files.get(path)).toBe(raw + '\n外部补充。\n')
    expect(vault.writes).toEqual([])
  })

  it('does not treat an altered record with the same marker as a saved note', async () => {
    const { vault, operation } = await setup()
    await persistCompletionNote(operation, 3, vault)
    vault.files.set(path, vault.files.get(path)!.replace('构建已提交。', '其他记录。'))
    vault.writes = []
    await expect(persistCompletionNote(operation, 3, vault)).rejects.toThrow('saved completion note changed')
    expect(vault.writes).toEqual([])
  })

  it('keeps a written note but never reopens a Task completed elsewhere during this operation', async () => {
    const { vault, workspace, item, operation } = await setup()
    const write = vault.write.bind(vault)
    vi.spyOn(vault, 'write').mockImplementation(async (name, content) => {
      const result = await write(name, content)
      if (name === path) await appendEvent(workspace, placeEvent(item, quickPlaceInput('done')), {}, vault)
      return result
    })
    await expect(persistCompletionNote(operation, 3, vault)).rejects.toMatchObject({ noteSaved: true })
    expect(vault.files.get(path)).toContain(note)
    expect(parseLedger(vault.files.get(NEXT_PATH)!).events).toHaveLength(1)
    await expect(persistCompletionNote(operation, 3, vault)).rejects.toBeInstanceOf(CompletionNoteError)
    expect(parseLedger(vault.files.get(NEXT_PATH)!).events.some((event) => event.action === 'reopen')).toBe(false)
  })

  it('offers this operation only for valid active Tasks and requires a note', async () => {
    const { item } = await setup()
    expect(canCompleteWithNote(item)).toBe(true)
    for (const patch of [{ kind: 'idea' as const }, { state: 'closed' as const }, { state: 'dormant' as const }, { orphan: true }, { repairReason: 'invalid' }]) {
      expect(canCompleteWithNote({ ...item, ...patch })).toBe(false)
    }
    expect(() => createCompletionNote(item, ' \n ')).toThrow('required')
  })
})
