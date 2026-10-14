import { describe, expect, it, vi } from 'vitest'
import { parseGuestLink } from './link'
const slug = '2026-10-14-example-Ab9'
describe('guest confirmation link boundary', () => {
  it('extracts only feedback and strips all fragments without network', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    try {
      expect(parseGuestLink(`https://Share.Example/${slug}#feedback=SECRET&x=ignored`, false)).toEqual({ origin: 'https://share.example', slug, shareUrl: `https://share.example/${slug}`, token: 'SECRET' })
      expect(parseGuestLink(`https://share.example/${slug}#token=SECRET`, false).token).toBeUndefined()
      expect(fetch).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })
  it('unwraps precisely the desktop share deep link', () => {
    const url = `https://share.example/${slug}#feedback=SECRET`
    expect(parseGuestLink(`notemd://share/open?u=${encodeURIComponent(url)}`, false)).toEqual(parseGuestLink(url, false))
  })
  it('rejects credentials, foreign protocols, query and malformed paths without echoing secrets', () => {
    for (const value of [`https://SECRET@share.example/${slug}`, `https://u:SECRET@share.example/${slug}`, `http://share.example/${slug}#feedback=SECRET`, `file:///SECRET`, `https://share.example/${slug}?feedback=SECRET`, `https://share.example/bad/SECRET`, `notemd://share/open?u=SECRET&u=SECRET`, 'SECRET']) {
      try { parseGuestLink(value, false); throw new Error('unexpected acceptance') } catch (error) { expect(String(error)).not.toContain('SECRET'); expect(String(error)).not.toContain('unexpected acceptance') }
    }
  })
  it('permits HTTP only on exact development loopback hosts', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(parseGuestLink(`http://${host}:8787/${slug}`, true).origin).toBe(`http://${host}:8787`)
      expect(() => parseGuestLink(`http://${host}/${slug}`, false)).toThrow()
    }
    for (const host of ['localhost.evil', '127.1', '2130706433']) expect(() => parseGuestLink(`http://${host}/${slug}`, true)).toThrow()
  })
})
