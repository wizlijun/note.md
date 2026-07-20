// src/lib/bridge.ts — typed accessor for the host-injected `window.notemd`
// bridge (see src-tauri/src/plugin_runtime/windows.rs bridge_script).
//
// A plugin window has ZERO Tauri IPC. Two channels:
//  1. UI → plugin process: `request(method, params)`. When `method` is NOT a
//     `host.*` name, the host forwards it to THIS plugin's backend process as
//     `ui.request{method,params}` (子项目②b). We prefix every backend call
//     with `plugin.` so the host routes it to the process (which strips the
//     prefix and sees the clean name — connect/send/…).
//  2. Plugin process → UI: `onMessage(cb)` receives every `host.ui.post`
//     payload the backend pushes. openclaw pushes `{kind, data}` objects.

/** The bridge surface the host injects as an initialization script. */
export interface NotemdBridge {
  pluginId: string
  /** BCP-ish locale code the host resolved from settings: 'en' | 'zh' | 'ja' | 'de'. */
  locale: string
  /** Active UI theme id (unused by this plugin; color-scheme handles appearance). */
  theme: string
  /** Call a method; resolves with its result, rejects with an Error on RPC error. */
  request(method: string, params?: unknown): Promise<any>
  /** Subscribe to host→UI pushes (the backend's `host.ui.post` payloads). */
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
 * Call a backend method. Prefixes `plugin.` so the host routes to THIS plugin's
 * process (`ui.request`); the process strips the prefix and dispatches the clean
 * name via `on_ui_request` (connect/send/disconnect/pair_create/pair_claim/…).
 */
export function request(method: string, params?: unknown): Promise<any> {
  return bridge().request('plugin.' + method, params)
}

/** The `{kind, data}` envelope the openclaw backend pushes via `host.ui.post`. */
export interface HostMessage {
  kind: string
  data: unknown
}

/**
 * Subscribe to every backend push. `cb` receives the raw `{kind, data}`
 * envelope; callers fan out by `kind` (see commands.ts `routeByKind`).
 */
export function onMessage(cb: (m: HostMessage) => void): void {
  bridge().onMessage((payload) => cb(payload as HostMessage))
}
