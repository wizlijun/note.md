import { describe, it, expect } from 'vitest'
import { validateManifest, buildRegistry, findShortcutConflicts, findCliConflicts } from './registry'
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

describe('manifest cli validation', () => {
  const base = {
    id: 'demo',
    name: 'Demo',
    version: '0.1.0',
    binary: 'bin',
    host_capabilities: [] as string[],
  }

  it('accepts a well-formed cli entry', () => {
    const r = validateManifest({
      ...base,
      cli: [{ subcommand: 'demo', command: 'noop', summary: 's' }],
    })
    expect(r.ok).toBe(true)
  })

  it('rejects subcommand that collides with a builtin', () => {
    const r = validateManifest({
      ...base,
      cli: [{ subcommand: 'help', command: 'noop', summary: 's' }],
    })
    expect(r.ok).toBe(false)
  })

  it('rejects subcommand with bad characters', () => {
    const r = validateManifest({
      ...base,
      cli: [{ subcommand: 'Bad Name', command: 'noop', summary: 's' }],
    })
    expect(r.ok).toBe(false)
  })

  it('rejects alias that does not start with "-"', () => {
    const r = validateManifest({
      ...base,
      cli: [{ subcommand: 'demo', aliases: ['ess'], command: 'noop', summary: 's' }],
    })
    expect(r.ok).toBe(false)
  })

  it('rejects alias that collides with a reserved global flag', () => {
    const r = validateManifest({
      ...base,
      cli: [{ subcommand: 'demo', aliases: ['--json'], command: 'noop', summary: 's' }],
    })
    expect(r.ok).toBe(false)
  })
})

describe('findCliConflicts', () => {
  const builtins = ['help', 'version', 'plugin']

  function m(id: string, cli: PluginManifest['cli']): PluginManifest {
    return {
      id, name: id, version: '0.1.0', binary: 'bin',
      host_capabilities: [], cli,
    } as PluginManifest
  }

  it('returns empty when no conflicts', () => {
    const conflicts = findCliConflicts([
      m('a', [{ subcommand: 'one', command: 'x', summary: 's' }]),
      m('b', [{ subcommand: 'two', command: 'x', summary: 's' }]),
    ], builtins)
    expect(conflicts).toEqual([])
  })

  it('detects duplicate subcommand across plugins', () => {
    const conflicts = findCliConflicts([
      m('a', [{ subcommand: 'dup', command: 'x', summary: 's' }]),
      m('b', [{ subcommand: 'dup', command: 'x', summary: 's' }]),
    ], builtins)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].kind).toBe('subcommand')
    expect(conflicts[0].owners.map(o => o.pluginId).sort()).toEqual(['a', 'b'])
  })

  it('detects duplicate alias across plugins', () => {
    const conflicts = findCliConflicts([
      m('a', [{ subcommand: 'one', aliases: ['-x'], command: 'x', summary: 's' }]),
      m('b', [{ subcommand: 'two', aliases: ['-x'], command: 'x', summary: 's' }]),
    ], builtins)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].kind).toBe('alias')
    expect(conflicts[0].key).toBe('-x')
  })

  it('detects subcommand colliding with builtin even at registry level', () => {
    const conflicts = findCliConflicts([
      m('a', [{ subcommand: 'help', command: 'x', summary: 's' }]),
    ], builtins)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].kind).toBe('subcommand')
    expect(conflicts[0].reservedCore).toBe(true)
  })
})

describe('buildRegistry drops cli entries from conflicting plugins', () => {
  it('keeps the non-conflicting plugin intact when subcommand dup occurs', () => {
    const a = {
      id: 'a', name: 'A', version: '0.1.0', binary: 'bin',
      host_capabilities: [], cli: [{ subcommand: 'dup', command: 'x', summary: 's' }],
    } as PluginManifest
    const b = {
      id: 'b', name: 'B', version: '0.1.0', binary: 'bin',
      host_capabilities: [],
      menus: [{ location: 'file' as const, label: 'B', command: 'x' }],
      cli: [{ subcommand: 'dup', command: 'x', summary: 's' }],
    } as PluginManifest
    const reg = buildRegistry([a, b])
    expect(Object.keys(reg.byId).sort()).toEqual(['a', 'b'])
  })
})
