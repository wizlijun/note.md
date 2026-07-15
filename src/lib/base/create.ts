import { writeTextFile } from '@tauri-apps/plugin-fs'
import { pickSaveFile, showError } from '../dialogs'
import { openFile } from '../tabs.svelte'

/** Starter .base YAML: one table view showing the file name. */
export function newBaseTemplate(): string {
  return `views:
  - type: table
    name: Table
    order:
      - file.name
`
}

/**
 * File ▸ New Base: pick a location via the save dialog, write the starter
 * template there, then open it (as a base table tab that scans its folder).
 * A cancelled dialog is a no-op.
 */
export async function createNewBase(): Promise<void> {
  try {
    const path = await pickSaveFile('untitled.base')
    if (!path) return
    await writeTextFile(path, newBaseTemplate())
    await openFile(path)
  } catch (e) {
    showError(String(e))
  }
}
