import type { FileMountSession } from '../editor-kit-v2/file-main'

const sessions = new Map<string, FileMountSession>()
export function fileEditorSession(tabId: string): FileMountSession | undefined { return sessions.get(tabId) }
export function registerFileEditorSession(tabId: string, session: FileMountSession): void {
  const previous = sessions.get(tabId)
  if (previous && previous !== session) throw new Error('file tab already owns an editor session')
  sessions.set(tabId, session)
}
export async function closeFileEditorSession(tabId: string): Promise<void> {
  const session = sessions.get(tabId)
  if (!session) return
  await session.owner.close()
  if (sessions.get(tabId) === session) sessions.delete(tabId)
}
