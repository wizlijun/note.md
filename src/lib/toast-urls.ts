export type TextSegment = { kind: 'text'; value: string }
export type UrlSegment = { kind: 'url'; value: string }
export type Segment = TextSegment | UrlSegment

const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g
const TRAILING_PUNCT_RE = /[)\]，。；：！？,.;:!?>'"」』]+$/

/**
 * Split a string into a sequence of text/url segments. URLs are detected by
 * the simple `https?://[^\s]+` rule; trailing punctuation (CJK and ASCII)
 * is shaved off the URL and pushed back into the following text segment so
 * URLs like `https://example.com，` don't drag the comma into the link.
 */
export function splitUrls(text: string): Segment[] {
  if (!text) return []
  const out: Segment[] = []
  let last = 0
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text)) !== null) {
    let url = m[0]
    const start = m.index
    let end = start + url.length
    const trailMatch = url.match(TRAILING_PUNCT_RE)
    if (trailMatch) {
      const trailLen = trailMatch[0].length
      url = url.slice(0, -trailLen)
      end -= trailLen
      URL_RE.lastIndex = end
    }
    if (start > last) out.push({ kind: 'text', value: text.slice(last, start) })
    out.push({ kind: 'url', value: url })
    last = end
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) })
  return out
}
