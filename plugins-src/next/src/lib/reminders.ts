import { parseDocument } from 'yaml'
import type { VaultPort, WorkspaceItem } from './repository'
import { parseTaskSource } from './task-source'

export interface ReminderPreference {
  version: 1
  task_id: string
  policy: 'enabled' | 'muted'
  updated_at: string
  paused_until?: string
}

export interface ReminderView {
  policy: 'enabled' | 'muted'
  pausedUntil?: string
  raw: string | null
  status: 'automatic' | 'paused' | 'muted' | 'legacy' | 'error'
  error?: string
}

export type ReminderInput = Pick<ReminderPreference, 'policy' | 'paused_until'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LEGACY_PATH = 'stat/closed-reminders.json'
const PREFERENCE_KEYS = new Set(['version', 'task_id', 'policy', 'updated_at', 'paused_until'])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function taskId(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) throw new Error('Task ID must be a UUID v4')
  return value.toLowerCase()
}

function strictJson(raw: string): unknown {
  // JSON.parse enforces JSON syntax; YAML's parser additionally catches duplicate
  // mapping keys, which JSON.parse would silently discard before validation.
  const value: unknown = JSON.parse(raw)
  if (parseDocument(raw, { uniqueKeys: true }).errors.length) throw new Error('Duplicate or invalid JSON keys')
  return value
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!match || match[0] !== value || Number(match[1].slice(0, 4)) < 1 || match[5] === '-00:00') return false
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false
  if (match[5] !== 'Z' && (Number(match[6]) > 23 || Number(match[7]) > 59)) return false
  const day = new Date(`${match[1]}T00:00:00Z`)
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === match[1]
    && Number.isFinite(Date.parse(value))
}

export function taskReminderPath(id: string): string {
  return `stat/task-reminders/${taskId(id)}.json`
}

export function parseReminderPreference(raw: string, id: string): ReminderPreference {
  const value = strictJson(raw)
  if (!record(value) || Object.keys(value).some((key) => !PREFERENCE_KEYS.has(key))) throw new Error('Invalid reminder preference fields')
  if (value.version !== 1) throw new Error('Unsupported reminder preference version')
  const expectedId = taskId(id)
  if (value.task_id !== expectedId) throw new Error('Reminder Task identity must match its canonical file name')
  if (value.policy !== 'enabled' && value.policy !== 'muted') throw new Error('Invalid reminder policy')
  if (!timestamp(value.updated_at)) throw new Error('Reminder updated_at must be an offset timestamp with second precision')
  if (value.paused_until !== undefined && !timestamp(value.paused_until)) throw new Error('Reminder paused_until must be an offset timestamp with second precision')
  if (value.policy === 'muted' && value.paused_until !== undefined) throw new Error('Muted reminders cannot have a pause deadline')
  return value as unknown as ReminderPreference
}

type LegacyClosure = Record<string, unknown> & {
  id?: string
  task_ids?: string[]
  dedupe_keys?: string[]
  display_ids?: string[]
  match_keywords?: string[]
}

async function readOptional(path: string, port: VaultPort): Promise<string | null> {
  if (!(await port.exists(path)).exists) return null
  return (await port.read(path)).content
}

async function loadLegacy(port: VaultPort): Promise<LegacyClosure[]> {
  const raw = await readOptional(LEGACY_PATH, port)
  if (raw === null) return []
  const value = strictJson(raw)
  if (!record(value) || (value.schema_version !== undefined && value.schema_version !== '1.0') || !Array.isArray(value.closed_items)) throw new Error('Invalid or unsupported legacy reminder ledger')
  for (const entry of value.closed_items) {
    if (!record(entry) || ['id', 'title'].some((key) => entry[key] !== undefined && typeof entry[key] !== 'string')) throw new Error('Invalid legacy reminder closure')
    for (const key of ['task_ids', 'dedupe_keys', 'display_ids', 'match_keywords']) {
      if (entry[key] !== undefined && (!Array.isArray(entry[key]) || !(entry[key] as unknown[]).every((item) => typeof item === 'string'))) {
        throw new Error(`Invalid legacy reminder ${key}`)
      }
    }
  }
  return value.closed_items as LegacyClosure[]
}

function eligibleId(item: WorkspaceItem): string | null {
  if (item.kind !== 'task' || item.orphan || item.repairReason || !item.path) return null
  try { return taskId(item.task?.id) } catch { return null }
}

