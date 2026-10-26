import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { isScalar } from 'yaml'
import { loadWorkspace, appendEvent, type VaultPort, type WorkspaceItem } from '../src/lib/repository'
import { buildTaskDocument, parseTaskSource, timestampTaskFileName, DEFAULT_TASK_DIR } from '../src/lib/task-source'
import { editableFrontmatter, serializeEditableFrontmatter } from '../src/lib/frontmatter-document'
import { placeEvent, quickPlaceInput, reopenEvent, type QuickPlaceAction } from '../src/lib/events'
import { loadTaskReminders, saveTaskReminder, taskReminderPath } from '../src/lib/reminders'
import { NEXT_PATH } from '../src/lib/ledger'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function text(value: unknown, name: string): string { assert(typeof value === 'string' && value.trim(), `${name} must be a non-empty string`); return value.trim() }
function producer(value: unknown): string {
  const name = text(value, 'producer')
  assert(/^[^\s/]+\/[^\s/]+$/.test(name) && !/^human(?::|\/)/i.test(name), 'producer must be a non-human producer/version')
  return name
}
function fields(value: Record<string, unknown>, allowed: string[]) { assert(Object.keys(value).every(key => allowed.includes(key)), 'Unknown request fields') }
async function optional(file: string) { try { return await fs.readFile(file, 'utf8') } catch (error: any) { if (error.code === 'ENOENT') return null; throw error } }

/** A lock coordinates this CLI only. Snapshot guards detect observed UI/sync edits;
 * the host has no atomic cross-device CAS, so they cannot prevent every race. */
