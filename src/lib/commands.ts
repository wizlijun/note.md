import { activeTab, saveActive, saveAs, openFile, closeTab, toggleMode } from './tabs.svelte'
import { confirmDirtyClose, pickOpenFile, pickSaveFile, showError } from './dialogs'

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

export async function cmdCloseActive(): Promise<void> {
  const t = activeTab()
  if (!t) return
  await closeTab(t.id, confirmDirtyClose)
}

export function cmdToggleMode(): void {
  const t = activeTab()
  if (t && t.kind !== 'image') toggleMode(t.id)
}
