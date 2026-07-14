// src/lib/wikilink/blocklist.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import {
  DEFAULT_BLOCKED_WIKILINKS, normalizeWikilinkTarget, parseBlocklistFile,
  setBlockedWikilinks, isBlockedWikilink,
} from './blocklist'

afterEach(() => setBlockedWikilinks([]))  // 复位模块级 Set，避免污染

describe('normalizeWikilinkTarget', () => {
  it('strips |alias and #heading, trims, lowercases', () => {
    expect(normalizeWikilinkTarget('  Foo|Bar ')).toBe('foo')
    expect(normalizeWikilinkTarget('Foo#Sec')).toBe('foo')
    expect(normalizeWikilinkTarget('WIKILINK')).toBe('wikilink')
    expect(normalizeWikilinkTarget('  ')).toBe('')
  })
})

describe('parseBlocklistFile', () => {
  it('skips front-matter / blank / headings, strips list markers', () => {
    const md = '---\ntitle: x\n---\n# 清单\n- wikilink\n* 链接\n\n  双链\n'
    expect(parseBlocklistFile(md)).toEqual(['wikilink', '链接', '双链'])
  })
  it('empty input → []', () => {
    expect(parseBlocklistFile('')).toEqual([])
  })
})

describe('isBlockedWikilink / setBlockedWikilinks', () => {
  it('default (unset) blocks nothing', () => {
    expect(isBlockedWikilink('wikilink')).toBe(false)
  })
  it('blocks case-insensitively, alias/heading-insensitively after set', () => {
    setBlockedWikilinks(DEFAULT_BLOCKED_WIKILINKS)
    expect(isBlockedWikilink('wikilink')).toBe(true)
    expect(isBlockedWikilink('WikiLink')).toBe(true)
    expect(isBlockedWikilink('wikilink|别名')).toBe(true)
    expect(isBlockedWikilink('链接#节')).toBe(true)
    expect(isBlockedWikilink('双链')).toBe(true)
    expect(isBlockedWikilink('wikilink2')).toBe(false)
    expect(isBlockedWikilink('my wikilink')).toBe(false)
  })
  it('re-setting replaces the previous set', () => {
    setBlockedWikilinks(['a'])
    setBlockedWikilinks(['b'])
    expect(isBlockedWikilink('a')).toBe(false)
    expect(isBlockedWikilink('b')).toBe(true)
  })
  it('DEFAULT_BLOCKED_WIKILINKS is the seed list', () => {
    expect(DEFAULT_BLOCKED_WIKILINKS).toEqual(['wikilink', '链接', '双链'])
  })
})
