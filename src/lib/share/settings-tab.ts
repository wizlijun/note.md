import type { SettingsTab } from '../plugins/settings-registry'
import type { PluginManifest } from '../plugins/types'

// Stub manifest supplies localization data to the render-time helpers
// (pluginTabLabel / pluginFieldLabel) without requiring a real plugin binary.
// Storage keys remain share.* — no data migration needed.
const STUB: PluginManifest = {
  id: 'share', name: 'Share', version: 'core', binary: '', host_capabilities: [],
  settings: {
    tab_label: 'Share',
    schema: [
      { key: 'share.baseUrl', type: 'string', label: 'Service Base URL', default: 'https://mdeditor-share.your-account.workers.dev', placeholder: 'https://share.example.com' },
      { key: 'share.apiKey', type: 'secret', label: 'API Key' },
      { key: 'share.defaultExpiry', type: 'select', label: 'Default expiry', options: ['never', '7d', '30d', '90d'], default: 'never' },
      { key: 'share.slugRandomSuffix', type: 'boolean', label: 'Append 3-char random suffix to URL (recommended)', default: true },
    ],
  },
  i18n: {
    zh: { 'settings.tab_label': '分享', 'settings.fields': { 'share.baseUrl': '服务基础 URL', 'share.apiKey': 'API Key', 'share.defaultExpiry': '默认有效期', 'share.slugRandomSuffix': '在 URL 后追加 3 位随机后缀（推荐）' } },
    ja: { 'settings.tab_label': '共有', 'settings.fields': { 'share.baseUrl': 'サービスのベース URL', 'share.apiKey': 'API Key', 'share.defaultExpiry': '既定の有効期限', 'share.slugRandomSuffix': 'URL に 3 文字のランダムな接尾辞を追加（推奨）' } },
    de: { 'settings.tab_label': 'Teilen', 'settings.fields': { 'share.baseUrl': 'Dienst-Basis-URL', 'share.apiKey': 'API-Schlüssel', 'share.defaultExpiry': 'Standardablauf', 'share.slugRandomSuffix': '3-stelliges Zufallssuffix an URL anhängen (empfohlen)' } },
  },
}

export function coreShareSettingsTab(): SettingsTab {
  return { pluginId: 'share', label: STUB.settings!.tab_label, schema: STUB.settings!.schema, manifest: STUB }
}
