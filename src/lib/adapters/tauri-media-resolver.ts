import { readFile } from '@tauri-apps/plugin-fs'
import type { LocalMediaSource, MediaResolver } from '@moraya/core'
import { basename } from '../paths'
import { localResourceCandidates, type LocalResourceContext } from '../local-resource'

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

function pathExt(path: string): string {
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

function buildBlob(bytes: Uint8Array, mime: string): string {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime })
  return URL.createObjectURL(blob)
}

export class TauriMediaResolver implements MediaResolver {
  constructor(private readonly getContext: () => LocalResourceContext = () => ({})) {}

  private async load(
    absolutePath: string,
    source: LocalMediaSource | undefined,
    mimes: Record<string, string>,
    fallbackMime: string,
  ): Promise<string> {
    // Without source metadata this is already a filesystem path. Never decode
    // it again or reinterpret it as a root-relative Markdown URL.
    const candidates = source
      ? localResourceCandidates(source.src, { baseDir: source.baseDir, ...this.getContext() })
      : [absolutePath]
    for (const path of candidates) {
      const cached = blobCache.get(path)
      if (cached) return cached
      try {
        const bytes = await readFile(path)
        const url = buildBlob(bytes, mimes[pathExt(path)] || fallbackMime)
        blobCache.set(path, url)
        return url
      } catch { /* Try the full filesystem path if the vault candidate failed. */ }
    }
    return ''
  }

  loadLocalImage(absolutePath: string, source?: LocalMediaSource): Promise<string> {
    return this.load(absolutePath, source, IMAGE_MIME, 'image/png')
  }

  loadLocalMedia(absolutePath: string, source?: LocalMediaSource): Promise<string> {
    return this.load(absolutePath, source, MEDIA_MIME, 'application/octet-stream')
  }

  async loadRemoteMedia(url: string): Promise<string> {
    // mdeditor has no plugin-http; return URL unchanged and let WKWebView handle it.
    // Remote http:// images may fail due to WKWebView mixed-content restrictions.
    return url
  }
}

export const tauriMediaResolver = new TauriMediaResolver()
