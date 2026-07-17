import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildCustomEditorRegistry, customEditorFor } from './custom-editors'
import type { PluginManifest } from './types'

const mf = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'notemd.base',
  name: 'Base',
  version: '1.0.0',
  binary: '',
  host_capabilities: [],
  ...over,
})

const baseEditor = {
  id: 'base-table',
  file_extensions: ['.base'],
  entry: 'editor.html',
}

afterEach(() => vi.restoreAllMocks())

describe('buildCustomEditorRegistry', () => {
  it('maps a single extension to its editor', () => {
    const reg = buildCustomEditorRegistry([mf({ custom_editors: [baseEditor] })])
    expect(reg.get('base')).toEqual({
      pluginId: 'notemd.base',
      editorId: 'base-table',
      entry: 'editor.html',
    })
  })

  it('maps every extension of a multi-ext editor (dot optional, case-insensitive)', () => {
    const reg = buildCustomEditorRegistry([
      mf({ custom_editors: [{ id: 'e', file_extensions: ['.Base', 'DB', '.tbl'], entry: 'e.html' }] }),
    ])
    expect(reg.size).toBe(3)
    for (const ext of ['base', 'db', 'tbl']) {
      expect(reg.get(ext)).toEqual({ pluginId: 'notemd.base', editorId: 'e', entry: 'e.html' })
    }
  })

  it('returns an empty map when no plugin has custom_editors', () => {
    expect(buildCustomEditorRegistry([mf(), mf({ id: 'p.other' })]).size).toBe(0)
  })

  it('is empty for v1-only hosts (no custom_editors field)', () => {
    const v1: PluginManifest = mf({ id: 'share', menus: [] })
    expect(buildCustomEditorRegistry([v1]).size).toBe(0)
  })

  it('first plugin wins on a colliding extension and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = buildCustomEditorRegistry([
      mf({ id: 'a.one', custom_editors: [{ id: 'x', file_extensions: ['.z'], entry: 'a.html' }] }),
      mf({ id: 'b.two', custom_editors: [{ id: 'y', file_extensions: ['.z'], entry: 'b.html' }] }),
    ])
    expect(reg.get('z')!.pluginId).toBe('a.one')
    expect(warn).toHaveBeenCalledOnce()
  })

  it('skips malformed editor entries', () => {
    const reg = buildCustomEditorRegistry([
      mf({
        custom_editors: [
          { id: '', file_extensions: ['.a'], entry: 'e.html' } as never, // no id
          { id: 'ok', file_extensions: [], entry: 'e.html' }, // no extensions
          { id: 'ok2', file_extensions: ['.b'], entry: 'ok.html' }, // valid
        ],
      }),
    ])
    expect(reg.size).toBe(1)
    expect(reg.get('b')!.editorId).toBe('ok2')
  })
})

describe('customEditorFor', () => {
  const manifests = [mf({ custom_editors: [baseEditor] })]

  it('finds a registered editor by extension (dot or bare)', () => {
    expect(customEditorFor('.base', manifests)!.editorId).toBe('base-table')
    expect(customEditorFor('base', manifests)!.editorId).toBe('base-table')
    expect(customEditorFor('.BASE', manifests)!.editorId).toBe('base-table')
  })

  it('returns null for an unregistered extension', () => {
    expect(customEditorFor('.md', manifests)).toBeNull()
    expect(customEditorFor('', manifests)).toBeNull()
  })
})
