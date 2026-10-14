import type { GuestLink } from './types'
const slugPattern = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?$/
/** Pure confirmation input: never fetch a title or invoke native download here. */
export function parseGuestLink(value: string, dev: boolean): GuestLink {
  try {
    let raw = value.trim()
    let url = new URL(raw)
    if (url.protocol === 'notemd:') {
      if (url.hostname !== 'share' || url.pathname !== '/open' || url.username || url.password || url.port || url.hash
        || [...url.searchParams.keys()].some(key => key !== 'u') || url.searchParams.getAll('u').length !== 1) throw 0
      raw = url.searchParams.get('u')!
      url = new URL(raw)
    }
    // Check the literal authority too: URL canonicalization accepts numeric IPv4 aliases.
    const authority = /^https?:\/\/([^/\s?#]+)/i.exec(raw)?.[1]?.toLowerCase()
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(authority ?? '')
    if (url.username || url.password || url.search || /[\\\x00-\x20]/.test(raw)
      || (url.protocol !== 'https:' && !(dev && url.protocol === 'http:' && loopback))) throw 0
    const slug = url.pathname.slice(1)
    if (!slugPattern.test(slug)) throw 0
    const fragment = new URLSearchParams(url.hash.slice(1))
    if (fragment.getAll('feedback').length > 1) throw 0
    const token = fragment.get('feedback') || undefined
    return { origin: url.origin, slug, shareUrl: `${url.origin}/${slug}`, ...(token ? { token } : {}) }
  } catch { throw new Error('无效的分享链接') }
}
