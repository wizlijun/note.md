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
    expect(await sha256Hex('多字节テスト🥑')).toBe(
      'fedc62a37fc474a492a8a158758c555d6709b21a5176109825795f5803bdcf36',
    )
    // (regenerate with: printf '多字节テスト🥑' | shasum -a 256)
  })
})
