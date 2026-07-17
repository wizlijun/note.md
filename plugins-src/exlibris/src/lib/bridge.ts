// src/lib/bridge.ts — typed accessor for the host-injected `window.notemd`
// bridge (see src-tauri/src/plugin_runtime/windows.rs bridge_script).
//
// A plugin window has ZERO Tauri IPC. exlibris is pure request-response (NO
// streaming): every operation the UI needs — the 15 backend commands plus the
// host's dialog picker — goes through `window.notemd.request()`.
//
//  1. Backend commands (the plugin's own API): `request(method, params)` below
//     prefixes `plugin.` so the host forwards the call to THIS plugin's backend
//     process as `ui.request`; the process strips the prefix and dispatches the
//     clean name (ping / calibre_detect / fs_atomic_copy / …) via on_ui_request.
//  2. Host methods (dialog pickers): `hostRequest('host.dialog.open', …)` calls
//     the host directly (no prefix) — the host serves it locally under the
//     `dialog` capability and returns `{ paths }`.

/** The bridge surface the host injects as an initialization script. */
export interface NotemdBridge {
  pluginId: string
  /** BCP-ish locale code the host resolved from settings. exlibris is English-only. */
  locale: string
  /** Active UI theme id (unused by this plugin; color-scheme handles appearance). */
  theme: string
  /** Call a method; resolves with its result, rejects with an Error on RPC error. */
  request(method: string, params?: unknown): Promise<any>
  /** Subscribe to host→UI pushes. exlibris never pushes (pure request-response). */
  onMessage(cb: (payload: unknown) => void): void
}

declare global {
  interface Window {
    notemd: NotemdBridge
  }
}

/** The injected bridge. Throws if accessed outside a host plugin window. */
export function bridge(): NotemdBridge {
  const b = window.notemd
  if (!b) throw new Error('window.notemd bridge missing (not running inside a plugin window)')
  return b
}

/**
 * Call a backend command. Prefixes `plugin.` so the host routes to THIS plugin's
 * process (`ui.request`); the process strips the prefix and dispatches the clean
 * name via `on_ui_request` (ping / calibre_detect / fs_atomic_copy / …). Drop-in
 * replacement for the v1 `invoke(cmd, args)`.
 */
export function request<T = any>(method: string, params?: unknown): Promise<T> {
  return bridge().request('plugin.' + method, params)
}

/**
 * Call a HOST method directly (no `plugin.` prefix). Used for the native dialog
 * pickers (`host.dialog.open`), which the host serves locally under the
 * `dialog` capability.
 */
export function hostRequest<T = any>(method: string, params?: unknown): Promise<T> {
  return bridge().request(method, params)
}

/**
 * Open a native file/directory picker via the host and return the selected
 * absolute paths (empty array when the user cancelled). Wraps
 * `host.dialog.open`, whose result is `{ paths: string[] | null }`.
 */
export async function pickPaths(opts: {
  title?: string
  filters?: { name: string; extensions: string[] }[]
  directory?: boolean
  multiple?: boolean
}): Promise<string[]> {
  const res = await hostRequest<{ paths: string[] | null }>('host.dialog.open', opts)
  return res?.paths ?? []
}
