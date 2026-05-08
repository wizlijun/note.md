import { describe, it, expect } from 'vitest'
import { validateManifest, buildRegistry, findShortcutConflicts } from './registry'
import type { PluginManifest } from './types'

const valid = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'share',
  name: 'Share',
  version: '1.0.0',
  binary: 'bin',
  host_capabilities: ['toast'],
  ...over,
})

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    expect(validateManifest(valid())).toEqual({ ok: true, value: valid() })
  })
  it('rejects missing id', () => {
    const bad = { ...valid() } as Partial<PluginManifest>; delete bad.id
    expect(validateManifest(bad).ok).toBe(false)
  })
  it('rejects non-kebab-case id', () => {
    expect(validateManifest(valid({ id: 'My_Plugin' })).ok).toBe(false)
    expect(validateManifest(valid({ id: 'a' })).ok).toBe(true)
    expect(validateManifest(valid({ id: 'a-b-1' })).ok).toBe(true)
  })
  it('rejects unknown capability', () => {
    expect(validateManifest(valid({ host_capabilities: ['mystery' as never] })).ok).toBe(false)
  })
  it('accepts settings.write:<scope> capability', () => {
    expect(validateManifest(valid({ host_capabilities: ['settings.write:share.records'] })).ok).toBe(true)
    expect(validateManifest(valid({ host_capabilities: ['settings.write:share.*'] })).ok).toBe(true)
  })
  it('rejects when settings keys do not match plugin id prefix', () => {
    const m = valid({
      settings: { tab_label: 'Share', schema: [{ key: 'other.foo', type: 'string', label: 'X' }] },
    })
    expect(validateManifest(m).ok).toBe(false)
  })
})

describe('buildRegistry', () => {
  it('rejects duplicate ids', () => {
    const result = buildRegistry([valid(), valid()])
    expect(result.errors.length).toBeGreaterThan(0)
    expect(Object.keys(result.byId).length).toBe(1)
  })
  it('keeps first wins on duplicate', () => {
    const a = valid({ name: 'first' })
    const b = valid({ name: 'second' })
    const r = buildRegistry([a, b])
    expect(r.byId['share'].name).toBe('first')
  })
})

describe('findShortcutConflicts', () => {
  it('returns empty when no conflicts', () => {
    const m = valid({ menus: [{ location: 'file', label: 'A', shortcut: 'Cmd+1', command: 'a' }] })
    expect(findShortcutConflicts([m], ['Cmd+S'])).toEqual([])
  })
  it('detects conflict between two plugins', () => {
    const a = valid({ id: 'p1', menus: [{ location: 'file', label: 'A', shortcut: 'Cmd+L', command: 'a' }] })
    const b = valid({ id: 'p2', menus: [{ location: 'file', label: 'B', shortcut: 'Cmd+L', command: 'b' }] })
    expect(findShortcutConflicts([a, b], []).length).toBe(1)
  })
  it('detects conflict with reserved core shortcut', () => {
    const a = valid({ menus: [{ location: 'file', label: 'A', shortcut: 'Cmd+S', command: 'a' }] })
    expect(findShortcutConflicts([a], ['Cmd+S']).length).toBe(1)
  })
})
