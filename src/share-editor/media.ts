import type { MediaResolver } from '@moraya/core'
import { Plugin } from 'prosemirror-state'
export type BundleFile = { path: string; dataUrl?: string }
/** Resolve only logical shared paths, with no filesystem or URL authority. */
export function sharedPath(href: string, currentPath: string): string | null {
  if (!href || /^[a-z][a-z\d+.-]*:|^[\\/]|[\\\0]/i.test(href)) return null
  let value: string
  try { value = decodeURIComponent(href.split(/[?#]/, 1)[0]) } catch { return null }
  if (!value || /^[a-z][a-z\d+.-]*:|^[\\/]|[\\\0]/i.test(value)) return null
  const parts = currentPath.split('/').slice(0, -1)
  for (const part of value.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop() }
    else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}
const rasterData = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i
export function bundleMediaResolver(files: readonly BundleFile[], currentPath: string): MediaResolver {
  const resolve = (src: string) => {
    const path = sharedPath(src, currentPath), value = files.find(file => file.path === path)?.dataUrl
    return value && rasterData.test(value) ? value : ''
  }
  return {
    async loadLocalImage(path, source) { return resolve(source?.src ?? path) },
    async loadLocalMedia() { return '' },
    async loadRemoteMedia() { return '' },
  }
}
/** CORE's general schema can assign remote src directly; override before DOM creation. */
export function shareMediaPlugin(resolver: MediaResolver, notify: (text: string) => void): Plugin {
  const blocked = () => notify('无法添加图片或附件，请在批注中描述')
  return new Plugin({ props: {
    nodeViews: {
      image(node) {
        const dom = document.createElement('span'), img = document.createElement('img')
        dom.className = 'image-node'; img.alt = node.attrs.alt || ''; dom.append(img)
        let alive = true
        void resolver.loadLocalImage(node.attrs.src).then(url => {
          if (!alive) return
          if (url) img.src = url
          else dom.textContent = `![${node.attrs.alt || ''}](${node.attrs.src})`
        })
        return { dom, destroy() { alive = false } }
      },
      html_inline(node) {
        const dom = document.createElement('span'); dom.dataset.type = 'html-inline'
        dom.dataset.value = node.attrs.value; dom.textContent = node.attrs.value
        return { dom }
      },
    },
    handleDOMEvents: {
      paste(view, event) {
        const data = event.clipboardData
        if (data?.files?.length || [...(data?.items ?? [])].some(item => item.kind === 'file')) {
          event.preventDefault(); blocked(); return true
        }
        if (/<(?:img|video|audio|source)\b/i.test(data?.getData('text/html') ?? '')) {
          event.preventDefault(); blocked()
          const text = data?.getData('text/plain'); if (text) view.dispatch(view.state.tr.insertText(text))
          return true
        }
        return false
      },
      drop(_view, event) {
        if (event.dataTransfer?.files.length) { event.preventDefault(); blocked(); return true }
        return false
      },
    },
  } })
}
