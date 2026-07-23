// Typed accessor for the host-injected `window.notemd` fetch-RPC bridge.
// A plugin window has ZERO Tauri IPC; every host effect goes through
// `notemd.request(method, params)`.

export interface NotemdBridge {
  pluginId: string
  locale: string // 'en' | 'zh' | 'ja' | 'de'
  theme: string
  request(method: string, params?: unknown): Promise<any>
  onMessage(cb: (payload: unknown) => void): void
}

declare global {
  interface Window {
    notemd: NotemdBridge
  }
}

export function bridge(): NotemdBridge {
  const b = window.notemd
  if (!b) throw new Error('window.notemd bridge missing (not running inside a plugin window)')
  return b
}

export interface VaultInfo {
  root: string | null
  wiki_dir: string | null
  daily_dir: string | null
}

/** `host.vault.info` → root + configured wiki/daily dir names. */
export function vaultInfo(): Promise<VaultInfo> {
  return bridge().request('host.vault.info')
}

/** `host.vault.exists` → whether a vault-relative path exists. */
export async function vaultExists(path: string): Promise<boolean> {
  const res: { exists: boolean } = await bridge().request('host.vault.exists', { path })
  return res.exists
}

/** `host.vault.list` → directory entries (name + is_dir), sorted by name. */
export async function vaultList(path: string): Promise<{ name: string; is_dir: boolean }[]> {
  const res: { entries: { name: string; is_dir: boolean }[] } = await bridge().request('host.vault.list', { path })
  return res.entries
}

/** `host.editor.open` — open a vault-relative file in the main editor (focuses main window). */
export async function openInEditor(path: string): Promise<void> {
  await bridge().request('host.editor.open', { path })
}

/** `host.toast` — surface a message through the host toast system (best-effort). */
export async function toast(level: 'success' | 'info' | 'warn' | 'error', message: string, detail?: string): Promise<void> {
  try {
    await bridge().request('host.toast', { level, message, detail })
  } catch {
    /* best-effort */
  }
}
