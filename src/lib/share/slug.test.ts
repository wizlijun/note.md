import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateSlug, _stripToAsciiSlug, _startsWithIsoDate } from './slug'

const FIXED_DATE = '2026-05-09'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(`${FIXED_DATE}T12:00:00Z`))
})
afterEach(() => vi.useRealTimers())

const noSuffix = (s: string) => s.split('-').slice(0, -1).join('-')

describe('generateSlug', () => {
  it('ascii filename gets dated prefix', () => {
    const s = generateSlug('trip notes.md', '', true)
    expect(s).toMatch(/^2026-05-09-trip-notes-[A-Za-z0-9]{3}$/)
  })

  it('underscore and dot become dash', () => {
    expect(noSuffix(generateSlug('a_b.c.md', '', true))).toBe(`${FIXED_DATE}-a-b-c`)
  })

  it('collapses consecutive dashes', () => {
    expect(noSuffix(generateSlug('a   b___c.md', '', true))).toBe(`${FIXED_DATE}-a-b-c`)
  })

  it('pure non-ascii falls back to untitled-<hash>', () => {
    const s1 = noSuffix(generateSlug('会议纪要.md', 'hello world', true))
    const s2 = noSuffix(generateSlug('不同名字.md', 'hello world', true))
    expect(s1).toContain('-untitled-')
    const tail1 = s1.split('untitled-')[1]
    const tail2 = s2.split('untitled-')[1]
    expect(tail1).toBe(tail2)
    expect(tail1).toHaveLength(8)
  })

  it('truncates long filename to 40 chars', () => {
    const long = 'a'.repeat(200)
    const s = noSuffix(generateSlug(`${long}.md`, '', true))
    const filenamePart = s.slice(`${FIXED_DATE}-`.length)
    expect(filenamePart).toHaveLength(40)
  })

  it('does not double date-prefix when filename starts with YYYY-MM-DD', () => {
    const s = noSuffix(generateSlug('2024-01-15-meeting.md', '', true))
    expect(s.startsWith('2024-01-15-meeting')).toBe(true)
  })

  it('untitled filename uses content-hash fallback', () => {
    const s = noSuffix(generateSlug(null, 'any content', true))
    expect(s).toContain('-untitled-')
  })

  it('no suffix when disabled', () => {
    const s = generateSlug('foo.md', '', false)
    expect(s).toBe(`${FIXED_DATE}-foo`)
  })

  it('suffix is 3 chars from base62', () => {
    const s = generateSlug('foo.md', '', true)
    const suffix = s.split('-').pop()!
    expect(suffix).toHaveLength(3)
    expect(/^[A-Za-z0-9]{3}$/.test(suffix)).toBe(true)
  })
})

describe('_stripToAsciiSlug', () => {
  it('basic cases', () => {
    expect(_stripToAsciiSlug('Hello World')).toBe('hello-world')
    expect(_stripToAsciiSlug('a__b__c')).toBe('a-b-c')
    expect(_stripToAsciiSlug('---a---')).toBe('a')
    expect(_stripToAsciiSlug('')).toBe('')
    expect(_stripToAsciiSlug('中文')).toBe('')
  })
})

describe('_startsWithIsoDate', () => {
  it('recognizes YYYY-MM-DD- prefix', () => {
    expect(_startsWithIsoDate('2024-01-15-x')).toBe(true)
    expect(_startsWithIsoDate('2024-01-15')).toBe(false)
    expect(_startsWithIsoDate('hello')).toBe(false)
  })
})
