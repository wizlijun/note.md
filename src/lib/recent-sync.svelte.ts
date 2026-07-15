import { readTextFile, writeTextFile, mkdir, readDir, exists } from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { homeDir } from '@tauri-apps/api/path'
import { hostname } from '@tauri-apps/plugin-os'
import {
  getRecentFiles,
  getRecentOpenedAt,
  getRecentTombstones,
  getDeviceId,
  setRecentsChangedHandler,
} from './settings.svelte'
import { sotvaultStore } from './sotvault.svelte'
import {
  toSyncedEntry,
  resolveLocalRecents,
  mergeRecents,
  formatRecentLabel,
  type DeviceRecents,
  type ResolvedRecent,
} from './recent-merge'

const RECENTS_SUBDIR = '.notemd/recents'
const PER_DEVICE_CAP = 20

/** Merged recents (this device + every synced device). Read by the menu and DrawerNav. */
export const mergedRecents = $state<{ paths: string[] }>({ paths: [] })

function recentsDir(vaultRoot: string): string {
  return `${vaultRoot.replace(/\/$/, '')}/${RECENTS_SUBDIR}`
}

function localResolved(): ResolvedRecent[] {
  return resolveLocalRecents(getRecentFiles(), getRecentOpenedAt(), Date.now())
}

async function readOtherDeviceFiles(vaultRoot: string | null): Promise<DeviceRecents[]> {
  if (!vaultRoot) return []
  const dir = recentsDir(vaultRoot)
  if (!(await exists(dir).catch(() => false))) return []
  const ownFile = `${getDeviceId()}.json`
  const out: DeviceRecents[] = []
  const entries = await readDir(dir).catch(() => [] as Awaited<ReturnType<typeof readDir>>)
  for (const ent of entries) {
    if (!ent.isFile || !ent.name.endsWith('.json') || ent.name === ownFile) continue
    try {
      const parsed = JSON.parse(await readTextFile(`${dir}/${ent.name}`)) as DeviceRecents
      if (parsed && Array.isArray(parsed.entries)) out.push(parsed)
    } catch {
      // Skip corrupt / partially-written files.
    }
  }
  return out
}

/** Rewrite this device's synced file (no-op when no Vault is configured). */
export async function writeOwnDeviceFile(): Promise<void> {
  const vaultRoot = sotvaultStore.vaultRoot
  if (!vaultRoot) return
  const dir = recentsDir(vaultRoot)
  await mkdir(dir, { recursive: true }).catch(() => {})
  const deviceId = getDeviceId()
  const deviceName = (await hostname().catch(() => null)) ?? `Device-${deviceId.slice(0, 8)}`
  const openedAt = getRecentOpenedAt()
  const entries = getRecentFiles()
    .slice(0, PER_DEVICE_CAP)
    .map((p) => toSyncedEntry(p, openedAt[p] ?? Date.now(), vaultRoot))
  const doc: DeviceRecents = { deviceId, deviceName, entries }
  await writeTextFile(`${dir}/${deviceId}.json`, JSON.stringify(doc, null, 2))
}

/** Recompute the merged list and push it to the native menu. */
export async function refreshRecentMenu(): Promise<void> {
  const vaultRoot = sotvaultStore.vaultRoot
  const devices = await readOtherDeviceFiles(vaultRoot)
  mergedRecents.paths = mergeRecents(localResolved(), devices, vaultRoot, [...getRecentTombstones()])
  const home = await homeDir().catch(() => null)
  const items = mergedRecents.paths.map((p, index) => ({ index, label: formatRecentLabel(p, home) }))
  try {
    await invoke('update_recent_menu', { items })
  } catch {
    // No native menu on this platform (iOS); the DrawerNav still reads mergedRecents.
  }
}

/**
 * Wire everything up. Call once on app mount.
 *
 * Note: this intentionally does NOT push the menu itself — it can run before
 * `loadSettings()` has populated `recentFiles`, and publishing an empty list
 * here would leave the File ▸ Open Recent menu stuck on its "No Recent Files"
 * placeholder. The caller must invoke `refreshRecentMenu()` once settings (and
 * the vault root) are loaded.
 *
 * Returns a cleanup function.
 */
export async function installRecentsSync(): Promise<() => void> {
  setRecentsChangedHandler(() => {
    void (async () => {
      await writeOwnDeviceFile()
      await refreshRecentMenu()
    })()
  })
  const unlisten = await listen('editor://recents-synced', () => {
    void refreshRecentMenu()
  })
  return () => {
    setRecentsChangedHandler(null)
    unlisten()
  }
}
