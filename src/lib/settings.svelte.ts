import { Store } from '@tauri-apps/plugin-store'

type Mode = 'source' | 'rich'

export interface MdblockSettings {
  enabled: boolean
  autoRefreshOnSave: boolean
  injectAiHint: boolean
  similarityThreshold: number
  splitCoverageThreshold: number
  chunkSizeChars: number
  hover: {
    enabled: boolean
    showSourceGutter: boolean
    showRichOverlay: boolean
    badgeFormat: 'short' | 'full'
  }
}

export const DEFAULT_MDBLOCK_SETTINGS: MdblockSettings = {
  enabled: false,
  autoRefreshOnSave: false,
  injectAiHint: true,
  similarityThreshold: 0.5,
  splitCoverageThreshold: 0.3,
  chunkSizeChars: 2400,
  hover: {
    enabled: false,
    showSourceGutter: true,
    showRichOverlay: true,
    badgeFormat: 'short',
  },
}

export const settings = $state<{
  autoSave: boolean
  skin: string
  mdblock: MdblockSettings
}>({
  autoSave: false,
  skin: 'default',
  mdblock: structuredClone(DEFAULT_MDBLOCK_SETTINGS),
})

const KNOWN_SKIN_IDS = new Set(['default', 'shuyuan', 'effie'])

let store: Awaited<ReturnType<typeof Store.load>> | null = null
let recentFiles: string[] = []
let recentModesByExt: Record<string, Mode> = {}
let pluginScoped: Record<string, Record<string, unknown>> = {}
let pluginsEnabled: Record<string, boolean> = {}

async function getStore() {
  if (!store) store = await Store.load('settings.json')
  return store
}

export async function loadSettings(): Promise<void> {
  const s = await getStore()
  settings.autoSave = (await s.get<boolean>('autoSave')) ?? false
  const storedSkin = await s.get<string>('skin')
  settings.skin = storedSkin && KNOWN_SKIN_IDS.has(storedSkin) ? storedSkin : 'default'
  recentFiles = (await s.get<string[]>('recentFiles')) ?? []
  recentModesByExt = (await s.get<Record<string, Mode>>('recentModesByExt')) ?? {}
  pluginScoped = (await s.get<Record<string, Record<string, unknown>>>('plugins')) ?? {}
  pluginsEnabled = (await s.get<Record<string, boolean>>('plugins.enabled')) ?? {}
  const storedMdblock = await s.get<MdblockSettings>('mdblock')
  settings.mdblock = storedMdblock
    ? {
        ...DEFAULT_MDBLOCK_SETTINGS,
        ...storedMdblock,
        hover: { ...DEFAULT_MDBLOCK_SETTINGS.hover, ...(storedMdblock.hover ?? {}) },
      }
    : structuredClone(DEFAULT_MDBLOCK_SETTINGS)
  pluginScopedVersion.value++
}

export async function saveSettings(): Promise<void> {
  const s = await getStore()
  await s.set('autoSave', settings.autoSave)
  await s.set('skin', settings.skin)
  await s.set('recentFiles', recentFiles)
  await s.set('recentModesByExt', recentModesByExt)
  await s.set('plugins', pluginScoped)
  await s.set('plugins.enabled', pluginsEnabled)
  await s.set('mdblock', settings.mdblock)
  await s.save()
}

export function getRecentFiles(): readonly string[] {
  return recentFiles
}

export async function pushRecentFile(path: string): Promise<void> {
  recentFiles = [path, ...recentFiles.filter((p) => p !== path)].slice(0, 10)
  await saveSettings()
}

/** `key` is the extension (or special basename) returned by `modeKeyFor`. */
export function getRecentMode(key: string): Mode | null {
  return recentModesByExt[key] ?? null
}

/** `key` is the extension (or special basename) returned by `modeKeyFor`. */
export async function setRecentMode(key: string, mode: Mode): Promise<void> {
  recentModesByExt[key] = mode
  await saveSettings()
}

// --- Plugin-scoped settings ---

/**
 * Reactive version counter — increments on every `loadSettings` and every
 * `mergePluginScoped`. Subscribers (like App.svelte's enabled_when re-eval
 * effect) should depend on `.value` to re-run when plugin settings change.
 */
export const pluginScopedVersion = $state<{ value: number }>({ value: 0 })

/**
 * Get all keys for a single plugin id, returned with their fully-qualified
 * names (e.g. `share.baseUrl`). Returns `{}` if the plugin has no settings yet.
 */
export function getPluginScopedAll(pluginId: string): Record<string, unknown> {
  const sub = pluginScoped[pluginId] ?? {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(sub)) {
    out[`${pluginId}.${k}`] = v
  }
  return out
}

/** Read a single fully-qualified plugin-scoped key (e.g. 'share.baseUrl'). */
export function getPluginScopedKey(fqKey: string): unknown {
  const dot = fqKey.indexOf('.')
  if (dot <= 0) return undefined
  const id = fqKey.slice(0, dot)
  const key = fqKey.slice(dot + 1)
  return pluginScoped[id]?.[key]
}

/**
 * Merge a flat patch where keys are fully-qualified `<plugin-id>.<key>`.
 * Each entry is stored under `pluginScoped[<plugin-id>][<key>]`.
 */
export async function mergePluginScoped(patch: Record<string, unknown>): Promise<void> {
  for (const [fqKey, value] of Object.entries(patch)) {
    const dot = fqKey.indexOf('.')
    if (dot <= 0) continue
    const id = fqKey.slice(0, dot)
    const key = fqKey.slice(dot + 1)
    if (!pluginScoped[id]) pluginScoped[id] = {}
    pluginScoped[id][key] = value
  }
  pluginScopedVersion.value++
  await saveSettings()
}

// --- Plugin enable/disable ---

/**
 * Whether the given plugin id is enabled. Default-on: a plugin not present
 * in the settings map is treated as enabled (so newly bundled plugins are
 * usable on first launch without migration).
 */
export function isPluginEnabled(pluginId: string): boolean {
  const v = pluginsEnabled[pluginId]
  if (v === undefined) return true
  return v === true
}

/**
 * Persist whether a plugin should be loaded at app startup. Honored by the
 * Rust plugin host; takes effect on the next launch (active manifests are
 * cached at boot).
 */
export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  pluginsEnabled[pluginId] = enabled
  await saveSettings()
}
