/**
 * Custom-editor document channel (子项目④).
 *
 * These are the `postMessage` payloads exchanged DIRECTLY between the main app
 * (which owns the `<iframe>` element and all file I/O) and the plugin's editor
 * iframe. They are NOT JSON-RPC and do NOT travel through Rust / the `plugin://`
 * protocol — that path (`window.notemd.request`) is for `host.*` capability
 * calls only. The document channel is parent ↔ iframe `postMessage`:
 *
 *   parent → iframe : `custom_editor.open`  (host read the file, hands content in)
 *   iframe → parent : `change`              (user edited; host flips dirty via setContent)
 *
 * The parent posts with a strict `plugin://<id>` targetOrigin and validates the
 * iframe's replies by `event.origin` + `event.source` before acting.
 */

/** Parent → iframe: the host opened a file for this editor. Sent once on load. */
export interface CustomEditorOpen {
  type: 'custom_editor.open'
  /** Absolute file path the host is editing (informational for the iframe). */
  uri: string
  /** The file's current text content (host read it from disk). */
  content: string
  /** Which contributed editor this is (the plugin may serve several). */
  editorId: string
}

/** iframe → parent: the user edited the document. Host calls `setContent`. */
export interface CustomEditorChange {
  type: 'change'
  /** The full new document text. */
  content: string
}

/** Every message the parent may receive from a custom-editor iframe. */
export type CustomEditorInbound = CustomEditorChange

/** Minimal shape of a `message` event the router validates (subset of the DOM
 *  `MessageEvent` so the pure router is testable without jsdom). */
export interface IncomingMessage {
  origin: string
  source: unknown
  data: unknown
}

/**
 * Validate + route ONE inbound `message` from a custom-editor iframe.
 *
 * STRICT authentication (both must hold, else the message is ignored):
 *   1. `event.origin === pluginOrigin` — the sender loaded under this plugin.
 *   2. `event.source === expectedSource` — it is THIS iframe's window, not some
 *      other frame/window forging a `change` to rewrite the document.
 *
 * On a valid `{ type: 'change', content }` it calls `onChange(content)` and
 * returns `true`; every rejected/unknown message returns `false` (no effect).
 * Extracted from the Svelte component so the routing is unit-testable in the
 * node test environment (no DOM / no component mount required).
 */
export function handleCustomEditorMessage(
  event: IncomingMessage,
  opts: { pluginOrigin: string; expectedSource: unknown; onChange: (content: string) => void },
): boolean {
  if (event.origin !== opts.pluginOrigin) return false
  if (event.source !== opts.expectedSource) return false
  const data = event.data as CustomEditorInbound | undefined
  if (!data || typeof data !== 'object') return false
  if (data.type === 'change' && typeof data.content === 'string') {
    opts.onChange(data.content)
    return true
  }
  return false
}
