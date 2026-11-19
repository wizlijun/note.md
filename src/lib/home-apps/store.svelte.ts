import { Store } from '@tauri-apps/plugin-store'
import {
  emptyHomeAppsData, normalizeHomeAppsData, recordUsage, pinApp, unpinApp,
  movePin, reconcileInstalled, refreshRanking, type HomeAppsData,
} from './model'

export const homeAppsStore = $state<{
  data: HomeAppsData
  ready: boolean
  busy: boolean
  error: string | null
}>({ data: emptyHomeAppsData(), ready: false, busy: false, error: null })

let storage: Awaited<ReturnType<typeof Store.load>> | null = null
let hydration: Promise<void> | null = null
let writeQueue: Promise<void> = Promise.resolve()
let pending = 0

function begin(): void { pending++; homeAppsStore.busy = true }
function end(): void { pending--; homeAppsStore.busy = pending > 0 }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** A failed read remains retryable and can never initialize a write as empty. */
export function loadHomeApps(): Promise<void> {
  if (homeAppsStore.ready) return Promise.resolve()
  if (hydration) return hydration
  begin()
  hydration = Promise.resolve().then(async () => {
    const loaded = await Store.load('home-apps.json', { autoSave: false, defaults: {} })
    const value = await loaded.get<unknown>('data')
    storage = loaded
    homeAppsStore.data = normalizeHomeAppsData(value)
    homeAppsStore.ready = true
    homeAppsStore.error = null
  }).catch((error: unknown) => {
    homeAppsStore.error = errorText(error)
    throw error
  }).finally(() => {
    hydration = null
    end()
  })
  return hydration
}

function change(update: (data: HomeAppsData) => HomeAppsData): Promise<void> {
  const loaded = loadHomeApps()
  // A queued operation may reach this promise later; its own result still rejects.
  void loaded.catch(() => {})
  begin()
  const operation = writeQueue.then(async () => {
    await loaded
    const next = update(homeAppsStore.data)
    if (JSON.stringify(next) !== JSON.stringify(homeAppsStore.data)) {
      await storage!.set('data', next)
      await storage!.save()
      homeAppsStore.data = next
    }
    homeAppsStore.error = null
  }).catch((error: unknown) => {
    homeAppsStore.error = errorText(error)
    throw error
  }).finally(end)
  // Failure does not poison later writes; callers retain the rejecting promise.
  writeQueue = operation.catch(() => {})
  return operation
}

export function recordHomeAppUse(id: string, now = Date.now()): Promise<void> {
  return change((data) => recordUsage(data, id, now))
}

export function pinHomeApp(id: string, slot: number): Promise<void> {
  return change((data) => pinApp(data, id, slot))
}

export function unpinHomeApp(id: string): Promise<void> {
  return change((data) => unpinApp(data, id))
}

export function moveHomeApp(id: string, slot: number, sourceSlot?: number): Promise<void> {
  return change((data) => movePin(data, id, slot, sourceSlot))
}

export function reconcileHomeApps(installedIds: readonly string[]): Promise<void> {
  return change((data) => reconcileInstalled(data, installedIds))
}

export function refreshHomeAppRanking(eligibleIds: readonly string[], now = Date.now()): Promise<void> {
  return change((data) => refreshRanking(data, eligibleIds, now))
}
