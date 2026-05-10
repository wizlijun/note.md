import { describe, it, expect } from 'vitest'
import {
  normalizeText,
  computeFingerprint,
  jaccard,
} from './fingerprint'

describe('normalizeText', () => {
  it('lowercases', () => {
    expect(normalizeText('Hello')).toBe('hello')
  })

  it('collapses runs of whitespace to single space', () => {
    expect(normalizeText('a    b\t\tc')).toBe('a b c')
  })

  it('trims edges', () => {
    expect(normalizeText('  hi  ')).toBe('hi')
  })

  it('preserves structural markers (#, -, >)', () => {
    expect(normalizeText('# Heading')).toBe('# heading')
    expect(normalizeText('- item')).toBe('- item')
    expect(normalizeText('> quote')).toBe('> quote')
  })

  it('treats CRLF and LF the same', () => {
    expect(normalizeText('a\r\nb')).toBe(normalizeText('a\nb'))
  })
})

describe('computeFingerprint', () => {
  it('returns identical hash for identical text', async () => {
    const a = await computeFingerprint('hello world')
    const b = await computeFingerprint('hello world')
    expect(a.hash).toBe(b.hash)
    expect(a.length).toBe(b.length)
    expect(a.shingles).toBe(b.shingles)
  })

  it('returns identical hash for whitespace/case-equivalent text', async () => {
    const a = await computeFingerprint('  Hello   World ')
    const b = await computeFingerprint('hello world')
    expect(a.hash).toBe(b.hash)
  })

  it('hash is 12 hex chars', async () => {
    const fp = await computeFingerprint('anything')
    expect(fp.hash).toMatch(/^[0-9a-f]{12}$/)
  })

  it('length is normalized character count', async () => {
    const fp = await computeFingerprint('  hi  ')
    expect(fp.length).toBe(2)
  })
})

describe('jaccard', () => {
  it('returns 1.0 for identical fingerprints', async () => {
    const a = await computeFingerprint('the quick brown fox jumps over the lazy dog')
    const b = await computeFingerprint('the quick brown fox jumps over the lazy dog')
    expect(jaccard(a, b)).toBeCloseTo(1.0, 5)
  })

  it('returns 0.0 for fully disjoint fingerprints', async () => {
    const a = await computeFingerprint('aaaaaaaaaaaaaaaaa')
    const b = await computeFingerprint('zzzzzzzzzzzzzzzzz')
    expect(jaccard(a, b)).toBeCloseTo(0.0, 5)
  })

  it('returns a value between 0 and 1 for partial overlap', async () => {
    const a = await computeFingerprint('the quick brown fox jumps over the lazy dog')
    const b = await computeFingerprint('the quick brown fox runs over the busy dog')
    const sim = jaccard(a, b)
    expect(sim).toBeGreaterThan(0.3)
    expect(sim).toBeLessThan(1.0)
  })
})
