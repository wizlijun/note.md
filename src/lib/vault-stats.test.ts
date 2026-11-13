import { describe, expect, it } from 'vitest'
import { formatContentBytes, vaultDocumentRules } from './vault-stats'
import { classifyPath } from './fs'
import type { PluginManifest } from './plugins/types'

describe('Vault document statistics classification', () => {
  it('uses host document formats, named files and plugin formats without counting media', () => {
    const plugin = { id: 'test', custom_editors: [{ id: 'custom', entry: 'main.html', file_extensions: ['.custom', '.PNG', 'mp4'] }], file_views: [{ id: 'view', entry: 'main.html', selectors: [{ file_extensions: ['pdf'] }] }] } as unknown as PluginManifest
    const rules = vaultDocumentRules([plugin])
    for (const ext of ['md', 'markdown', 'canvas', 'base', 'csv', 'json', 'custom', 'pdf']) expect(rules.extensions).toContain(ext)
    for (const ext of ['png', 'svg', 'mp4', 'mp3']) expect(rules.extensions).not.toContain(ext)
    expect(rules.names).toContain('makefile')
    for (const ext of vaultDocumentRules([]).extensions) expect(classifyPath(`x.${ext}`)?.kind).not.toBe('image')
  })
  it('does not infer document extensions from content-dependent views', () => {
    const plugin = { id: 'test', file_views: [{ id: 'view', entry: 'main.html', selectors: [{ frontmatter: { foo: ['bar'] } }] }] } as unknown as PluginManifest
    expect(vaultDocumentRules([plugin])).toEqual(vaultDocumentRules([]))
  })
  it('labels binary units accurately', () => {
    expect(formatContentBytes(0)).toBe('0 B')
    expect(formatContentBytes(1023)).toBe('1023 B')
    expect(formatContentBytes(1024)).toBe('1.0 KiB')
    expect(formatContentBytes(1024 ** 2 * 2.5)).toBe('2.5 MiB')
  })
})
