import { parseIndex } from './parser'
import type { IndexDocument } from './model'

interface HostBridge {
  locale: string
  request(method: string, params?: unknown): Promise<any>
}

function host(): HostBridge {
  const value = (window as Window & { notemd?: HostBridge }).notemd
  if (!value) throw new Error('Index Viewer host bridge is unavailable')
  return value
}

export function locale(): string { return host().locale }
function message(zh: string, en: string): string { return locale().startsWith('zh') ? zh : en }

export function isHostOrigin(origin: string): boolean {
  return origin === 'tauri://localhost' || /^https?:\/\/tauri\.localhost$/.test(origin)
    || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)
}

export function onDocument(callback: (document: IndexDocument) => void): () => void {
  const receive = (event: MessageEvent) => {
    const data = event.data
    if (event.source !== window.parent || !isHostOrigin(event.origin) || !data || data.type !== 'file_view.open'
      || data.viewId !== 'index' || !Number.isSafeInteger(data.requestId)
      || typeof data.content !== 'string' || typeof data.uri !== 'string') return
    let ready = false
    try {
      const document = parseIndex(data.content, data.uri)
      if (document) { callback(document); ready = true }
    } catch { /* The host retains the source and restores Markdown on failure. */ }
    window.parent.postMessage({ type: ready ? 'file_view.ready' : 'file_view.fallback', requestId: data.requestId }, event.origin)
  }
  window.addEventListener('message', receive)
  return () => window.removeEventListener('message', receive)
}

/** Resolve Markdown URLs relative to the index, then check the Vault boundary. */
export function sourcePath(uri: string, target: string, root: string): string {
  const invalid = () => new Error(message('仅支持当前知识库内的文件链接。', 'Only files inside the current Vault are supported.'))
  if (!target || /^[a-z][\w+.-]*:/i.test(target) || /^[\/\\#?]/.test(target) || /[\u0000-\u001f\\]/.test(target)) throw invalid()
  const normalize = (path: string) => '/' + path.replace(/\\/g, '/').replace(/^\/+/, '')
  const prefix = normalize(root).replace(/\/+$/, '') + '/'
  const source = normalize(uri)
  if (!source.startsWith(prefix)) throw invalid()
  let resolved: string
  try {
    const base = new URL(`file://${source.split('/').map(encodeURIComponent).join('/')}`)
    const url = new URL(target, base)
    if (url.protocol !== 'file:' || url.host || url.search) throw invalid()
    resolved = decodeURIComponent(url.pathname)
  } catch { throw invalid() }
  if (!resolved.startsWith(prefix)) throw invalid()
  const path = resolved.slice(prefix.length)
  if (/[\u0000-\u001f\\]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw invalid()
  return path
}

async function resolvePath(uri: string, target: string): Promise<string> {
  const vault = await host().request('host.vault.info')
  if (typeof vault?.root !== 'string' || !vault.root) throw new Error(message('请先打开知识库。', 'Open a Vault first.'))
  return sourcePath(uri, target, vault.root)
}

export async function openLink(uri: string, target: string): Promise<void> {
  const path = await resolvePath(uri, target)
  await host().request('host.editor.open', { path })
}

/** Return an owned Blob URL; callers revoke it after replacement or unmount. */
export async function loadCover(uri: string, target: string): Promise<string> {
  const path = await resolvePath(uri, target)
  const mime = /\.png$/i.test(path) ? 'image/png' : /\.jpe?g$/i.test(path) ? 'image/jpeg'
    : /\.webp$/i.test(path) ? 'image/webp' : /\.gif$/i.test(path) ? 'image/gif' : null
  if (!mime) throw new Error(message('封面支持 PNG、JPEG、WebP 和 GIF。', 'Covers support PNG, JPEG, WebP and GIF.'))
  const result = await host().request('host.vault.read_bytes', { path })
  if (typeof result?.base64 !== 'string' || result.base64.length > 14 * 1024 * 1024) throw new Error(message('封面数据无效或过大。', 'Invalid or oversized cover data.'))
  const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0))
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}
