import type { PluginManifest, SettingsField } from './types'

export interface SettingsTab {
  pluginId: string
  label: string
  schema: SettingsField[]
}

export function collectSettingsTabs(manifests: PluginManifest[]): SettingsTab[] {
  const out: SettingsTab[] = []
  for (const m of manifests) {
    if (!m.settings) continue
    out.push({ pluginId: m.id, label: m.settings.tab_label, schema: m.settings.schema })
  }
  return out
}
