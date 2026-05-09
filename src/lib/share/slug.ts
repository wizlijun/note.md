const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * Slug generator matching the macOS Rust implementation in `mdshare/src/slug.rs`.
 * Format: YYYY-MM-DD-<filename-slug>[-<3-char base62 suffix>]
 */
export function generateSlug(filename: string | null, content: string, withSuffix: boolean): string {
  const date = isoDate(new Date())

  const base = filename
    ? (filename.includes('.') && filename.lastIndexOf('.') > 0
        ? filename.slice(0, filename.lastIndexOf('.'))
        : filename)
    : ''

  const stripped = _stripToAsciiSlug(base)
  let truncated = stripped.slice(0, 40)
  while (truncated.endsWith('-')) truncated = truncated.slice(0, -1)

  let filenamePart: string
  if (truncated.length === 0) {
    filenamePart = `untitled-${_contentHashHex8(content)}`
  } else if (_startsWithIsoDate(truncated)) {
    filenamePart = truncated
  } else {
    filenamePart = `${date}-${truncated}`
  }

  let finalPart: string
  if (filenamePart.startsWith(date)) {
    finalPart = filenamePart
  } else if (_startsWithIsoDate(filenamePart)) {
    finalPart = filenamePart
  } else {
    finalPart = `${date}-${filenamePart}`
  }

  return withSuffix ? `${finalPart}-${_randomBase62(3)}` : finalPart
}

export function _stripToAsciiSlug(input: string): string {
  let out = ''
  let lastDash = false
  for (const c of input) {
    let mapped: string | null = null
    if (/[a-zA-Z0-9]/.test(c)) {
      mapped = c.toLowerCase()
    } else if (c === ' ' || c === '_' || c === '.' || c === '-') {
      mapped = '-'
    }
    if (mapped === null) continue
    if (mapped === '-') {
      if (!lastDash && out.length > 0) {
        out += '-'
        lastDash = true
      }
    } else {
      out += mapped
      lastDash = false
    }
  }
  while (out.endsWith('-')) out = out.slice(0, -1)
  return out
}

export function _startsWithIsoDate(s: string): boolean {
  if (s.length < 11) return false
  return /^\d{4}-\d{2}-\d{2}-/.test(s)
}

function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function _randomBase62(n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) {
    s += BASE62[Math.floor(Math.random() * BASE62.length)]
  }
  return s
}

/** FNV-1a 64-bit hash, first 8 hex chars. Matches Rust `content_hash_hex8`. */
export function _contentHashHex8(content: string): string {
  const MASK = 0xffffffffffffffffn
  const PRIME = 0x100000001b3n
  let hash = 0xcbf29ce484222325n
  const bytes = new TextEncoder().encode(content)
  for (const b of bytes) {
    hash = (hash ^ BigInt(b)) & MASK
    hash = (hash * PRIME) & MASK
  }
  return hash.toString(16).padStart(16, '0').slice(0, 8)
}
