import type { FileSnapshot, FileRecovery } from '../editor-kit-v2/file-contract'
import { acknowledgeSaved, recoveryFromSnapshot, type SavedFile } from '../editor-kit-v2/file-recovery'
import type { FileMountSession } from '../editor-kit-v2/file-main'

const sessions = new Map<string, FileMountSession>()
export function fileEditorSession(tabId: string): FileMountSession | undefined { return sessions.get(tabId) }
export function registerFileEditorSession(tabId: string, session: FileMountSession): void {
  const previous = sessions.get(tabId)
  if (previous && previous !== session) throw new Error('file tab already owns an editor session')
  sessions.set(tabId, session)
}
export async function closeFileEditorSession(tabId: string, expected?: { session: FileMountSession; identity: object; raw: string }): Promise<void> {
  const session = sessions.get(tabId)
  if (expected && session !== expected.session) throw new Error('File session changed while closing')
  if (!session) return
  if (expected) await session.closeIfSaved(expected)
  else await session.owner.close()
  if (sessions.get(tabId) === session) sessions.delete(tabId)
}

/** In-memory recovery only: ordinary Markdown files need no sidecar. */
const durable = new WeakMap<FileMountSession, { identity: object; value: SavedFile; recovery: FileRecovery }>()
export type FileSaveRequest = Readonly<{ session: FileMountSession; identity: object; snapshot: FileSnapshot; recovery: FileRecovery }>
export function captureFileSave(tabId: string, raw: string): FileSaveRequest | undefined {
  const session = sessions.get(tabId)
  if (!session) return
  const identity = session.baselineIdentity, snapshot = session.owner.snapshot()
  if (snapshot.raw !== raw) return
  return { session, identity, snapshot, recovery: recoveryFromSnapshot(snapshot) }
}
export function acknowledgeFileSave(tabId: string, raw: string, request: FileSaveRequest | undefined): void {
  if (!request || sessions.get(tabId) !== request.session || request.session.baselineIdentity !== request.identity
    || request.snapshot.raw !== raw || request.session.owner.snapshot().authority !== request.snapshot.authority) return
  const old = durable.get(request.session)
  const value = acknowledgeSaved(old?.identity === request.identity ? old.value : undefined, request.snapshot)
  if (value !== old?.value) durable.set(request.session, { identity: request.identity, value, recovery: request.recovery })
}
export function savedFileEditor(tabId: string): Readonly<{ value: SavedFile; recovery: FileRecovery }> | undefined {
  const session = sessions.get(tabId), saved = session && durable.get(session)
  return saved?.identity === session?.baselineIdentity ? saved : undefined
}
