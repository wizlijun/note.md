import { dispatchFileViewCommand, type FileViewCommandDeps } from './file-view-commands'
import { evaluateEnabledWhen } from './enabled-when'
import type { EnabledWhenContext, PluginManifest } from './types'
import type { PluginCommandSource } from './runtime.svelte'

/** Recheck the live manifest and per-command gates at every manual entry. */
export function pluginCommandEnabled(manifest: PluginManifest, command: string | null, context: EnabledWhenContext, source: PluginCommandSource = 'menu'): boolean {
  try {
    if (manifest.available_when && !evaluateEnabledWhen(manifest.available_when, context)) return false
    const menu = source === 'menu'
      ? manifest.menus?.find(item => item.command === command)
      : manifest.context_menus?.find(item => item.command === command
        && item.location === (source === 'tab-context' ? 'tab' : 'editor'))
    return !menu?.enabled_when || evaluateEnabledWhen(menu.enabled_when, context)
  } catch { return false }
}

interface AppLaunchDeps {
  manifests(): PluginManifest[]
  context(pluginId: string): EnabledWhenContext
  fileView: FileViewCommandDeps
  openWindow(pluginId: string, windowId: string): Promise<void>
  recordUse(pluginId: string): Promise<void>
  reportUsageError(error: unknown): void
}

export function recordAcceptedAppUse(id: string, deps: Pick<AppLaunchDeps, 'recordUse' | 'reportUsageError'>): void {
  // Statistics are best effort; successful navigation never waits for disk I/O.
  void Promise.resolve().then(() => deps.recordUse(id)).catch(deps.reportUsageError)
}

/** Host-owned manual branches shared by native menu and runtime UI dispatch. */
export async function launchPluginApp(pluginId: string, command: string, deps: AppLaunchDeps, source: PluginCommandSource = 'menu'): Promise<boolean> {
  const manifest = deps.manifests().find(item => item.id === pluginId)
  if (!manifest || !pluginCommandEnabled(manifest, command, deps.context(pluginId), source)) return true
  const prompt = source === 'menu' ? manifest.menus?.find(item => item.command === command)?.prompt : undefined
  const handled = await dispatchFileViewCommand(manifest, command, deps.fileView, {
    alwaysPickFile: prompt?.kind === 'open-dialog',
    onAccepted: () => recordAcceptedAppUse(pluginId, deps),
  })
  if (handled) return true
  const windowId = manifest.open_windows?.[command]
  if (!windowId) return false
  await deps.openWindow(pluginId, windowId)
  recordAcceptedAppUse(pluginId, deps)
  return true
}

/** This event is emitted only by successful tray/hotkey opens, never auto activation. */
export function observeManualAppOpens(
  subscribe: (event: string, handler: (event: { payload: string }) => void) => Promise<() => void>,
  deps: Pick<AppLaunchDeps, 'recordUse' | 'reportUsageError'>,
): Promise<() => void> {
  return subscribe('plugin-manual-opened', event => recordAcceptedAppUse(event.payload, deps))
}
