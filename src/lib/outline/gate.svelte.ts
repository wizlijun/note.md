import { Store } from '@tauri-apps/plugin-store'
import { isPluginEnabled } from '../settings.svelte'

export const PLUGIN_ID = 'outline-notes'
export const DEFAULT_WIDTH = 360
export const MIN_WIDTH = 240
export const MAX_WIDTH = 640

export const outlineGate = $state<{ enabled: boolean; visible: boolean; width: number }>({
  enabled: false,
  visible: false,
  width: DEFAULT_WIDTH,
})

let store: Awaited<ReturnType<typeof Store.load>> | null = null
async function getStore() {
  if (!store) store = await Store.load('settings.json')
  return store
}

/** Call after settings hydration (same timing as loadFolderViewState). */
export async function loadOutlineGate(): Promise<void> {
  outlineGate.enabled = isPluginEnabled(PLUGIN_ID)
  const s = await getStore()
  outlineGate.visible = (await s.get<boolean>('outline.visible')) ?? false
  outlineGate.width = (await s.get<number>('outline.width')) ?? DEFAULT_WIDTH
}

export async function setOutlineVisible(v: boolean): Promise<void> {
  outlineGate.visible = v
  const s = await getStore()
  await s.set('outline.visible', v)
  await s.save()
}

export async function setOutlineWidth(w: number): Promise<void> {
  const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)))
  outlineGate.width = clamped
  const s = await getStore()
  await s.set('outline.width', clamped)
  await s.save()
}
