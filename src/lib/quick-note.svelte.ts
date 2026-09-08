// Quick-note: create a unique untitled markdown file in the vault's inbox and open
// it for editing. Triggered from the tray "New Markdown" item and the
// system-wide Cmd+Ctrl+M hotkey (both emit the `quick-note` event, wired in
// App.svelte). The inbox sub-directory is a vault-scoped setting
// (`{vault}/.notemd/settings.json`, key `inboxDir`, default `inbox`).

import { invoke } from '@tauri-apps/api/core'
import { mkdir, exists } from '@tauri-apps/plugin-fs'
import { openFile } from './tabs.svelte'
import { writeMd } from './fs'
import { requestEditorFocus } from './editor-focus.svelte'
import { newFileText } from './new-file'
import { pushToast } from './toast.svelte'
import { t } from './i18n/store.svelte'
import { quickNoteFileName } from './quick-note-name'

export { quickNoteFileName }

export const DEFAULT_INBOX_DIR = 'inbox'

/** The configured inbox directory name (vault-relative). Surfaced in Settings;
 *  the actual quick-note path is resolved backend-side via `notemd_quick_note_dir`. */
export const inboxDir = $state<{ value: string }>({ value: DEFAULT_INBOX_DIR })

interface VaultSettingsDto {
  inboxDir?: string | null
}

/** Load the inbox dir from vault settings (call alongside loadOutlineDirs). */
export async function loadInboxDir(): Promise<void> {
  const dto = await invoke<VaultSettingsDto>('notemd_vault_settings_get').catch(
    () => ({}) as VaultSettingsDto,
  )
  const v = dto?.inboxDir
  inboxDir.value = typeof v === 'string' && v.trim() !== '' ? v : DEFAULT_INBOX_DIR
}

/** Persist a new inbox dir name; empty/whitespace falls back to the default. */
export async function setInboxDir(raw: string): Promise<void> {
  const merged = await invoke<VaultSettingsDto>('notemd_vault_settings_set', {
    inboxDir: raw.trim() || DEFAULT_INBOX_DIR,
  })
  inboxDir.value = merged?.inboxDir || DEFAULT_INBOX_DIR
}

// Serialize allocation and persistence so simultaneous new-note triggers cannot
// choose the same free filename before either write has completed.
let creationQueue: Promise<void> = Promise.resolve()

/** Create an empty OKF note on disk, then open it in the remembered editor mode. */
export function createQuickNote(now: Date = new Date()): Promise<void> {
  const creation = creationQueue.then(() => createQuickNoteFile(now))
  creationQueue = creation.catch(() => {})
  return creation
}

async function createQuickNoteFile(now: Date): Promise<void> {
  let dir: string
  try {
    dir = await invoke<string>('notemd_quick_note_dir')
  } catch {
    pushToast({ level: 'warn', message: t('quickNote.noVault') })
    return
  }
  try {
    await mkdir(dir, { recursive: true })
    const prefix = `${dir.replace(/\/+$/, '')}/untitled`
    let fullPath = `${prefix}.md`
    for (let suffix = 2; await exists(fullPath); suffix++) {
      if (suffix > 999) throw new Error('Unable to allocate a unique note filename')
      fullPath = `${prefix}-${suffix}.md`
    }
    const by = (await import('./okf/identity')).humanActorNow()
    await writeMd(fullPath, newFileText('', by ? { by, at: now.toISOString() } : undefined))
    // Set the focus request BEFORE openFile so the editor consumes it on mount.
    requestEditorFocus(fullPath)
    await openFile(fullPath)
  } catch (e) {
    pushToast({ level: 'error', message: t('quickNote.createFailed'), detail: String(e) })
  }
}
