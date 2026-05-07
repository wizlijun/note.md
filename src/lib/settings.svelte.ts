import { Store } from '@tauri-apps/plugin-store'

type Mode = 'source' | 'rich'

export const settings = $state<{ autoSave: boolean }>({ autoSave: false })

let store: Awaited<ReturnType<typeof Store.load>> | null = null
let recentFiles: string[] = []
let recentModes: Record<string, Mode> = {}

async function getStore() {
  if (!store) store = await Store.load('settings.json')
  return store
}

export async function loadSettings(): Promise<void> {
  const s = await getStore()
  settings.autoSave = ((await s.get<boolean>('autoSave')) ?? false) as boolean
  recentFiles = ((await s.get<string[]>('recentFiles')) ?? []) as string[]
  recentModes = ((await s.get<Record<string, Mode>>('recentModes')) ?? {}) as Record<string, Mode>
}

export async function saveSettings(): Promise<void> {
  const s = await getStore()
  await s.set('autoSave', settings.autoSave)
  await s.set('recentFiles', recentFiles)
  await s.set('recentModes', recentModes)
  await s.save()
}

export function getRecentFiles(): readonly string[] {
  return recentFiles
}

export async function pushRecentFile(path: string): Promise<void> {
  recentFiles = [path, ...recentFiles.filter((p) => p !== path)].slice(0, 10)
  await saveSettings()
}

export function getRecentMode(path: string): Mode | null {
  return recentModes[path] ?? null
}

export async function setRecentMode(path: string, mode: Mode): Promise<void> {
  recentModes[path] = mode
  await saveSettings()
}