export async function nodeVault(root: string) {
  const base = await fs.realpath(root)
  const observed = new Map<string, string | null>()
  async function resolve(relative: string) {
    assert(relative !== '' && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'), 'Unsafe Vault path')
    const absolute = path.resolve(base, relative)
    assert(absolute.startsWith(`${base}${path.sep}`), 'Path escapes Vault')
    let current = base
    for (const part of path.relative(base, absolute).split(path.sep)) {
      current = path.join(current, part)
      try { assert(!(await fs.lstat(current)).isSymbolicLink(), 'Symlinks are not supported for Task operations') }
      catch (error: any) { if (error.code !== 'ENOENT') throw error }
    }
    return absolute
  }
  async function guard(relative: string) {
    const value = await optional(await resolve(relative))
    if (observed.has(relative)) assert(observed.get(relative) === value, `Conflict: ${relative} changed; read again`)
    observed.set(relative, value)
    return value
  }
  async function check() {
    for (const [relative, expected] of observed) assert(await optional(await resolve(relative)) === expected, `Conflict: ${relative} changed; read again`)
  }
  const port: VaultPort = {
    async exists(relative) { try { await fs.lstat(await resolve(relative)); return { exists: true } } catch (error: any) { if (error.code === 'ENOENT') return { exists: false }; throw error } },
    async read(relative) {
      const content = await fs.readFile(await resolve(relative), 'utf8')
      if (!observed.has(relative)) observed.set(relative, content)
      return { content }
    },
    async list(relative) { return { entries: (await fs.readdir(await resolve(relative), { withFileTypes: true })).map(entry => ({ name: entry.name, is_dir: entry.isDirectory() })) } },
    async write(relative, content) {
      await check()
      const destination = await resolve(relative)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      const temp = `${destination}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, content, { flag: 'wx' })
        assert(await fs.readFile(temp, 'utf8') === content, 'Temporary write verification failed')
        await check()
        if (observed.has(relative) && observed.get(relative) !== null) await fs.rename(temp, destination)
        else { await fs.link(temp, destination); await fs.unlink(temp) }
        assert(await fs.readFile(destination, 'utf8') === content, 'Write verification failed')
        if (observed.has(relative)) observed.set(relative, content)
      } finally { await fs.rm(temp, { force: true }) }
      return { ok: true }
    },
    async rename(from, to) { await check(); await fs.link(await resolve(from), await resolve(to)); await fs.unlink(await resolve(from)); return { ok: true } },
    async remove(relative) { await fs.unlink(await resolve(relative)); return { ok: true } },
    async open() { throw new Error('Opening the editor is not supported by this CLI') },
  }
  return { port, guard, check, resolve }
}

export async function executeTaskRequest(root: string, request: unknown): Promise<Record<string, any>> {
  assert(record(request), 'Request must be an object')
  fields(request, ['action', 'task_id', 'mode', 'evidence', 'expected_revision', 'operation_id', 'input', 'patch', 'transition', 'reminder', 'paused_until', 'authority', 'producer', 'source'])
  const action = text(request.action, 'action')
  assert(['list', 'read', 'create', 'update', 'transition', 'reminder'].includes(action), 'Unsupported action')
  const mutating = !['list', 'read'].includes(action)
  if (mutating) {
    assert(request.mode === 'explicit_user' || (action === 'create' && request.mode === 'background'), 'Mutation requires explicit_user mode; background is create-only')
    text(request.evidence, 'evidence')
  }
  const io = await nodeVault(root)
  let lock: Awaited<ReturnType<typeof fs.open>> | undefined
  const lockPath = await io.resolve('stat/.next-task-cli.lock')
  try {
    if (mutating) {
      await fs.mkdir(path.dirname(lockPath), { recursive: true })
      lock = await fs.open(lockPath, 'wx')
      await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    }
    const ledgerRaw = await io.guard(NEXT_PATH)
    const workspace = await loadWorkspace(io.port, { persistSourceDirs: false })
    assert(!workspace.readOnlyError, `Ledger is not writable: ${workspace.readOnlyError}`)
    const items = workspace.items.filter(item => item.kind === 'task')
    async function snapshot(item: WorkspaceItem) {
      assert(item.path && item.task && !item.orphan && !item.repairReason, 'Task source needs repair')
      const source = await io.guard(item.path)
      const preference = await io.guard(taskReminderPath(item.task.id))
      const legacy = await io.guard('stat/closed-reminders.json')
      const views = await loadTaskReminders([item], io.port)
      await io.check()
      return { task_id: item.task.id, path: item.path, title: item.title, state: item.state,
        ...(item.projection?.state === 'closed' ? { outcome: item.projection.exit.kind } : {}),
        task: item.task, source: parseTaskSource(item.path, source!), reminder: views[item.task.id.toLowerCase()],
        revision: hash([source, ledgerRaw, preference, legacy]) }
    }
    if (action === 'list') return { ok: true, tasks: await Promise.all(items.filter(item => !item.orphan && !item.repairReason && item.task).map(snapshot)), errors: workspace.scanErrors }
    if (action === 'create') {
      const taskErrors = workspace.scanErrors.filter(error => error.startsWith(`${DEFAULT_TASK_DIR}:`) || error.startsWith(`${DEFAULT_TASK_DIR}/`))
      assert(!taskErrors.length, `Task creation paused while source scan has errors: ${taskErrors.join('; ')}`)
      assert(record(request.authority), 'create requires authority from notemd memory owner --json')
      fields(request.authority, ['owner_id', 'evidence'])
      text(request.authority.owner_id, 'authority.owner_id')
      text(request.authority.evidence, 'authority.evidence')
      const input = request.input
      assert(record(input), 'input must be an object')
      fields(input, ['title', 'description', 'body', 'project', 'priority', 'due', 'contexts', 'done_when', 'dedupe_key', 'sources', 'tags', 'producer'])
      const title = text(input.title, 'input.title')
      const description = text(input.description, 'input.description')
      const dedupe = text(input.dedupe_key, 'input.dedupe_key')
      const producerName = producer(input.producer)
      assert(Array.isArray(input.tags) && input.tags.length && input.tags.every(tag => typeof tag === 'string' && tag.trim()), 'input.tags must be non-empty strings')
      assert(Array.isArray(input.sources) && input.sources.length && input.sources.every(source => record(source) && typeof source.id === 'string' && source.id.trim() && typeof source.resource === 'string' && source.resource.trim()), 'input.sources requires source id and resource')
      const now = new Date()
      const id = randomUUID()
      let content = buildTaskDocument({ title, description, created: now.toISOString(),
        task: { version: 1, id, dedupe_key: dedupe, ...Object.fromEntries(['project', 'priority', 'due', 'contexts', 'done_when'].filter(key => input[key] !== undefined).map(key => [key, input[key]])) },
        generated: { by: producerName, at: now.toISOString() }, sources: input.sources, body: input.body })
      const editable = editableFrontmatter(content, false)
      editable.document.set('tags', input.tags)
      content = serializeEditableFrontmatter(editable)
      const candidate = parseTaskSource(`${DEFAULT_TASK_DIR}/candidate-task.md`, content)
      for (const source of workspace.taskSources ?? []) await io.guard(source.path)
      const existing = items.find(item => item.task?.dedupe_key === dedupe)
      if (existing) {
        const current = await snapshot(existing)
        const semantic = (source: ReturnType<typeof parseTaskSource>) => ({ title: source.title, description: source.description, task: { ...source.task, id: undefined }, body: source.body, sources: source.sources, tags: source.frontmatter.tags })
        assert(hash(semantic(current.source)) === hash(semantic(candidate)), 'Dedupe conflict: existing obligation differs; use explicit update')
        return { ok: true, action, changed: false, ...current }
      }
      assert(!items.some(item => item.task?.id.toLowerCase() === id), 'Task UUID collision')
      const names = (await io.port.exists(DEFAULT_TASK_DIR)).exists ? (await io.port.list(DEFAULT_TASK_DIR)).entries.map(entry => entry.name) : []
      const target = `${DEFAULT_TASK_DIR}/${timestampTaskFileName(now, title, new Set(names))}`
      await io.port.write(target, content)
      return { ok: true, action, changed: true, ...(await executeTaskRequest(root, { action: 'read', task_id: id })) }
    }
    const id = text(request.task_id, 'task_id').toLowerCase()
    const matches = items.filter(item => item.task?.id.toLowerCase() === id)
    assert(matches.length === 1, 'Task UUID must resolve to exactly one valid source')
    const item = matches[0]!
    const before = await snapshot(item)
    if (action === 'read') { await io.check(); return { ok: true, ...before } }
    if (action === 'transition' && request.operation_id) {
      const previous = workspace.ledger.events.find(event => event.event_id === request.operation_id)
      if (previous) {
        const expected = request.transition === 'reopen' ? { action: 'reopen' } : quickPlaceInput(request.transition as QuickPlaceAction)
        assert(expected && previous.item_kind === 'task' && previous.item_id === item.task!.id
          && previous.action === ('route' in expected ? expected.route : expected.action)
          && (request.transition === 'reopen' || previous.status_only === true)
          && hash(previous.exit) === hash('exit' in expected ? expected.exit : undefined), 'operation_id was already used for a different operation')
        return { ok: true, action, changed: false, replayed: true, ...before }
      }
    }
    assert(request.expected_revision === before.revision, 'Conflict: expected_revision is stale or missing; read again')
    let changed = true
    if (action === 'update') {
      const producerName = producer(request.producer)
      assert(record(request.patch) && Object.keys(request.patch).length, 'patch must be a non-empty object')
      fields(request.patch, ['title', 'description', 'project', 'priority', 'due', 'contexts', 'done_when'])
      const original = (await io.port.read(item.path!)).content
      const editable = editableFrontmatter(original, false)
      for (const [key, value] of Object.entries(request.patch)) {
        const location = ['title', 'description'].includes(key) ? [key] : ['task', key]
        if (value === null) { assert(key !== 'title', 'title cannot be removed'); editable.document.deleteIn(location) }
        else {
          const node = editable.document.createNode(value)
          if (key === 'due' && isScalar(node)) node.type = 'QUOTE_DOUBLE'
          editable.document.setIn(location, node)
        }
      }
      let updated = serializeEditableFrontmatter(editable)
      parseTaskSource(item.path!, updated)
      changed = updated !== original
      if (changed) {
        if (!before.source.sources?.length) {
          assert(record(request.source), 'Updating a manual Task requires source {id, resource} for the user request')
          fields(request.source, ['id', 'resource'])
          editable.document.set('sources', [{ id: text(request.source.id, 'source.id'), resource: text(request.source.resource, 'source.resource') }])
        }
        if (!before.source.task.dedupe_key) editable.document.setIn(['task', 'dedupe_key'], `task:${item.task!.id}`)
        editable.document.set('generated', { by: producerName, at: new Date().toISOString() })
        updated = serializeEditableFrontmatter(editable)
        parseTaskSource(item.path!, updated)
        await io.port.write(item.path!, updated)
      }
    } else if (action === 'transition') {
      const transition = text(request.transition, 'transition')
      assert(['commit', 'wait', 'park', 'done', 'stopped', 'transferred', 'reopen'].includes(transition), 'Unsupported transition')
      assert(item.state !== 'closed' || transition === 'reopen', 'Closed Task requires an explicit reopen; it cannot be placed again')
      assert(transition !== 'reopen' || item.state === 'closed', 'Only a closed Task can reopen')
      const operationId = text(request.operation_id, 'operation_id')
      const factory = { now: () => new Date().toISOString(), id: () => operationId }
      const event = transition === 'reopen' ? reopenEvent(item, factory, 2) : placeEvent(item, quickPlaceInput(transition as QuickPlaceAction), factory, 2)
      await appendEvent(workspace, event, {}, io.port)
    } else {
      assert(item.state !== 'closed' && item.state !== 'unsupported', 'Closed or unsupported Task cannot change reminders')
      assert(['mute', 'pause', 'resume'].includes(request.reminder), 'Only mute, pause and resume are supported; scheduled reminders require a scheduler')
      const view = before.reminder
      assert(view && !['legacy', 'error'].includes(view.status), 'Reminder suppression requires repair at its source')
      assert(request.reminder === 'pause' || request.paused_until === undefined, 'paused_until is only valid for pause')
      await saveTaskReminder(item, request.reminder === 'mute' ? { policy: 'muted' } : request.reminder === 'pause' ? { policy: 'enabled', paused_until: text(request.paused_until, 'paused_until') } : { policy: 'enabled' }, view.raw, io.port)
    }
    return { ...(await executeTaskRequest(root, { action: 'read', task_id: id })), action, changed, previous_state: before.state }
  } finally {
    if (lock) { await lock.close(); await fs.unlink(lockPath) }
  }
}
