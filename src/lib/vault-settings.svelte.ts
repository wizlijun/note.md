// Vault-scoped settings mirror for the settings UI. Backed by the
// `{vault}/.notemd/settings.json` file the Rust `notemd_vault_settings_*`
// commands read/write, so these values travel with the git-synced vault.
import { invoke } from '@tauri-apps/api/core'

/** Default sync sub-directory; mirrors `vault_settings::DEFAULT_SYNC_DIR`. */
export const DEFAULT_SYNC_DIR = 'sync'

/** Raw settings DTO as returned by the backend (absent field = null). */
export interface VaultSettingsDto {
  syncDir?: string | null
  wikipageDir?: string | null
  dailynoteDir?: string | null
}

export const vaultSettings = $state<{
  syncDir: string
  vaultPath: string | null
  loaded: boolean
}>({
  syncDir: DEFAULT_SYNC_DIR,
  vaultPath: null,
  loaded: false,
})

/** Load the current vault path and sync dir. Never throws — an unconfigured
 *  vault (backend rejects) leaves path null and the sync dir at its default. */
export async function loadVaultSettings(): Promise<void> {
  const root = await invoke<string | null>('sotvault_vault_root').catch(() => null)
  const dto = await invoke<VaultSettingsDto>('notemd_vault_settings_get').catch(
    () => ({}) as VaultSettingsDto,
  )
  vaultSettings.vaultPath = root ?? null
  vaultSettings.syncDir = dto?.syncDir ?? DEFAULT_SYNC_DIR
  vaultSettings.loaded = true
}

/** Persist the sync dir (backend validates; rejection propagates to the caller
 *  for a toast). Only the syncDir field is sent — other fields are untouched. */
export async function saveSyncDir(raw: string): Promise<void> {
  const merged = await invoke<VaultSettingsDto>('notemd_vault_settings_set', { syncDir: raw })
  vaultSettings.syncDir = merged?.syncDir ?? DEFAULT_SYNC_DIR
}
