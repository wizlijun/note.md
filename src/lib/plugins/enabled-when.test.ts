import { describe, it, expect } from 'vitest'
import { evaluateEnabledWhen, parseEnabledWhen } from './enabled-when'
import type { EnabledWhenContext } from './types'

const ctx = (over: Partial<EnabledWhenContext> = {}): EnabledWhenContext => ({
  currentTab: {
    path: '/foo.md', filename: 'foo.md', extension: 'md',
    hasContent: true, isDirty: false, isUntitled: false,
  },
  settings: {},
  ...over,
})

describe('parseEnabledWhen', () => {
  it('parses bare paths', () => {
    expect(() => parseEnabledWhen('currentTab.hasContent')).not.toThrow()
  })
  it('parses negation', () => {
    expect(() => parseEnabledWhen('!currentTab.isDirty')).not.toThrow()
  })
  it('parses && and ||', () => {
    expect(() => parseEnabledWhen('currentTab.hasContent && !currentTab.isDirty')).not.toThrow()
  })
  it('parses parens', () => {
    expect(() => parseEnabledWhen('(a || b) && c')).not.toThrow()
  })
  it('parses bracket index', () => {
    expect(() => parseEnabledWhen('settings["share.records"]')).not.toThrow()
  })
  it('throws on unmatched paren', () => {
    expect(() => parseEnabledWhen('(a && b')).toThrow()
  })
  it('throws on trailing operator', () => {
    expect(() => parseEnabledWhen('a &&')).toThrow()
  })
  it('rejects double negation per grammar (! applies to atom only)', () => {
    expect(() => parseEnabledWhen('!!a')).toThrow()
  })
  it('allows ! applied to a parenthesized expr (an atom)', () => {
    // !(...)  is OK because the parens make the inner an atom.
    expect(() => parseEnabledWhen('!(a && b)')).not.toThrow()
  })
  it('parses computed bracket index (multi-segment path)', () => {
    expect(() => parseEnabledWhen('settings["share.records"][currentTab.path]')).not.toThrow()
  })
  it('parses chained computed indices', () => {
    expect(() => parseEnabledWhen('a[b.c][d.e]')).not.toThrow()
  })
})

describe('evaluateEnabledWhen', () => {
  it('evaluates true literal', () => {
    expect(evaluateEnabledWhen('true', ctx())).toBe(true)
  })
  it('evaluates false literal', () => {
    expect(evaluateEnabledWhen('false', ctx())).toBe(false)
  })
  it('reads boolean fields', () => {
    expect(evaluateEnabledWhen('currentTab.hasContent', ctx())).toBe(true)
    expect(evaluateEnabledWhen('currentTab.isDirty', ctx())).toBe(false)
  })
  it('returns false for missing path', () => {
    expect(evaluateEnabledWhen('currentTab.nonexistent', ctx())).toBe(false)
    expect(evaluateEnabledWhen('foo.bar.baz', ctx())).toBe(false)
  })
  it('returns false when currentTab is null', () => {
    expect(evaluateEnabledWhen('currentTab.hasContent', ctx({ currentTab: null }))).toBe(false)
  })
  it('treats non-empty string as truthy, empty as falsy', () => {
    expect(evaluateEnabledWhen('currentTab.filename', ctx())).toBe(true)
    expect(evaluateEnabledWhen('currentTab.filename',
      ctx({ currentTab: { ...ctx().currentTab!, filename: '' } }))).toBe(false)
  })
  it('treats non-empty object/array as truthy', () => {
    const settings = { 'share.records': { '/foo.md': { slug: 'x' } } }
    expect(evaluateEnabledWhen('settings["share.records"]', ctx({ settings }))).toBe(true)
    expect(evaluateEnabledWhen('settings["share.records"]',
      ctx({ settings: { 'share.records': {} } }))).toBe(false)
  })
  it('handles unary !', () => {
    expect(evaluateEnabledWhen('!currentTab.isDirty', ctx())).toBe(true)
    expect(evaluateEnabledWhen('!currentTab.hasContent', ctx())).toBe(false)
  })
  it('handles && short-circuit', () => {
    expect(evaluateEnabledWhen('currentTab.hasContent && !currentTab.isDirty', ctx())).toBe(true)
    expect(evaluateEnabledWhen('currentTab.isDirty && currentTab.hasContent', ctx())).toBe(false)
  })
  it('handles || short-circuit', () => {
    expect(evaluateEnabledWhen('currentTab.isDirty || currentTab.hasContent', ctx())).toBe(true)
    expect(evaluateEnabledWhen('currentTab.isDirty || currentTab.isUntitled', ctx())).toBe(false)
  })
  it('respects parens for precedence', () => {
    // a || b && c → a || (b && c) by JS precedence; we replicate that.
    // (a || b) && c forces grouping.
    const c = ctx({
      currentTab: { ...ctx().currentTab!, isDirty: true, isUntitled: false, hasContent: false },
    })
    expect(evaluateEnabledWhen('currentTab.isDirty || currentTab.hasContent && currentTab.isUntitled', c))
      .toBe(true)
    expect(evaluateEnabledWhen('(currentTab.isDirty || currentTab.hasContent) && currentTab.isUntitled', c))
      .toBe(false)
  })
  it('uses inner-path value as the lookup key', () => {
    const settings = { 'share.records': { '/foo.md': { slug: 'x' } } }
    const c = ctx({
      currentTab: {
        path: '/foo.md', filename: 'foo.md', extension: 'md',
        hasContent: true, isDirty: false, isUntitled: false,
      },
      settings,
    })
    expect(evaluateEnabledWhen('settings["share.records"][currentTab.path]', c)).toBe(true)
  })
  it('returns false when computed key is not present in container', () => {
    const settings = { 'share.records': { '/other.md': { slug: 'x' } } }
    const c = ctx({
      currentTab: {
        path: '/foo.md', filename: 'foo.md', extension: 'md',
        hasContent: true, isDirty: false, isUntitled: false,
      },
      settings,
    })
    expect(evaluateEnabledWhen('settings["share.records"][currentTab.path]', c)).toBe(false)
  })
  it('returns false when inner path resolves to undefined', () => {
    const c = ctx({ currentTab: null, settings: { 'share.records': { 'x': 1 } } })
    expect(evaluateEnabledWhen('settings["share.records"][currentTab.path]', c)).toBe(false)
  })
})
