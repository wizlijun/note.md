import { describe, it, expect } from 'vitest'
import { coreShareSettingsTab } from './settings-tab'

describe('coreShareSettingsTab', () => {
  it('preserves existing settings and defaults to using the current theme', () => {
    const tab = coreShareSettingsTab()
    expect(tab.pluginId).toBe('share')
    const keys = tab.schema.map((f) => f.key)
    expect(keys).toEqual(['share.baseUrl', 'share.apiKey', 'share.defaultExpiry', 'share.slugRandomSuffix', 'share.useCurrentTheme'])
    expect(tab.schema[2]).toMatchObject({ type: 'select', options: ['never', '7d', '30d', '90d'], default: 'never' })
    expect(tab.schema[4]).toMatchObject({ type: 'boolean', default: true })
    expect(tab.manifest.i18n?.zh?.['settings.fields']?.['share.useCurrentTheme']).toContain('使用当前主题')
    expect(tab.manifest.i18n?.zh?.['settings.tab_label']).toBe('分享')
  })
})
