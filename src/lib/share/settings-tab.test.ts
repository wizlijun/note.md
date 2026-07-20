import { describe, it, expect } from 'vitest'
import { coreShareSettingsTab } from './settings-tab'

describe('coreShareSettingsTab', () => {
  it('preserves the four share settings fields with original keys and defaults', () => {
    const tab = coreShareSettingsTab()
    expect(tab.pluginId).toBe('share')
    const keys = tab.schema.map((f) => f.key)
    expect(keys).toEqual(['share.baseUrl', 'share.apiKey', 'share.defaultExpiry', 'share.slugRandomSuffix'])
    expect(tab.schema[2]).toMatchObject({ type: 'select', options: ['never', '7d', '30d', '90d'], default: 'never' })
    expect(tab.manifest.i18n?.zh?.['settings.tab_label']).toBe('分享')
  })
})
