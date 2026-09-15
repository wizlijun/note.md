import { describe, expect, it } from 'vitest'
import manifest from '../plugins-src/knowledge-browser/manifest.v2.json'
import { fileViewFor, isValidFileView } from '../src/lib/plugins/file-views'
import type { PluginManifest } from '../src/lib/plugins/types'
import { pluginCategoryFromManifest } from './gen-plugin-index.mjs'

describe('Knowledge Browser host integration', () => {
  const hostManifest = {
    ...manifest,
    binary: '',
    host_capabilities: manifest.capabilities,
    file_views: manifest.contributes.file_views,
    open_windows: { 'open-browser': 'main' },
  } as PluginManifest

  it('claims only the two named JSON dataset forms through the existing code-file slot', () => {
    expect(isValidFileView(hostManifest.file_views![0])).toBe(true)
    for (const path of ['/vault/research/example.knowledge.json', '/vault/research/meeting-knowledge-v3.json']) {
      expect(fileViewFor({ path, kind: 'code', content: '{}' }, [hostManifest])).toEqual({
        pluginId: manifest.id, viewId: 'knowledge', icon: 'generic', entry: 'viewer.html',
      })
    }
    for (const path of ['/vault/research/knowledge.json', '/vault/research/example.json', '/vault/research/example.knowledge.json.bak']) {
      expect(fileViewFor({ path, kind: 'code', content: '{}' }, [hostManifest])).toBeNull()
    }
  })

  it('exposes only the browser window in the global menu while keeping the file-view command host-owned', () => {
    const commands = manifest.contributes.menus.map(item => item.command)
    expect(commands).toEqual(['open-browser'])
    expect(manifest.contributes.windows[0].open_command).toBe('open-browser')
    expect(manifest.contributes.file_views[0].open_command).toBe('view-knowledge')
    expect(commands).not.toContain(manifest.contributes.file_views[0].open_command)
    expect(hostManifest.open_windows?.['open-browser']).toBe('main')
  })

  it('is a read-only universal UI plugin in the Reading category', () => {
    expect(manifest).not.toHaveProperty('binary')
    expect(manifest.capabilities).toEqual([
      'vault.read', 'editor.open', 'dialog', 'fs.read:dialog', 'clipboard.write', 'settings',
    ])
    expect(manifest.capabilities).not.toContain('vault.write')
    expect(pluginCategoryFromManifest(manifest)).toBe('reading')
  })
})