async function currentTask(item: WorkspaceItem, id: string, port: VaultPort) {
  if (!item.path || eligibleId(item) !== id) throw new Error('Task source is not available for reminder changes')
  if ((item.item_id !== undefined && taskId(item.item_id) !== id)
    || (item.projection?.item_id !== undefined && taskId(item.projection.item_id) !== id)) throw new Error('Task card identity changed')
  const source = parseTaskSource(item.path, (await port.read(item.path)).content)
  if (taskId(source.task.id) !== id) throw new Error('Task source identity changed')
  return source
}

function matchesLegacy(source: Awaited<ReturnType<typeof currentTask>>, entries: LegacyClosure[]): boolean {
  const id = source.task.id.toLowerCase()
  const displayId = `xiaobu-task-${id}`
  const blob = `${source.title} ${source.description ?? ''} ${source.body}`
  return entries.some((entry) => (
    entry.task_ids?.some((value) => value.toLowerCase() === id)
    || Boolean(source.task.dedupe_key && entry.dedupe_keys?.includes(source.task.dedupe_key))
    || entry.display_ids?.some((value) => value === displayId || (value.startsWith('xiaobu-task-') && value.slice('xiaobu-task-'.length).toLowerCase() === id))
    || entry.match_keywords?.some((keyword) => Boolean(keyword) && blob.includes(keyword))
  ))
}

function view(raw: string | null, id: string, now: Date): ReminderView {
  if (raw === null) return { policy: 'enabled', raw, status: 'automatic' }
  const preference = parseReminderPreference(raw, id)
  return {
    policy: preference.policy,
    ...(preference.paused_until ? { pausedUntil: preference.paused_until } : {}),
    raw,
    status: preference.policy === 'muted' ? 'muted'
      : preference.paused_until && Date.parse(preference.paused_until) > now.getTime() ? 'paused' : 'automatic',
  }
}

export async function loadTaskReminders(
  items: WorkspaceItem[], port: VaultPort, now = new Date(),
): Promise<Record<string, ReminderView>> {
  let legacy: LegacyClosure[] = []
  let legacyError: unknown
  try { legacy = await loadLegacy(port) } catch (error) { legacyError = error }
  const result: Record<string, ReminderView> = {}
  const eligible = items.map((item) => ({ item, id: eligibleId(item) })).filter((value) => value.id !== null)
  const duplicates = new Set(eligible.filter((entry, index) => eligible.findIndex((other) => other.id === entry.id) !== index).map((entry) => entry.id))
  await Promise.all(eligible.map(async ({ item, id }) => {
    let raw: string | null = null
    try {
      raw = await readOptional(taskReminderPath(id!), port)
      if (legacyError) throw legacyError
      if (duplicates.has(id)) throw new Error('Duplicate Task identity')
      const source = await currentTask(item, id!, port)
      const current = view(raw, id!, now)
      result[id!] = matchesLegacy(source, legacy) ? { ...current, status: 'legacy' } : current
    } catch (error) {
      result[id!] = { policy: 'enabled', raw, status: 'error', error: String(error) }
    }
  }))
  return result
}

/**
 * Per-Task isolation and stale-snapshot detection, not atomic compare-and-swap:
 * the existing Vault bridge cannot serialize writes from another device/process.
 */
export async function saveTaskReminder(
  item: WorkspaceItem, input: ReminderInput, expectedRaw: string | null,
  port: VaultPort, now = new Date(),
): Promise<ReminderView> {
  const id = eligibleId(item)
  if (!id) throw new Error('Only available Task sources can edit reminders')
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid current time')
  if (expectedRaw !== null && typeof expectedRaw !== 'string') throw new Error('Invalid expected reminder revision')
  if (Object.keys(input).some((key) => key !== 'policy' && key !== 'paused_until')) throw new Error('Invalid reminder input fields')
  const preference: ReminderPreference = {
    version: 1, task_id: id, policy: input.policy,
    updated_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...(input.paused_until !== undefined ? { paused_until: input.paused_until } : {}),
  }
  const serialized = `${JSON.stringify(preference, null, 2)}\n`
  parseReminderPreference(serialized, id)
  if (preference.paused_until && Date.parse(preference.paused_until) <= now.getTime()) throw new Error('Reminder pause deadline must be in the future')
  const source = await currentTask(item, id, port)
  if (matchesLegacy(source, await loadLegacy(port))) throw new Error('Legacy reminder suppression must be resolved at its source')
  const path = taskReminderPath(id)
  const current = await readOptional(path, port)
  if (current !== expectedRaw) throw new Error('Reminder changed; refresh before saving')
  if (current !== null) parseReminderPreference(current, id)
  await port.write(path, serialized)
  const written = (await port.read(path)).content
  if (written !== serialized) throw new Error('Reminder did not match after writing')
  return view(written, id, now)
}
