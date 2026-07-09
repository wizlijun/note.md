// src/lib/outline/shortcuts.test.ts
import { describe, it, expect } from 'vitest'
import {
  normalizeShortcut, displayShortcut, eventToShortcut,
  DEFAULT_SHORTCUTS, resolveShortcuts, findConflict,
} from './shortcuts'

describe('normalizeShortcut (shortcuts.cljs:51)', () => {
  it('canonical order Mod>Alt>Shift, upper-cases single keys', () => {
    expect(normalizeShortcut('shift+cmd+o')).toBe('Mod+Shift+O')
    expect(normalizeShortcut('Ctrl + b')).toBe('Mod+B')
    expect(normalizeShortcut('option+ArrowUp')).toBe('Alt+ArrowUp')
  })
  it('null without a main key', () => {
    expect(normalizeShortcut('cmd+shift')).toBeNull()
    expect(normalizeShortcut('')).toBeNull()
  })
})

describe('displayShortcut (shortcuts.cljs:76)', () => {
  it('mac symbols, no separator', () => {
    expect(displayShortcut('Mod+Shift+O', true)).toBe('⌘⇧O')
    expect(displayShortcut('Alt+ArrowUp', true)).toBe('⌥↑')
  })
  it('win names with separator', () => {
    expect(displayShortcut('Mod+Shift+O', false)).toBe('Ctrl + Shift + O')
  })
})

describe('eventToShortcut (shortcuts.cljs:99)', () => {
  const ev = (o: Partial<KeyboardEvent>) => o as KeyboardEvent
  it('builds from modifiers + key', () => {
    expect(eventToShortcut(ev({ key: 'o', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false }))).toBe('Mod+Shift+O')
    expect(eventToShortcut(ev({ key: 'Tab', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false }))).toBe('Shift+Tab')
  })
  it('bare modifier key → null', () => {
    expect(eventToShortcut(ev({ key: 'Meta', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }))).toBeNull()
  })
})

describe('resolve + conflicts', () => {
  it('user overrides beat defaults', () => {
    const r = resolveShortcuts({ 'outline.indent': 'Mod+]' })
    expect(r['outline.indent']).toBe('Mod+]')
    expect(r['outline.outdent']).toBe(DEFAULT_SHORTCUTS['outline.outdent'])
  })
  it('findConflict detects duplicate binding', () => {
    const r = resolveShortcuts({ 'outline.indent': DEFAULT_SHORTCUTS['outline.outdent'] })
    expect(findConflict(r, 'outline.indent')).toBe('outline.outdent')
    expect(findConflict(resolveShortcuts({}), 'outline.indent')).toBeNull()
  })
})
