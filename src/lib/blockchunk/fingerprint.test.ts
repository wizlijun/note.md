import { describe, it, expect } from 'vitest'
import {
  normalizeText,
  computeFingerprint,
  jaccard,
  coverage,
  serializeMinHash,
  parseMinHash,
  MINHASH_K,
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
  it('returns identical fingerprints for identical text', async () => {
    const a = await computeFingerprint('hello world')
    const b = await computeFingerprint('hello world')
    expect(a.hash).toBe(b.hash)
    expect(a.length).toBe(b.length)
    expect(a.minhash).toEqual(b.minhash)
  })

  it('returns identical fingerprints for whitespace/case-equivalent text', async () => {
    const a = await computeFingerprint('  Hello   World ')
    const b = await computeFingerprint('hello world')
    expect(a.hash).toBe(b.hash)
    expect(a.minhash).toEqual(b.minhash)
  })

  it('hash is 12 hex chars', async () => {
    const fp = await computeFingerprint('anything')
    expect(fp.hash).toMatch(/^[0-9a-f]{12}$/)
  })

  it('minhash signature has length MINHASH_K', async () => {
    const fp = await computeFingerprint('a longer paragraph of text used to fill a shingle window')
    expect(fp.minhash.length).toBe(MINHASH_K)
  })

  it('length is normalized character count', async () => {
    const fp = await computeFingerprint('  hi  ')
    expect(fp.length).toBe(2)
  })
})

describe('jaccard via MinHash', () => {
  it('returns 1.0 for identical fingerprints', async () => {
    const a = await computeFingerprint('the quick brown fox jumps over the lazy dog')
    const b = await computeFingerprint('the quick brown fox jumps over the lazy dog')
    expect(jaccard(a, b)).toBeCloseTo(1.0, 5)
  })

  it('returns near 0 for fully disjoint texts', async () => {
    const a = await computeFingerprint('aaaaaaaaaaaaaaaaaaaaaaaa')
    const b = await computeFingerprint('zzzzzzzzzzzzzzzzzzzzzzzz')
    expect(jaccard(a, b)).toBeLessThan(0.1)
  })

  it('returns a partial value for partial overlap (single-token edit in long text)', async () => {
    const a = await computeFingerprint('the quick brown fox jumps over the lazy dog and runs through the meadow')
    const b = await computeFingerprint('the quick brown fox jumps over the busy dog and runs through the meadow')
    const sim = jaccard(a, b)
    // MinHash approximation: with k=32 and a single-token swap in a long
    // sentence, expect similarity well above the 0.5 merge threshold.
    expect(sim).toBeGreaterThan(0.5)
    expect(sim).toBeLessThan(1.0)
  })

  it('returns 0 when one side has no content', async () => {
    const a = await computeFingerprint('')
    const b = await computeFingerprint('the quick brown fox')
    expect(jaccard(a, b)).toBe(0)
  })

  it('returns 1 when both sides are empty', async () => {
    const a = await computeFingerprint('')
    const b = await computeFingerprint('')
    expect(jaccard(a, b)).toBe(1)
  })
})

describe('coverage', () => {
  it('returns ~1 when small is fully contained in big', async () => {
    const small = await computeFingerprint('the quick brown fox jumps over the lazy dog')
    const big = await computeFingerprint(
      'the quick brown fox jumps over the lazy dog. ' +
      'a stitch in time saves nine when no one is looking.',
    )
    expect(coverage(small, big)).toBeGreaterThan(0.5)
  })

  it('returns 0 when small is empty', async () => {
    const small = await computeFingerprint('')
    const big = await computeFingerprint('any non-empty text here as filler')
    expect(coverage(small, big)).toBe(0)
  })
})

describe('serialize/parse MinHash', () => {
  it('round-trips a signature exactly', async () => {
    const fp = await computeFingerprint('the quick brown fox jumps over the lazy dog')
    const s = serializeMinHash(fp.minhash)
    expect(s.length).toBe(MINHASH_K * 8)
    expect(s).toMatch(/^[0-9a-f]+$/)
    const decoded = parseMinHash(s)
    expect(decoded).toEqual(fp.minhash)
  })

  it('parseMinHash returns a "no-content" signature on malformed input', () => {
    const decoded = parseMinHash('not-hex')
    expect(decoded.length).toBe(MINHASH_K)
  })
})
