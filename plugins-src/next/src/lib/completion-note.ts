import { validateAppend } from './domain'
import { defaultEventFactory, placeEvent, type EventFactory } from './events'
import type { SettleEvent } from './model'
import { appendEvent, hostVault, loadWorkspace, type NextWorkspace, type VaultPort, type WorkspaceItem } from './repository'
import { parseTaskSource } from './task-source'

/** Keep this operation unchanged until both source and lifecycle writes succeed. */
export interface CompletionNoteOperation {
  readonly taskId: string
  readonly event: SettleEvent
  readonly note: string
}

export class CompletionNoteError extends Error {
  constructor(readonly noteSaved: boolean, cause: unknown) {
    super(String(cause))
    this.name = 'CompletionNoteError'
  }
}

export function canCompleteWithNote(item: WorkspaceItem): boolean {
  return item.kind === 'task' && Boolean(item.path && item.task?.id && item.item_id === item.task.id)
    && !item.orphan && !item.repairReason
    && ['capture', 'wip', 'waiting'].includes(item.state)
}

export function createCompletionNote(
  item: WorkspaceItem,
  note: string,
  factory: EventFactory = defaultEventFactory,
): CompletionNoteOperation {
  if (!canCompleteWithNote(item)) throw new Error('Task is not available for completion')
  if (!note.trim()) throw new Error('Completion note is required')
  const event = placeEvent(item, { route: 'settle', exit: { kind: 'done' } }, factory, 2) as SettleEvent
  return { taskId: item.task!.id, event, note }
}

/**
 * Source first, lifecycle second. The event id also identifies the appended
 * Markdown record, so a lost acknowledgement can be retried without duplicating
 * either write. Existing source bytes (including YAML) remain untouched.
 */
export async function persistCompletionNote(
  operation: CompletionNoteOperation,
  wipLimit: number,
  port: VaultPort = hostVault,
): Promise<NextWorkspace> {
  let noteSaved = false
  try {
    const workspace = await loadWorkspace(port, { wipLimit, persistSourceDirs: false })
    if (workspace.readOnlyError) throw new Error(workspace.readOnlyError)
    const item = workspace.items.find((candidate) => candidate.kind === 'task' && candidate.item_id === operation.taskId)
    if (!item?.path || item.orphan || item.repairReason || item.task?.id !== operation.taskId) {
      throw new Error('Task source is missing or its identity changed')
    }
    // This also admits a retry of the exact already-persisted completion, but
    // rejects a newly closed/parked Task and never silently reopens it.
    const validation = validateAppend(workspace.projection, operation.event, { ledgerVersion: 2 })
    if (!validation.ok) throw new Error(validation.issues.map((issue) => issue.message).join('; '))
    const current = (await port.read(item.path)).content
    if (parseTaskSource(item.path, current).task.id !== operation.taskId) throw new Error('Task source identity changed')
    const eol = current.includes('\r\n') ? '\r\n' : '\n'
    const marker = `<!-- next-completion:${operation.event.event_id} -->`
    const record = [marker, `## 完成记录 · ${operation.event.at}`, '', operation.note.replace(/\r\n?|\n/g, eol),
      `<!-- /next-completion:${operation.event.event_id} -->`].join(eol)
    if (current.includes(marker)) {
      if (!current.includes(record)) throw new Error('The saved completion note changed; review the Task source before retrying')
      noteSaved = true
    } else {
      if (validation.idempotent) throw new Error('The completed Task no longer contains this note; review its source')
      const updated = `${current}${current.endsWith(eol + eol) ? '' : current.endsWith(eol) ? eol : eol + eol}${record}${eol}`
      parseTaskSource(item.path, updated)
      if ((await port.read(item.path)).content !== current) throw new Error('Task source changed before saving; retry')
      await port.write(item.path, updated)
      if ((await port.read(item.path)).content !== updated) throw new Error('Completion note did not match after writing')
      noteSaved = true
    }
    return await appendEvent(workspace, operation.event, { hardWipLimit: false, wipLimit }, port)
  } catch (error) {
    throw new CompletionNoteError(noteSaved, error)
  }
}
