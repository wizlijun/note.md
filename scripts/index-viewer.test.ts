import { describe, expect, it } from 'vitest'
import manifest from '../plugins-src/index-viewer/manifest.v2.json'
import { fileViewFor, isValidFileView } from '../src/lib/plugins/file-views'
import type { PluginManifest } from '../src/lib/plugins/types'
import { pluginCategoryFromManifest } from './gen-plugin-index.mjs'

describe('Index Viewer host integration', () => {
  const hostManifest = { ...manifest, binary: '', host_capabilities: manifest.capabilities, file_views: manifest.contributes.file_views } as PluginManifest
  it('uses the existing file-name matcher and editor mode slot without metadata', () => {
    expect(isValidFileView(hostManifest.file_views![0])).toBe(true)
    expect(fileViewFor({ path: '/vault/books.index.md', kind: 'markdown', content: '# Books' }, [hostManifest])).toEqual({ pluginId: manifest.id, viewId: 'index', icon: 'generic', entry: 'index.html' })
    for (const path of ['/vault/books.md', '/vault/books.index.md.bak', '/vault/today.timeline.md']) {
      expect(fileViewFor({ path, kind: 'markdown', content: '# Books' }, [hostManifest])).toBeNull()
    }
  })
  it('declares a read-only file-view command in the reading category', () => {
    expect(manifest.capabilities).toEqual(['vault.read', 'editor.open'])
    expect(manifest.contributes.menus[0].command).toBe(manifest.contributes.file_views[0].open_command)
    expect(pluginCategoryFromManifest(manifest)).toBe('reading')
  })
})
