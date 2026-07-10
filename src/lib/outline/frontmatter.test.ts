// src/lib/outline/frontmatter.test.ts
import { describe, it, expect } from 'vitest'
import { touchFrontmatter, fmHas } from './frontmatter'

const NOW = '2026-07-10T09:00:00.000Z'

describe('touchFrontmatter', () => {
  it('builds full front-matter from null', () => {
    const out = touchFrontmatter(null, { title: '我的笔记', now: NOW })
    expect(out).toContain('title: 我的笔记')
    expect(out).toContain(`created: ${NOW}`)
    expect(out).toContain(`updated: ${NOW}`)
  })
  it('keeps existing title/created, refreshes updated, preserves unknown keys', () => {
    const raw = 'title: 旧标题\ncreated: 2020-01-01T00:00:00.000Z\nupdated: 2020-01-02T00:00:00.000Z\nroam-uid: abc'
    const out = touchFrontmatter(raw, { title: '新标题', now: NOW })
    expect(out).toContain('title: 旧标题')
    expect(out).toContain('created: 2020-01-01T00:00:00.000Z')
    expect(out).toContain(`updated: ${NOW}`)
    expect(out).toContain('roam-uid: abc')
    expect(out).toBe(`title: 旧标题\ncreated: 2020-01-01T00:00:00.000Z\nupdated: ${NOW}\nroam-uid: abc`)
  })
  it('uses provided created fallback when missing', () => {
    const out = touchFrontmatter('title: t', { title: 't', created: '2019-05-05T00:00:00.000Z', now: NOW })
    expect(out).toContain('created: 2019-05-05T00:00:00.000Z')
  })
  it('appends missing keys at end, preserving existing key order', () => {
    const out = touchFrontmatter('roam-uid: abc', { title: 'T', now: NOW })
    expect(out).toBe(`roam-uid: abc\ntitle: T\ncreated: ${NOW}\nupdated: ${NOW}`)
  })
  it('leaves non-mapping front-matter untouched (conservative)', () => {
    const raw = 'just some prose'
    expect(touchFrontmatter(raw, { title: 't', now: NOW })).toBe(raw)
  })
})

describe('fmHas', () => {
  it('detects top-level keys', () => {
    expect(fmHas('title: x\ncreated: y', 'created')).toBe(true)
    expect(fmHas('title: x', 'created')).toBe(false)
    expect(fmHas(null, 'title')).toBe(false)
  })
})
