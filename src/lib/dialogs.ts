import { ask, message, save as saveDialog, open as openDialog } from '@tauri-apps/plugin-dialog'
import type { DirtyChoice } from './tabs.svelte'
import { basename } from './fs'

const ALL_EXTS = [
  'md', 'markdown', 'mdown', 'mkd',
  'html', 'htm',
  'txt', 'log', 'csv', 'tsv', 'env',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml',
  'sh', 'bash', 'zsh',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'rs', 'go', 'java', 'c', 'cpp', 'cc', 'h', 'hpp',
  'rb', 'swift', 'kt', 'php', 'cs',
  'css', 'scss', 'sql',
]

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
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
      { name: 'HTML', extensions: ['html', 'htm'] },
      { name: 'All supported', extensions: ALL_EXTS },
    ],
  })
  return typeof picked === 'string' ? picked : null
}

/**
 * Suggest a filter that matches the current file's extension so Save As
 * defaults to the same kind. Falls back to "All supported" if extension is
 * unrecognized.
 */
export async function pickSaveFile(defaultPath?: string): Promise<string | null> {
  const ext = defaultPath
    ? basename(defaultPath).split('.').pop()?.toLowerCase()
    : undefined
  const filters = ext && ALL_EXTS.includes(ext)
    ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All supported', extensions: ALL_EXTS }]
    : [{ name: 'All supported', extensions: ALL_EXTS }]
  const picked = await saveDialog({ defaultPath, filters })
  return picked ?? null
}

export async function showError(text: string): Promise<void> {
  await message(text, { title: 'mdeditor', kind: 'error' })
}
