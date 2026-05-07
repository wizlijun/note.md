import { ask, message, save as saveDialog, open as openDialog } from '@tauri-apps/plugin-dialog'
import type { DirtyChoice } from './tabs.svelte'

export async function confirmDirtyClose(): Promise<DirtyChoice> {
  const wantSave = await ask('Save changes before closing?', {
    title: 'mdeditor',
    kind: 'warning',
    okLabel: 'Save',
    cancelLabel: 'Cancel',
  })
  if (wantSave) return 'save'
  const wantDiscard = await ask('Close without saving?', {
    title: 'mdeditor',
    kind: 'warning',
    okLabel: 'Discard changes',
    cancelLabel: 'Keep editing',
  })
  return wantDiscard ? 'discard' : 'cancel'
}

export async function pickOpenFile(): Promise<string | null> {
  const picked = await openDialog({
    multiple: false,
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] }],
  })
  return typeof picked === 'string' ? picked : null
}

export async function pickSaveFile(defaultPath?: string): Promise<string | null> {
  const picked = await saveDialog({
    defaultPath,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  })
  return picked ?? null
}

export async function showError(text: string): Promise<void> {
  await message(text, { title: 'mdeditor', kind: 'error' })
}
