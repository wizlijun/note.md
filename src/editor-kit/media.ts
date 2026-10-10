// Bridge-backed MediaResolver for the Editor Kit.
//
// The kit runs inside an *isolated* plugin webview: no Tauri IPC, no
// `@tauri-apps/plugin-fs`. Local files are read through the plugin host bridge
// (`window.notemd.request('host.vault.read_bytes')`), which returns base64 and
// is gated by the `vault.read` capability + path containment on the Rust side.
//
// Structure mirrors `src/lib/adapters/tauri-media-resolver.ts` (blob cache +
// extension→MIME tables + empty string on failure); only the byte source
// differs. Keep the two in sync when either changes.

import type { LocalMediaSource, MediaResolver } from '@moraya/core'
import { basename, relative } from '../lib/paths'
import { localResourceCandidates } from '../lib/local-resource'

const blobCache = new Map<string, string>()

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
  ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
}

const MEDIA_MIME: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', ogv: 'video/ogg',
  mov: 'video/quicktime', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
  m4a: 'audio/mp4', oga: 'audio/ogg', opus: 'audio/opus', weba: 'audio/webm',
}

interface Bridge {
  request(method: string, params?: unknown): Promise<Record<string, unknown>>
}

function bridge(): Bridge | null {
  const b = (window as unknown as { notemd?: Bridge }).notemd
  return b && typeof b.request === 'function' ? b : null
}

function pathExt(path: string): string {
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

function buildBlob(bytes: Uint8Array, mime: string): string {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime })
  return URL.createObjectURL(blob)
}

function decodeBase64(base64: string): Uint8Array {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * Absolute path → vault-relative path, or `null` when the file lives outside
 * the vault (the bridge only serves vault-internal paths).
 *
 * moraya hands the resolver *absolute* paths: relative image sources in the
 * document are joined against the base dir set via `setDocumentBaseDir()`.
 */
export function toVaultRelative(vaultRoot: string, absolutePath: string): string | null {
  if (!vaultRoot) return null
  const rel = relative(vaultRoot, absolutePath)
  return rel && !rel.split('/').includes('..') ? rel : null
}

/** Ask the host for the vault root; empty string when unset or unavailable. */
export async function loadVaultRoot(): Promise<string> {
  const b = bridge()
  if (!b) return ''
  try {
    const info = await b.request('host.vault.info', {})
    const root = info?.root
    return typeof root === 'string' ? root : ''
  } catch {
    return ''
  }
}

/**
 * A `MediaResolver` (see `@moraya/core` `src/types.ts`) that serves vault files
 * through the plugin bridge. Anything the bridge cannot serve resolves to an
 * empty string — the same failure behaviour as the desktop Tauri resolver, so
 * the `<img>` simply renders broken instead of throwing inside a NodeView.
 */
export function bridgeMediaResolver(vaultRoot: string, baseDir?: string): MediaResolver {
  async function load(absolutePath: string, source: LocalMediaSource | undefined, mimes: Record<string, string>, fallbackMime: string): Promise<string> {
    const b = bridge()
    if (!b) return ''
    const candidates = source
      ? localResourceCandidates(source.src, { vaultRoot, baseDir: baseDir ?? source.baseDir })
      : [absolutePath]
    for (const path of candidates) {
      // Check containment BEFORE the cache. A cached file from a previous vault
      // must not bypass this resolver's permissions; Rust checks symlinks too.
      const rel = toVaultRelative(vaultRoot, path)
      if (!rel) continue
      const cached = blobCache.get(path)
      if (cached) return cached
      try {
        const res = await b.request('host.vault.read_bytes', { path: rel })
        const base64 = res?.base64
        if (typeof base64 !== 'string') continue
        const url = buildBlob(decodeBase64(base64), mimes[pathExt(path)] || fallbackMime)
        blobCache.set(path, url)
        return url
      } catch { /* Only vault-contained fallback candidates may be tried. */ }
    }
    return ''
  }

  return {
    loadLocalImage: (absolutePath, source) => load(absolutePath, source, IMAGE_MIME, 'image/png'),
    loadLocalMedia: (absolutePath, source) => load(absolutePath, source, MEDIA_MIME, 'application/octet-stream'),
    // No plugin-http in a plugin webview either; hand the URL back and let the
    // WebView fetch it (subject to the window's CSP).
    loadRemoteMedia: async (url) => url,
  }
}
