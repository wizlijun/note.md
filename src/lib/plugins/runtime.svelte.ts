import { invoke } from '@tauri-apps/api/core'
import type { PluginManifest } from './types'

export type PluginCommandSource = 'menu' | 'tab-context' | 'editor-context'
type PluginDispatcher = (pluginId: string, command: string, source?: PluginCommandSource) => Promise<void>

/**
 * Runtime state shared between App.svelte (which owns the plugin lifecycle)
 * and other components (TabBar.svelte's right-click context menu, etc.).
 *
 * App and HomeApps refresh the same verified `manifests` registry, and App
 * registers the dispatch function via `setPluginDispatcher`. Other components
 * read `manifests` reactively and call `dispatchPluginCommand` to invoke a
 * plugin command — same path the menu-event listener uses.
 */
export const pluginRuntime = $state<{
  manifests: PluginManifest[]
  ready: boolean
}>({
  manifests: [],
  ready: false,
})

let refreshGeneration = 0
let latestRefresh: Promise<PluginManifest[]>

/** Publish one live registry for dispatch and UI; late older reads follow the newest read. */
export function refreshPluginManifests(): Promise<PluginManifest[]> {
  const request = ++refreshGeneration
  latestRefresh = invoke<PluginManifest[]>('get_plugin_manifests').then((manifests) => {
    if (request !== refreshGeneration) return latestRefresh
    pluginRuntime.manifests = manifests
    return manifests
  }, (error: unknown) => {
    if (request !== refreshGeneration) return latestRefresh
    throw error
  })
  return latestRefresh
}

let dispatcher: PluginDispatcher = async () => {
  console.warn('[plugins] dispatcher not yet registered; ignoring call')
}

export function setPluginDispatcher(
  fn: PluginDispatcher,
): void {
  dispatcher = fn
  pluginRuntime.ready = true
}

export function dispatchPluginCommand(pluginId: string, command: string, source: PluginCommandSource = 'menu'): Promise<void> {
  return dispatcher(pluginId, command, source)
}
