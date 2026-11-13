import { invoke } from '@tauri-apps/api/core'
import { refreshSotvault } from './sotvault.svelte'
import { loadVaultSettings } from './vault-settings.svelte'
import { loadOutlineDirs } from './outline/dirs.svelte'
import { loadInboxDir } from './quick-note.svelte'
import { openSettings, closeSettings } from './ui-state.svelte'

export interface VaultInspection {
  root: string | null
  homeDir: string | null
  documentsDir: string | null
  accessible: boolean
  error: string | null
  git: {
    state: 'unavailable' | 'none' | 'ready' | 'invalid'
    branch: string | null
    remote: string | null
    hasCommits: boolean
    authorConfigured: boolean
    error: string | null
  }
  syncEnabled: boolean
  onboarding: 'completed' | 'skipped' | null
}

export const vaultManagement = $state<{
  info: VaultInspection | null
  loading: boolean
  error: string | null
  onboardingOpen: boolean
  onboardingShownThisRun: boolean
}>({ info: null, loading: false, error: null, onboardingOpen: false, onboardingShownThisRun: false })

let inspectionGeneration = 0

/** Home abbreviation is presentation only; callers retain absolute paths. */
export function abbreviateHome(path: string, home: string | null | undefined): string {
  if (!home) return path
  const windows = /^[A-Za-z]:[\\/]/.test(home)
  const normalizedHome = home.replace(/[\\/]+$/, '')
  const comparePath = windows ? path.replace(/\\/g, '/').toLowerCase() : path
  const compareHome = windows ? normalizedHome.replace(/\\/g, '/').toLowerCase() : normalizedHome
  if (comparePath === compareHome) return '~'
  if (comparePath.startsWith(`${compareHome}/`)) return `~${path.slice(normalizedHome.length)}`
  return path
}

export function validVaultName(name: string): boolean {
  return name.trim() === name && name.length > 0 && name !== '.' && name !== '..'
    && !/[<>:"/\\|?*\u0000-\u001f]/.test(name) && !/[. ]$/.test(name)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
}

export function vaultChildPath(parent: string, name: string): string {
  const separator = parent.includes('\\') ? '\\' : '/'
  return `${parent.replace(/[\\/]+$/, '')}${separator}${name}`
}

export async function refreshVaultManagement(): Promise<VaultInspection> {
  const generation = ++inspectionGeneration
  vaultManagement.loading = true
  try {
    const info = await invoke<VaultInspection>('vault_inspect')
    if (generation === inspectionGeneration) {
      vaultManagement.info = info
      vaultManagement.error = null
    }
    return info
  } catch (error) {
    if (generation === inspectionGeneration) vaultManagement.error = String(error)
    throw error
  } finally {
    if (generation === inspectionGeneration) vaultManagement.loading = false
  }
}

/** Call after desktop startup has hydrated settings; CLI callers never call this. */
export async function initializeVaultOnboarding(): Promise<void> {
  const info = await refreshVaultManagement()
  if (info.root) {
    if (info.accessible && !info.onboarding) {
      await invoke('vault_set_onboarding', { value: 'completed' })
      info.onboarding = 'completed'
      vaultManagement.info = info
    }
    return
  }
  if (!info.onboarding) showVaultOnboarding()
}

function showVaultOnboarding(): void {
  closeSettings()
  vaultManagement.onboardingShownThisRun = true
  vaultManagement.onboardingOpen = true
}

export async function openVaultManagement(): Promise<void> {
  try {
    const info = await refreshVaultManagement()
    if (info.root) openSettings('vault')
    else showVaultOnboarding()
  } catch {
    // Keep an accessible retry surface when inspection itself failed.
    openSettings('vault')
  }
}

export async function skipVaultOnboarding(): Promise<void> {
  await invoke('vault_set_onboarding', { value: 'skipped' })
  if (vaultManagement.info) vaultManagement.info.onboarding = 'skipped'
  vaultManagement.onboardingOpen = false
}

/** Apply a mutation response before refreshing consumers, invalidating stale reads. */
export async function applyVaultInspection(info: VaultInspection): Promise<void> {
  ++inspectionGeneration
  vaultManagement.info = info
  vaultManagement.error = null
  vaultManagement.loading = false
  const refreshed = await Promise.allSettled([refreshSotvault(), loadVaultSettings(), loadOutlineDirs(), loadInboxDir()])
  const failed = refreshed.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') vaultManagement.error = String(failed.reason)
}

export async function createVault(parent: string, name: string): Promise<VaultInspection> {
  const info = await invoke<VaultInspection>('vault_create', { parent, name, expectedRoot: null })
  await applyVaultInspection(info)
  return info
}

export async function activateVault(path: string, expectedRoot: string | null): Promise<VaultInspection> {
  const info = await invoke<VaultInspection>('vault_activate', { path, expectedRoot })
  await applyVaultInspection(info)
  return info
}
