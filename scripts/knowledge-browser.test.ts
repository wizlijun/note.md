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
  } as PluginManifest

  it('claims JSON files so the viewer can confirm the v3 schema marker and fall back otherwise', () => {
    expect(isValidFileView(hostManifest.file_views![0])).toBe(true)
    for (const path of ['/vault/research/example.knowledge.json', '/vault/research/meeting-knowledge-v3.json', '/vault/inbox/result.json']) {
      expect(fileViewFor({ path, kind: 'code', content: '{}' }, [hostManifest])).toEqual({
        pluginId: manifest.id, viewId: 'knowledge', icon: 'generic', entry: 'viewer.html',
      })
    }
    for (const path of ['/vault/research/example.txt', '/vault/research/example.knowledge.json.bak']) {
      expect(fileViewFor({ path, kind: 'code', content: '{}' }, [hostManifest])).toBeNull()
    }
  })

  it('uses one host-owned menu command that chooses JSON before opening the file view', () => {
    const commands = manifest.contributes.menus.map(item => item.command)
    expect(commands).toEqual(['view-knowledge'])
    expect(manifest.contributes).not.toHaveProperty('windows')
    expect(manifest.contributes.file_views[0].open_command).toBe('view-knowledge')
    expect(manifest.contributes.menus[0].prompt).toEqual({
      kind: 'open-dialog', filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    expect(hostManifest.open_windows).toBeUndefined()
  })

  it('is a read-only universal UI plugin in the Reading category', () => {
    expect(manifest.version).toBe('3.2.0')
    expect(manifest).not.toHaveProperty('binary')
    expect(manifest.capabilities).toEqual(['vault.read', 'editor.open', 'clipboard.write'])
    expect(manifest.capabilities).not.toContain('vault.write')
    expect(pluginCategoryFromManifest(manifest)).toBe('reading')
  })
})
