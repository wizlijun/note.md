import { Store } from '@tauri-apps/plugin-store'
import { isPluginEnabled } from '../settings.svelte'

export { historyAppliesTo, relTime } from './applies'

export const PLUGIN_ID = 'git-history'
export const DEFAULT_WIDTH = 360
export const MIN_WIDTH = 240
export const MAX_WIDTH = 640

export const historyGate = $state<{ enabled: boolean; visible: boolean; width: number }>({
  enabled: false,
  visible: false,
  width: DEFAULT_WIDTH,
})

let store: Awaited<ReturnType<typeof Store.load>> | null = null
async function getStore() {
  if (!store) store = await Store.load('settings.json')
  return store
}

/** Call after settings hydration (same timing as loadOutlineGate). */
export async function loadHistoryGate(): Promise<void> {
  historyGate.enabled = isPluginEnabled(PLUGIN_ID)
  const s = await getStore()
  historyGate.visible = (await s.get<boolean>('history.visible')) ?? false
  historyGate.width = (await s.get<number>('history.width')) ?? DEFAULT_WIDTH
}

/** @deprecated visibility/width now live in the side-panel registry (sidePanels.right).
 *  These remain only for settings hydration + test compatibility; the UI no longer reads them. */
export async function setHistoryVisible(v: boolean): Promise<void> {
  historyGate.visible = v
  const s = await getStore()
  await s.set('history.visible', v)
  await s.save()
}

/** Update width in state only (clamped, no persist). Call during drag. */
export function setHistoryWidthLive(w: number): void {
  historyGate.width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w))
}

export async function setHistoryWidth(w: number): Promise<void> {
  const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)))
  historyGate.width = clamped
  const s = await getStore()
  await s.set('history.width', clamped)
  await s.save()
}
