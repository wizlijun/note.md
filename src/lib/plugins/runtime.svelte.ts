import type { PluginManifest } from './types'

/**
 * Runtime state shared between App.svelte (which owns the plugin lifecycle)
 * and other components (TabBar.svelte's right-click context menu, etc.).
 *
 * App.svelte populates `manifests` after `get_plugin_manifests` returns, and
 * registers the dispatch function via `setPluginDispatcher`. Other components
 * read `manifests` reactively and call `dispatchPluginCommand` to invoke a
 * plugin command — same path the menu-event listener uses.
 */
export const pluginRuntime = $state<{
  manifests: PluginManifest[]
}>({
  manifests: [],
})

let dispatcher: (pluginId: string, command: string) => Promise<void> = async () => {
  console.warn('[plugins] dispatcher not yet registered; ignoring call')
}

export function setPluginDispatcher(
  fn: (pluginId: string, command: string) => Promise<void>,
): void {
  dispatcher = fn
}

export function dispatchPluginCommand(pluginId: string, command: string): Promise<void> {
  return dispatcher(pluginId, command)
}
