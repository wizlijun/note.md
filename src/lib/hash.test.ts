import { describe, it, expect } from 'vitest'
import { sha256Hex } from './hash'

describe('sha256Hex', () => {
  it('returns the canonical SHA-256 hex of empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('returns the canonical SHA-256 hex of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('handles utf-8 multi-byte input', async () => {
    expect(await sha256Hex('M↓')).toBe(
      '1319582a7b66abeff20c0164ff0d1d68f3bc9bbb86acf92167091e4addf93550',
    )
    // (regenerate with: echo -n 'M↓' | shasum -a 256)
  })
})
