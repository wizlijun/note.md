import { expect, it } from 'vitest'
import { sha256Hex, sha256Sync } from './hash'

it('matches the known SHA-256 vector', async () => {
  expect(sha256Sync('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(await sha256Hex('abc')).toBe(sha256Sync('abc'))
})

it('matches Web Crypto for UTF-8 and padding boundaries', async () => {
  for (const text of ['', '中文', '😀𝄞', '\uD800', '\uDC00', ...[55, 56, 63, 64, 65, 127, 128, 129, 100_000].map(n => 'a'.repeat(n))]) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    const expected = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    expect(sha256Sync(text)).toBe(expected)
    expect(await sha256Hex(text)).toBe(expected)
  }
})
