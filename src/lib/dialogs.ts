import { ask, save as saveDialog, open as openDialog } from '@tauri-apps/plugin-dialog'
import { pushToast } from './toast.svelte'
import type { DirtyChoice } from './tabs.svelte'
import { basename } from './fs'

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif', 'avif']

const SUBTITLE_EXTS = ['srt', 'vtt', 'ass', 'ssa']

const ALL_EXTS = [
  'md', 'markdown', 'mdown', 'mkd',
  'html', 'htm',
  'txt', 'text', 'log', 'csv', 'tsv', 'env',
  ...SUBTITLE_EXTS,
  'rst', 'org', 'adoc', 'asciidoc', 'tex',
  'diff', 'patch', 'properties',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml',
  'sh', 'bash', 'zsh',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'rs', 'go', 'java', 'c', 'cpp', 'cc', 'h', 'hpp',
  'rb', 'swift', 'kt', 'php', 'cs',
  'css', 'scss', 'sql',
  ...IMAGE_EXTS,
]

/**
 * Confirm-before-close for NAMED dirty files.
 * Untitled dirty files are handled directly in closeTab (NSSavePanel).
 *
 * Two-step flow:
 *   1. "Save / Cancel"  — user can save or cancel (keep editing).
 *   2. If Cancel → "Close without saving / Keep Editing" — explicit discard.
 */
export async function confirmDirtyClose(): Promise<DirtyChoice> {
  const wantSave = await ask('Save changes before closing?', {
    title: 'M↓',
    kind: 'warning',
    okLabel: 'Save',
    cancelLabel: 'Cancel',
  })
  if (wantSave) return 'save'

  const wantDiscard = await ask('Close without saving?', {
    title: 'M↓',
    kind: 'warning',
    okLabel: 'Close without Saving',
    cancelLabel: 'Keep Editing',
  })
  return wantDiscard ? 'discard' : 'cancel'
}

export async function pickOpenFile(): Promise<string | null> {
  const picked = await openDialog({
    multiple: false,
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
      { name: 'HTML', extensions: ['html', 'htm'] },
      { name: 'Subtitles', extensions: SUBTITLE_EXTS },
      { name: 'Images', extensions: IMAGE_EXTS },
      { name: 'All supported', extensions: ALL_EXTS },
    ],
  })
  return typeof picked === 'string' ? picked : null
}

/** Friendly "File Format" filter names shown in the NSSavePanel dropdown. */
function saveFilters(ext?: string) {
  if (!ext) return [
    { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
    { name: 'All supported', extensions: ALL_EXTS },
  ]
  if (['md', 'markdown', 'mdown', 'mkd'].includes(ext))
    return [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] }]
  if (['html', 'htm'].includes(ext))
    return [{ name: 'HTML', extensions: ['html', 'htm'] }]
  if (['txt', 'text', 'log'].includes(ext))
    return [{ name: 'Plain Text', extensions: ['txt', 'text', 'log'] }]
  if (SUBTITLE_EXTS.includes(ext))
    return [{ name: 'Subtitles', extensions: SUBTITLE_EXTS }]
  if (IMAGE_EXTS.includes(ext))
    return [{ name: 'Image', extensions: IMAGE_EXTS }]
  if (ALL_EXTS.includes(ext))
    return [{ name: ext.toUpperCase(), extensions: [ext] }]
  return [{ name: 'All supported', extensions: ALL_EXTS }]
}

/**
 * Open the native NSSavePanel.
 * - No defaultPath → resolves to Documents/untitled.md (avoids empty dir)
 * - With defaultPath → pre-fills filename and navigates to that directory
 */
export async function pickSaveFile(defaultPath?: string): Promise<string | null> {
  let resolvedPath = defaultPath
  if (!resolvedPath) {
    try {
      const { documentDir } = await import('@tauri-apps/api/path')
      resolvedPath = `${(await documentDir()).replace(/\/$/, '')}/untitled.md`
    } catch {
      resolvedPath = 'untitled.md'
    }
  }
  const ext = basename(resolvedPath).split('.').pop()?.toLowerCase()
  const picked = await saveDialog({ defaultPath: resolvedPath, filters: saveFilters(ext) })
  return picked ?? null
}

export function showError(text: string): void {
  pushToast({ level: 'error', message: text })
}
