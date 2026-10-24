import type { EditorView } from 'prosemirror-view'
import { exists, readFile } from '@tauri-apps/plugin-fs'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { save } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { localResourceCandidates, type LocalResourceContext } from '../local-resource'
import { basename } from '../paths'
import { copyImageToClipboard } from '../copy-image'
import { showError } from '../dialogs'
import type { EditorActions } from './EditorContextMenu.svelte'

export interface RichResource {
  /** Original Markdown/HTML URL, never the resolver's temporary blob URL. */
  src: string
  image?: HTMLImageElement
}

export function findRichResource(target: EventTarget | null, view: EditorView): RichResource | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  if (!element || !view.dom.contains(element)) return null
  const media = element.closest('.image-node, .html-img-wrapper, .broken-image, [data-type="html-inline"], img, audio, video')
  if (media) {
    const wrapper = media.closest('.image-node, .html-img-wrapper, .broken-image, [data-type="html-inline"]') || media
    const image = wrapper instanceof HTMLImageElement ? wrapper : wrapper.querySelector('img') ?? undefined
    let src = ''
    try {
      const node = view.state.doc.nodeAt(view.posAtDOM(wrapper, 0))
      if (node?.type.name === 'image') src = node.attrs.src
    } catch { /* DOM media outside a ProseMirror node can still have a source. */ }
    const html = wrapper.getAttribute('data-value')
    if (!src && html) {
      const original = new DOMParser().parseFromString(html, 'text/html')
      src = original.querySelector('img, audio, video')?.getAttribute('src')
        || original.querySelector('source')?.getAttribute('src') || ''
    }
    if (!src) src = media.getAttribute('src') || media.querySelector('audio, video, source')?.getAttribute('src') || ''
    if (src) return { src, image }
  }
  // Wikilinks navigate notes; they are not downloadable resource links.
  if (element.closest('[data-wikilink]')) return null
  const link = element.closest('[data-url], a[href]')
  const src = link?.getAttribute('data-url') || link?.getAttribute('href')
  return src && !src.startsWith('#') && !/^(?:mailto|tel|javascript):/i.test(src) ? { src } : null
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/avif': 'avif', 'application/pdf': 'pdf',
  'text/plain': 'txt', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'video/mp4': 'mp4',
}

function resourceName(src: string): string {
  if (/^(?:data|blob):/i.test(src)) {
    const mime = /^data:([^;,]+)/i.exec(src)?.[1].toLowerCase()
    return `download.${mime && MIME_EXT[mime] || 'bin'}`
  }
  let path = src.split(/[?#]/, 1)[0]
  if (/^(?:https?:)?\/\//i.test(src)) {
    try { path = new URL(src.startsWith('//') ? `https:${src}` : src).pathname } catch { /* Keep the original filename. */ }
  }
  try { path = decodeURIComponent(path) } catch { /* Literal percent signs are valid filenames. */ }
  return path && !path.endsWith('/') ? basename(path) : 'download'
}

export function createResourceActions(resource: RichResource, context: LocalResourceContext): EditorActions {
  const src = resource.src.trim()
  const candidates = localResourceCandidates(src, context)
  const remote = /^(?:https?:)?\/\//i.test(src)
  const embedded = /^(?:data|blob):/i.test(src)

  async function readLocal(): Promise<Uint8Array> {
    let failure: unknown = new Error(`File not found: ${src}`)
    for (const path of candidates) {
      try { return await readFile(path) }
      catch (error) { failure = error }
    }
    throw failure
  }

  async function localPath(): Promise<string> {
    for (const path of candidates) {
      try { if (await exists(path)) return path }
      catch { /* Try the filesystem fallback when a vault candidate is inaccessible. */ }
    }
    throw new Error(`File not found: ${src}`)
  }

  function canRun(id: string): boolean {
    switch (id) {
      case 'copyFilePath': return candidates.length > 0
      case 'copyResourceLink': return !!src
      case 'saveResourceAs': return candidates.length > 0 || remote || embedded
      case 'copyImage': return !!resource.image
      default: return false
    }
  }

  return {
    canRun,
    async run(id) {
      if (!canRun(id)) return
      try {
        switch (id) {
          case 'copyResourceLink': await writeText(src); return
          case 'copyFilePath': await writeText(await localPath()); return
          case 'copyImage': await copyImageToClipboard(resource.image!); return
          case 'saveResourceAs': {
            const destination = await save({ defaultPath: resourceName(src) })
            if (!destination) return
            let bytes: Uint8Array
            if (candidates.length) bytes = await readLocal()
            else {
              const fetchResource = remote ? (await import('@tauri-apps/plugin-http')).fetch : fetch
              const response = await fetchResource(src.startsWith('//') ? `https:${src}` : src)
              if (!response.ok) throw new Error(`Download failed (${response.status}): ${src}`)
              bytes = new Uint8Array(await response.arrayBuffer())
            }
            let binary = ''
            for (let offset = 0; offset < bytes.length; offset += 8192) {
              binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
            }
            await invoke('write_file_binary', { path: destination, base64Data: btoa(binary) })
          }
        }
      } catch (error) {
        showError(String(error))
      }
    },
  }
}
