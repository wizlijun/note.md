import { activeTab, saveActive, saveAs, openFile, closeTab, toggleMode } from './tabs.svelte'
import { confirmDirtyClose, pickOpenFile, pickSaveFile, showError } from './dialogs'
import { sharePublishCurrent, shareUnpublishCurrent, shareCopyLinkCurrent } from './share'
import { printActiveTab } from './print'

export async function cmdOpen(): Promise<void> {
  const p = await pickOpenFile()
  if (!p) return
  try { await openFile(p) } catch (e) { await showError(String(e)) }
}

export async function cmdSave(): Promise<void> {
  const t = activeTab()
  if (!t) return
  if (t.kind === 'image') return  // images are read-only
  try { await saveActive() } catch (e) { await showError(`Save failed: ${e}`) }
}

export async function cmdSaveAs(): Promise<void> {
  const t = activeTab()
  if (!t) return
  if (t.kind === 'image') return  // images are read-only
  const p = await pickSaveFile(t.filePath)
  if (!p) return
  try { await saveAs(t.id, p) } catch (e) { await showError(`Save As failed: ${e}`) }
}

export async function cmdPrint(): Promise<void> {
  await printActiveTab()
}

export async function cmdCloseActive(): Promise<void> {
  const t = activeTab()
  if (!t) return
  await closeTab(t.id, confirmDirtyClose)
}

export function cmdToggleMode(): void {
  const t = activeTab()
  if (t && t.kind !== 'image') toggleMode(t.id)
}

import { openSettings } from './ui-state.svelte'

export type CommandId =
  | 'open'
  | 'save'
  | 'save-as'
  | 'print'
  | 'close-tab'
  | 'toggle-mode'
  | 'preferences'
  | 'share'
  | 'unshare'
  | 'copy-share-link'
  | 'docs'

const handlers: Record<CommandId, () => void | Promise<void>> = {
  'open': cmdOpen,
  'save': cmdSave,
  'save-as': cmdSaveAs,
  'print': cmdPrint,
  'close-tab': cmdCloseActive,
  'toggle-mode': cmdToggleMode,
  'preferences': openSettings,
  'share': sharePublishCurrent,
  'unshare': shareUnpublishCurrent,
  'copy-share-link': shareCopyLinkCurrent,
  'docs': () => {
    import('@tauri-apps/plugin-opener')
      .then(({ openUrl }) => openUrl('https://github.com/bruce/mdeditor'))
      .catch(() => {})
  },
}

export function dispatch(id: CommandId): void | Promise<void> {
  return handlers[id]?.()
}

/** Test-only: replace a handler. Used to wire share entries from share/index.ts. */
export function _registerHandler(id: CommandId, fn: () => void | Promise<void>) {
  handlers[id] = fn
}
