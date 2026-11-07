// Isolated in-memory host adapter. No user Vault, settings, filesystem or network RPC.
export const hostCalls: { command: string; denied: boolean }[] = []
let callback = 0
const callbacks = new Map<number, Function>()
;(window as any).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'sumi-benchmark' }, currentWebview: { label: 'sumi-benchmark' } },
  transformCallback(fn: Function) { callbacks.set(++callback, fn); return callback },
  unregisterCallback(id: number) { callbacks.delete(id) },
  convertFileSrc() { throw new Error('benchmark has no file resource access') },
  async invoke(command: string) {
    const allowed = command === 'plugin:event|listen' || command === 'plugin:event|unlisten'
      || command === 'plugin:event|emit' || command === 'plugin:window|set_title'
    hostCalls.push({ command, denied: !allowed })
    if (allowed) return 1
    if (command === 'plugin:os|platform') return 'macos'
    throw new Error(`Isolated benchmark denies host RPC: ${command}`)
  },
}
;(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
