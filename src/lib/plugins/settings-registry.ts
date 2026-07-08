import type { PluginManifest, SettingsField } from './types'

export interface SettingsTab {
  pluginId: string
  label: string
  schema: SettingsField[]
  /** The source manifest, so labels can be localized at render time. */
  manifest: PluginManifest
}

export function collectSettingsTabs(manifests: PluginManifest[]): SettingsTab[] {
  const out: SettingsTab[] = []
  for (const m of manifests) {
    if (!m.settings) continue
    out.push({ pluginId: m.id, label: m.settings.tab_label, schema: m.settings.schema, manifest: m })
  }
  return out
}
