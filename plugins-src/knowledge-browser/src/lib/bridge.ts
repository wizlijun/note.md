export interface HostBridge {
  pluginId: string
  locale: string
  theme: string
  request(method: string, params?: unknown): Promise<any>
  onMessage?(callback: (payload: unknown) => void): void
}

export interface VaultInfo {
  root: string | null
  wiki_dir: string | null
  daily_dir: string | null
}

export interface VaultEntry {
  name: string
  is_dir: boolean
}

export interface FileViewSnapshot {
  uri: string
  content: string
  viewId: 'knowledge'
  requestId: number
  origin: string
}

export type FileViewConsumer = (
  snapshot: FileViewSnapshot,
  signal: AbortSignal,
) => boolean | void | Promise<boolean | void>

declare global {
  interface Window { notemd?: HostBridge }
}

export function bridge(): HostBridge {
  const value = window.notemd
  if (!value) throw new Error('Knowledge Browser host bridge is unavailable')
  return value
}

export function locale(): string { return bridge().locale }

export function isHostOrigin(origin: string): boolean {
  return origin === 'tauri://localhost' || /^https?:\/\/tauri\.localhost$/.test(origin)
    || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)
}

let activeFileView: Pick<FileViewSnapshot, 'requestId' | 'origin'> | null = null

/**
 * Subscribe to the host-owned, read-only file-view channel. A new snapshot
 * aborts all work owned by the previous one. The consumer returns `false` for
 * unsupported input; thrown errors also request the host's source fallback.
 */
export function onFileViewOpen(consumer: FileViewConsumer): () => void {
  let controller: AbortController | null = null
  let generation = 0
  const receive = (event: MessageEvent) => {
    const data = event.data
    if (event.source !== window.parent || !isHostOrigin(event.origin) || !data
      || data.type !== 'file_view.open' || data.viewId !== 'knowledge'
      || !Number.isSafeInteger(data.requestId) || data.requestId < 0
      || typeof data.content !== 'string' || typeof data.uri !== 'string') return

    controller?.abort()
    const snapshotController = new AbortController()
    controller = snapshotController
    const currentGeneration = ++generation
    const snapshot: FileViewSnapshot = {
      uri: data.uri,
      content: data.content,
      viewId: 'knowledge',
      requestId: data.requestId,
      origin: event.origin,
    }
    activeFileView = { requestId: snapshot.requestId, origin: snapshot.origin }
    void Promise.resolve()
      .then(() => consumer(snapshot, snapshotController.signal))
      .then((supported) => {
        if (currentGeneration !== generation || snapshotController.signal.aborted) return
        if (supported === false) activeFileView = null
        window.parent.postMessage({
          type: supported === false ? 'file_view.fallback' : 'file_view.ready',
          requestId: snapshot.requestId,
        }, snapshot.origin)
      })
      .catch(() => {
        if (currentGeneration !== generation || snapshotController.signal.aborted) return
        activeFileView = null
        window.parent.postMessage({ type: 'file_view.fallback', requestId: snapshot.requestId }, snapshot.origin)
      })
  }
  window.addEventListener('message', receive)
  return () => {
    generation++
    controller?.abort()
    controller = null
    activeFileView = null
    window.removeEventListener('message', receive)
  }
}

/** Ask the host to preserve the current snapshot and reveal its editor. */
export function editFileViewSource(): boolean {
  if (!activeFileView) return false
  const current = activeFileView
  activeFileView = null
  window.parent.postMessage({
    type: 'file_view.fallback',
    requestId: current.requestId,
    reason: 'edit',
  }, current.origin)
  return true
}

export async function vaultInfo(): Promise<VaultInfo> {
  return bridge().request('host.vault.info')
}

export async function vaultList(path: string): Promise<VaultEntry[]> {
  const result = await bridge().request('host.vault.list', { path })
  if (!Array.isArray(result?.entries)) throw new Error('Invalid Vault directory response')
  return result.entries
}

export async function vaultRead(path: string): Promise<string> {
  const result = await bridge().request('host.vault.read', { path })
  if (typeof result?.content !== 'string') throw new Error('Invalid Vault file response')
  return result.content
}

export async function vaultReadBytes(path: string): Promise<string> {
  const result = await bridge().request('host.vault.read_bytes', { path })
  if (typeof result?.base64 !== 'string') throw new Error('Invalid Vault byte response')
  return result.base64
}

export async function vaultExists(path: string): Promise<boolean> {
  const result = await bridge().request('host.vault.exists', { path })
  return result?.exists === true
}

export async function openEditor(path: string, fileView?: string): Promise<void> {
  await bridge().request('host.editor.open', fileView ? { path, fileView } : { path })
}

export async function chooseJsonFile(): Promise<string | null> {
  const result = await bridge().request('host.dialog.open', {
    title: locale().startsWith('zh') ? '选择知识 JSON' : 'Choose knowledge JSON',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    multiple: false,
  })
  return Array.isArray(result?.paths) && typeof result.paths[0] === 'string' ? result.paths[0] : null
}

export async function readDialogText(path: string): Promise<string> {
  const result = await bridge().request('host.fs.read_text', { path })
  if (typeof result?.content !== 'string') throw new Error('Invalid selected file response')
  return result.content
}

export async function copyText(text: string): Promise<void> {
  await bridge().request('host.clipboard.write', { text })
}

export async function settingsGet(): Promise<Record<string, unknown>> {
  const result = await bridge().request('host.settings.get')
  return result?.settings && typeof result.settings === 'object' && !Array.isArray(result.settings)
    ? result.settings as Record<string, unknown> : {}
}

export async function settingsSet(key: string, value: unknown): Promise<void> {
  await bridge().request('host.settings.set', { key, value })
}
