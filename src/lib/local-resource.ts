import { isAbsolute, normalize, pathRoot } from './paths'

export interface LocalResourceContext {
  /** Filesystem directory, not a URL: never percent-decode this value. */
  baseDir?: string
  vaultRoot?: string | null
}

function collapsePath(path: string): string {
  const normalized = normalize(path)
  const root = pathRoot(normalized)
  const segments: string[] = []
  for (const part of normalized.slice(root.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return root + segments.join('/')
}

/**
 * Markdown/HTML URL → ordered local file candidates. A leading `/` names the
 * vault root first, the filesystem root second. Explicit file URLs and drive
 * paths bypass that convention. Relative URLs belong to the document directory.
 * Only the URL path is decoded; callers must not pass an already-decoded path.
 */
export function localResourceCandidates(src: string, context: LocalResourceContext = {}): string[] {
  const raw = src.trim()
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) return []
  const fileUrl = /^file:\/\//i.test(raw)
  const drivePath = /^[a-z]:[/\\]/i.test(raw)
  if (!fileUrl && !drivePath && /^[a-z][a-z0-9+.-]*:/i.test(raw)) return []

  let path = raw.split(/[?#]/, 1)[0]
  if (fileUrl) {
    const match = /^file:\/\/([^/]*)(\/.*)$/i.exec(path)
    if (!match) return []
    const [, host, pathname] = match
    path = host && host.toLowerCase() !== 'localhost' ? `//${host}${pathname}` : pathname
    // file:///C:/... is a Windows drive URL, not a POSIX /C:/... filename.
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1)
  }
  try { path = decodeURIComponent(path) } catch { /* Literal/malformed percent escapes remain usable. */ }
  if (!path || path.includes('\0')) return []

  if (fileUrl || drivePath) return [collapsePath(path)]
  if (path.startsWith('/')) {
    // Collapse before joining: `/../../x` means `/x` within the logical root.
    const absolute = collapsePath('/' + path.replace(/^\/+/, ''))
    const root = context.vaultRoot
    return [...new Set(root
      ? [collapsePath(normalize(root).replace(/\/+$/, '') + absolute), absolute]
      : [absolute])]
  }
  if (!context.baseDir || !isAbsolute(context.baseDir)) return []
  return [collapsePath(`${normalize(context.baseDir).replace(/\/+$/, '')}/${path}`)]
}
