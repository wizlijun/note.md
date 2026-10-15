import { invoke } from '@tauri-apps/api/core'

export interface DesktopCapabilities {
  distributionChannel: 'direct' | 'package-manager'
  cliInstall: boolean
  themeFontInstall: boolean
  setDefaultApp: boolean
  location: boolean
  globalShortcuts: boolean
  windowDecorations: boolean
}

export interface LinuxWindowDecorationsUpdate {
  value: boolean | null
  capabilities: DesktopCapabilities
  failedWindows: { label: string; error: string }[]
}

/** Authoritative process-lifetime identity. Unknown capabilities grant no access. */
export const desktopCapabilities = $state<{
  value: DesktopCapabilities | null
  loading: boolean
  error: string | null
}>({ value: null, loading: false, error: null })

let pending: Promise<DesktopCapabilities> | null = null

export function loadDesktopCapabilities(): Promise<DesktopCapabilities> {
  if (desktopCapabilities.value) return Promise.resolve(desktopCapabilities.value)
  if (pending) return pending
  desktopCapabilities.loading = true
  desktopCapabilities.error = null
  pending = (async () => {
    try {
      const value = await invoke<DesktopCapabilities>('desktop_capabilities')
      if (!value || !['direct', 'package-manager'].includes(value.distributionChannel)
        || ['cliInstall', 'themeFontInstall', 'setDefaultApp', 'location', 'globalShortcuts', 'windowDecorations']
          .some((key) => typeof value[key as keyof DesktopCapabilities] !== 'boolean')) {
        throw new Error('Invalid desktop capabilities')
      }
      desktopCapabilities.value = value
      return value
    } catch (error) {
      desktopCapabilities.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      desktopCapabilities.loading = false
      pending = null
    }
  })()
  return pending
}

export async function setLinuxWindowDecorations(value: boolean | null): Promise<LinuxWindowDecorationsUpdate> {
  if (pending) await pending.catch(() => {})
  const result = await invoke<LinuxWindowDecorationsUpdate>('linux_window_decorations_set', { value })
  desktopCapabilities.value = result.capabilities
  desktopCapabilities.error = null
  return result
}
