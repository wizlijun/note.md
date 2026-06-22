import { invoke } from '@tauri-apps/api/core'
import { pushToast } from './toast.svelte'
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

export async function refreshSotvault(): Promise<void> {
  if (!isPluginActive('sotvault')) return
  try {
    const [root, records] = await Promise.all([
      invoke<string | null>('sotvault_vault_root'),
      invoke<SotRecord[]>('sotvault_records'),
    ])
    sotvaultStore.vaultRoot = root
    sotvaultStore.records = records
    sotvaultStore.tick++
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
    pushToast({ level: 'error', message: '❌ 打开来源目录失败', detail: String(e) })
  }
}

export async function syncCurrentToVault(): Promise<void> {
  const tab = activeTab()
  if (!tab?.filePath) {
    pushToast({ level: 'warn', message: '请先保存文件，再同步到 Vault' })
    return
  }
  try {
    const datePrefix = await sourceCreationYmd(tab.filePath)
    await invoke('sotvault_sync_to_vault', { srcPath: tab.filePath, datePrefix })
    await refreshSotvault()
    pushToast({ level: 'success', message: '✓ 已同步到 Vault' })
  } catch (e) {
    pushToast({ level: 'error', message: '❌ 同步到 Vault 失败', detail: String(e) })
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
    pushToast({ level: 'warn', message: '⚠️ Vault: 源文件已移动或删除，无法检查更新' })
    return
  }
  const vaultPath = res.vaultPath
  if (!vaultPath) return

  const { ask } = await import('@tauri-apps/plugin-dialog')

  if (action === 'confirm-origin') {
    // Same underlying action (source → vault), but worded for whichever side
    // the user opened.
    const msg = res.openedIsSource
      ? '此文件已同步到 Vault，且自上次同步后有改动。现在同步到 Vault 吗？'
      : '源文件已更新，是否同步进 Vault？'
    const yes = await ask(msg, { title: 'Sync to Vault' })
    if (yes) await applyVaultUpdate(vaultPath)
    return
  }

  // action === 'conflict'
  const overwrite = await ask('源文件与 Vault 副本都被修改过（冲突）。用源文件覆盖 Vault 副本？', { title: 'Vault 冲突' })
  if (overwrite) {
    await applyVaultUpdate(vaultPath)
    return
  }
  const keep = await ask('保留 Vault 当前内容，并停止对此文件的更新提示？', { title: 'Vault 冲突' })
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
    pushToast({ level: 'success', message: '✓ 已从源文件更新 Vault 副本' })
  } catch (e) {
    pushToast({ level: 'error', message: '❌ 更新 Vault 副本失败', detail: String(e) })
  }
}
