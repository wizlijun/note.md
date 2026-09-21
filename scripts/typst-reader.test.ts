import { describe, expect, it } from 'vitest'
import manifest from '../plugins-src/typst-reader/manifest.v2.json'
import { fileViewFor, isValidFileView } from '../src/lib/plugins/file-views'
import type { PluginManifest } from '../src/lib/plugins/types'
import { pluginCategoryFromManifest } from './gen-plugin-index.mjs'

describe('Typeset Reader host integration', () => {
  const hostManifest = {
    ...manifest,
    binary: '',
    host_capabilities: manifest.capabilities,
    file_views: manifest.contributes.file_views,
  } as PluginManifest

  it('claims exactly *.typeset.md with the existing file-view matcher', () => {
    expect(isValidFileView(hostManifest.file_views![0])).toBe(true)
    expect(fileViewFor(
      { path: '/vault/books/2026-09/Title/book.typeset.md', kind: 'markdown', content: '# Book' },
      [hostManifest],
    )).toEqual({ pluginId: manifest.id, viewId: 'typeset', icon: 'book', entry: 'index.html' })
    for (const path of ['/vault/book.md', '/vault/book.typst.md', '/vault/book.typeset.md.bak', '/vault/typeset.md']) {
      expect(fileViewFor({ path, kind: 'markdown', content: '# Book' }, [hostManifest])).toBeNull()
    }
  })

  it('ships a lazy native renderer in the reading category', () => {
    expect(manifest.binary).toEqual({
      'aarch64-apple-darwin': 'bin/notemd-typst-reader',
      'x86_64-apple-darwin': 'bin/notemd-typst-reader',
    })
    expect(manifest.activation.events).toEqual([])
    expect(manifest.contributes.menus[0].command).toBe(manifest.contributes.file_views[0].open_command)
    expect(pluginCategoryFromManifest(manifest)).toBe('reading')
  })
})
