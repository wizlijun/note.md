import { Store } from '@tauri-apps/plugin-store'

type Mode = 'source' | 'rich'

export const settings = $state<{ autoSave: boolean }>({ autoSave: false })

let store: Awaited<ReturnType<typeof Store.load>> | null = null
let recentFiles: string[] = []
let recentModesByExt: Record<string, Mode> = {}

async function getStore() {
  if (!store) store = await Store.load('settings.json')
  return store
}

export async function loadSettings(): Promise<void> {
  const s = await getStore()
  settings.autoSave = (await s.get<boolean>('autoSave')) ?? false
  recentFiles = (await s.get<string[]>('recentFiles')) ?? []
  recentModesByExt = (await s.get<Record<string, Mode>>('recentModesByExt')) ?? {}
}

export async function saveSettings(): Promise<void> {
  const s = await getStore()
  await s.set('autoSave', settings.autoSave)
  await s.set('recentFiles', recentFiles)
  await s.set('recentModesByExt', recentModesByExt)
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
