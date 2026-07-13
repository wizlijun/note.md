import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { pushToast } from './toast.svelte'
import { t } from './i18n/store.svelte'
import { activeTab, reloadTabFromDisk } from './tabs.svelte'
import { isPluginActive } from './plugins/registry'
import {
  canSyncToVault as computeCanSync,
  isTracked as computeIsTracked,
  sourceForVault as computeSourceForVault,
  dialogActionFor,
  localYmd,
  type SotRecord,
} from './sotvault-logic'

export const sotvaultStore = $state<{ vaultRoot: string | null; records: SotRecord[]; tick: number }>({
  vaultRoot: null,
  records: [],
  tick: 0,
})

/** Notified after every refresh that (re)assigns the vault root — lets features
 *  like reading-insights install themselves once a vault becomes available,
 *  independent of app-boot ordering. Mirrors `setRecentsChangedHandler`. */
let vaultRootChangedHandler: (() => void) | null = null
export function setVaultRootChangedHandler(fn: (() => void) | null): void {
  vaultRootChangedHandler = fn
}

let noteConflictListening = false
/** Show a toast whenever a sidecar-note merge produced conflict markers.
 *  Idempotent: safe to call once at app boot. */
export async function initSotvaultNoteConflictToast(): Promise<void> {
  if (noteConflictListening) return
  noteConflictListening = true
  await listen('sotvault://note-conflict', () => {
    pushToast({ level: 'warn', message: t('sotvault.noteConflict') })
  })
}

export async function refreshSotvault(): Promise<void> {
  try {
    // The vault root is a GLOBAL setting (VaultSyncManager.repo_path), independent
    // of whether the sotvault *plugin* is enabled. Other features — notably
    // reading-insights — rely on it, so always load it; otherwise they wrongly
    // report "no vault configured" whenever sotvault happens to be off.
    const root = await invoke<string | null>('sotvault_vault_root')
    // Records are sotvault-specific — only meaningful when its plugin is active.
    const records = isPluginActive('sotvault')
      ? await invoke<SotRecord[]>('sotvault_records')
      : []
    sotvaultStore.vaultRoot = root
    sotvaultStore.records = records
    sotvaultStore.tick++
    vaultRootChangedHandler?.()
  } catch (e) {
    console.warn('[sotvault] refresh:', e)
  }
}

export function canSyncActive(path: string | null): boolean {
  return computeCanSync(path, sotvaultStore.vaultRoot, sotvaultStore.records)
}

export function isTrackedVaultFile(path: string | null): boolean {
  return computeIsTracked(path, sotvaultStore.records)
}

/** Source path a tracked vault copy was synced from, or null. */
export function sourceForVaultPath(path: string | null): string | null {
  return computeSourceForVault(path, sotvaultStore.records)
}

/** Reveal the source file in the OS file browser (opens its folder, highlights it). */
export async function revealVaultSource(sourcePath: string): Promise<void> {
  try {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
    await revealItemInDir(sourcePath)
  } catch (e) {
    pushToast({ level: 'error', message: t('sotvault.revealFailed'), detail: String(e) })
  }
}

export async function syncCurrentToVault(): Promise<void> {
  const tab = activeTab()
  if (!tab?.filePath) {
    pushToast({ level: 'warn', message: t('sotvault.saveFirst') })
    return
  }
  try {
    const datePrefix = await sourceCreationYmd(tab.filePath)
    await invoke('sotvault_sync_to_vault', { srcPath: tab.filePath, datePrefix })
    await refreshSotvault()
    pushToast({ level: 'success', message: t('sotvault.synced') })
  } catch (e) {
    pushToast({ level: 'error', message: t('sotvault.syncFailed'), detail: String(e) })
  }
}

/** Local yyyy-MM-dd of the source file's creation time (birthtime), falling back
 *  to its mtime, then today, if the OS doesn't report a birthtime. */
async function sourceCreationYmd(path: string): Promise<string> {
  try {
    const { stat } = await import('@tauri-apps/plugin-fs')
    const info = await stat(path)
    return localYmd(info.birthtime ?? info.mtime ?? new Date())
  } catch {
    return localYmd()
  }
}

interface UpdateCheck {
  outcome: string
  vaultPath: string | null
  openedIsSource: boolean
}

export async function maybeCheckVaultUpdate(tab: { filePath: string }): Promise<void> {
  if (!isPluginActive('sotvault')) return
  if (!tab.filePath) return

  let res: UpdateCheck
  try {
    res = await invoke<UpdateCheck>('sotvault_check_update', { openedPath: tab.filePath })
  } catch (e) {
    console.warn('[sotvault] check_update:', e)
    return
  }

  const action = dialogActionFor(res.outcome)
  if (action === 'none') return
  if (action === 'source-missing') {
    pushToast({ level: 'warn', message: t('sotvault.sourceMovedOrDeleted') })
    return
  }
  const vaultPath = res.vaultPath
  if (!vaultPath) return

  const { ask } = await import('@tauri-apps/plugin-dialog')

  if (action === 'confirm-origin') {
    // Same underlying action (source → vault), but worded for whichever side
    // the user opened.
    const msg = res.openedIsSource
      ? t('sotvault.askLocalChanged')
      : t('sotvault.askSourceUpdated')
    const yes = await ask(msg, { title: t('sotvault.syncTitle') })
    if (yes) await applyVaultUpdate(vaultPath)
    return
  }

  // action === 'conflict'
  const overwrite = await ask(t('sotvault.conflictOverwrite'), { title: t('sotvault.conflictTitle') })
  if (overwrite) {
    await applyVaultUpdate(vaultPath)
    return
  }
  const keep = await ask(t('sotvault.conflictKeep'), { title: t('sotvault.conflictTitle') })
  if (keep) {
    try {
      await invoke('sotvault_accept_current', { vaultPath })
      await refreshSotvault()
    } catch (e) {
      console.warn('[sotvault] accept_current:', e)
    }
  }
  // else: cancel — leave the record untouched; it will prompt again next open.
}

async function applyVaultUpdate(vaultPath: string): Promise<void> {
  try {
    await invoke<string>('sotvault_apply_update', { vaultPath })
    await reloadTabFromDisk(vaultPath)
    await refreshSotvault()
    pushToast({ level: 'success', message: t('sotvault.updatedFromSource') })
  } catch (e) {
    pushToast({ level: 'error', message: t('sotvault.updateFailed'), detail: String(e) })
  }
}
