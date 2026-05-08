import { save as saveDialog, message } from '@tauri-apps/plugin-dialog'
import { activeTab, saveActive, saveAs, openFile, closeTab, toggleMode } from './tabs.svelte'
import { confirmDirtyClose, pickOpenFile, pickSaveFile, showError } from './dialogs'
import { exportTabAsPdf, suggestedPdfFilename } from './pdf-export'

export async function cmdOpen(): Promise<void> {
  const p = await pickOpenFile()
  if (!p) return
  try { await openFile(p) } catch (e) { await showError(String(e)) }
}

export async function cmdSave(): Promise<void> {
  const t = activeTab()
  if (!t) return
  try { await saveActive() } catch (e) { await showError(`Save failed: ${e}`) }
}

export async function cmdSaveAs(): Promise<void> {
  const t = activeTab()
  if (!t) return
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
  if (t) toggleMode(t.id)
}

export async function cmdExportPdf(): Promise<void> {
  const tab = activeTab()
  if (!tab) return
  if (tab.kind !== 'markdown' && tab.kind !== 'html') {
    await message('PDF export only supports Markdown and HTML files.', {
      title: 'M↓',
      kind: 'info',
    })
    return
  }
  const outputPath = await saveDialog({
    defaultPath: suggestedPdfFilename(tab.filePath),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (!outputPath) return
  // Defensively ensure .pdf extension if user typed something else.
  const finalPath = outputPath.endsWith('.pdf') ? outputPath : `${outputPath}.pdf`
  try {
    await exportTabAsPdf(tab, finalPath)
  } catch (e) {
    await message(`Export failed: ${e instanceof Error ? e.message : String(e)}`, {
      title: 'M↓',
      kind: 'error',
    })
  }
}
