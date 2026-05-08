import { describe, it, expect } from 'vitest'
import { collectSettingsTabs } from './settings-registry'
import type { PluginManifest } from './types'

const m = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'share', name: 'Share', version: '1.0.0', binary: 'bin',
  host_capabilities: ['toast'],
  settings: {
    tab_label: '分享',
    schema: [
      { key: 'share.baseUrl', type: 'string', label: 'Base URL', default: 'https://x' },
      { key: 'share.apiKey', type: 'secret', label: 'API Key' },
    ],
  },
  ...over,
})

describe('collectSettingsTabs', () => {
  it('returns one tab per plugin with settings', () => {
    const tabs = collectSettingsTabs([m()])
    expect(tabs.length).toBe(1)
    expect(tabs[0].label).toBe('分享')
    expect(tabs[0].pluginId).toBe('share')
    expect(tabs[0].schema.length).toBe(2)
  })

  it('skips plugins without settings block', () => {
    const m2 = { ...m({ settings: undefined }) }
    const tabs = collectSettingsTabs([m2])
    expect(tabs).toEqual([])
  })
})
